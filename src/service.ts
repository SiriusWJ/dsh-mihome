/**
 * Resident Mi Home service (host).
 *
 * Owns the device state and cache on the host side:
 *  - a background refresh loop keeps homes / rooms / devices / props in
 *    memory (near real-time, patched instantly after console controls);
 *  - the snapshot is persisted to disk so a cold start of the service
 *    already has the last-known state;
 *  - `/dsh-mihome/state` and the tools read the mirror instead of hitting
 *    the cloud per request, so the frontend renders instantly.
 *
 * Lifecycle: `start()` begins the loop, `dispose()` stops it; both belong
 * to the plugin fiber via ctx.effect.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Config } from './config'
import {
  type MiClient,
  type DeviceInfo,
  type HomeInfo,
  categoryOf,
  propsForCategory,
} from './mi'
import type { ChangeBuffer } from './tools'
import { DASHBOARD_META_KIND, type DashboardSnapshot, type DashboardDevice, type DashboardRoom } from './dashboard'

export interface ServiceStatus {
  /** 'idle' first milliseconds, then 'connected' | 'error' per last refresh. */
  status: 'idle' | 'connected' | 'error'
  refreshedAt: number | null
  lastError: string | null
}

interface PersistedCache {
  at: number
  homes: HomeInfo[]
  devices: DeviceInfo[]
  props: Record<string, Record<string, unknown>>
  status: ServiceStatus['status']
  lastError: string | null
}

export class MiHomeService {
  private homes: HomeInfo[] = []
  private devices: DeviceInfo[] = []
  private props: Map<string, Record<string, unknown>> = new Map()
  private status: ServiceStatus['status'] = 'idle'
  private lastError: string | null = null
  private refreshedAt: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private saving = false

  constructor(
    private readonly client: MiClient,
    private readonly config: Config,
    private readonly changes: ChangeBuffer,
    private readonly persistFile: string,
  ) {}

  /** Start the resident loop. Safe to call once; dispose() stops it. */
  start(): void {
    if (this.timer !== null) return
    void this.loadPersisted()
    void this.refresh()
    this.timer = setInterval(() => { void this.refresh() }, Math.max(5000, this.config.serviceRefreshMs))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Current service status (memory read, no network). */
  getStatus(): ServiceStatus {
    return { status: this.status, refreshedAt: this.refreshedAt, lastError: this.lastError }
  }

  /** Instant health from the mirror. */
  health(): { ok: boolean; account: string; region: string; homes: number; devices: number } {
    return {
      ok: this.status === 'connected',
      account: this.config.username || 'mi-account',
      region: this.config.region,
      homes: this.homes.length,
      devices: this.devices.length,
    }
  }

  /** Instant full snapshot from the mirror (no network). */
  snapshot(): DashboardSnapshot {
    const roomByDid = new Map<string, number>()
    for (const home of this.homes) {
      for (const room of home.rooms) {
        for (const did of room.dids ?? []) roomByDid.set(did, room.room_id)
      }
    }
    const devices: DashboardDevice[] = this.devices.map(d => ({
      did: d.did,
      name: d.name,
      model: d.model,
      online: d.online,
      category: categoryOf(d.model),
      props: this.props.get(d.did) ?? {},
      ...(roomByDid.has(d.did) ? { room_id: roomByDid.get(d.did) } : {}),
    }))
    const rooms: DashboardRoom[] = this.homes[0]?.rooms ?? []
    return {
      kind: DASHBOARD_META_KIND,
      generatedAt: new Date(this.refreshedAt ?? Date.now()).toISOString(),
      homes: this.homes.map(h => ({ home_id: h.home_id, name: h.name })),
      rooms,
      devices,
      events: this.changes.latest(8),
    }
  }

  /** Device list mirror for tools / approval policy (instant). */
  devicesMirror(): { homes: HomeInfo[]; devices: DeviceInfo[] } {
    return { homes: this.homes, devices: this.devices }
  }

  /** Patch one device's props in the mirror (console controls call this). */
  patchDeviceProps(did: string, props: Record<string, unknown>): void {
    const current = this.props.get(did) ?? {}
    this.props.set(did, { ...current, ...props })
  }

  /** Full refresh cycle: homes → devices → props. Failures keep stale data. */
  async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      const homes = await this.client.getHomes()
      const devices: DeviceInfo[] = []
      for (const home of homes) {
        devices.push(...await this.client.getDevices(home.home_id, home.owner_id))
      }
      // Props for the online, dashboard-limited subset; offline devices keep
      // their last-known props (or stay empty).
      const targets = devices
        .filter(d => d.online)
        .slice(0, Math.max(1, this.config.dashboardPropsLimit))
      const propsList = await Promise.allSettled(targets.map(d =>
        this.client.getProps(d.did, propsForCategory(categoryOf(d.model))),
      ))
      const nextProps = new Map<string, Record<string, unknown>>()
      targets.forEach((d, i) => {
        if (propsList[i]?.status === 'fulfilled') nextProps.set(d.did, propsList[i].value)
      })
      // Keep props of offline devices from the previous cycle.
      for (const d of devices) {
        if (d.online && !nextProps.has(d.did)) nextProps.set(d.did, this.props.get(d.did) ?? {})
        if (!d.online) nextProps.set(d.did, this.props.get(d.did) ?? {})
      }

      this.homes = homes
      this.devices = devices
      this.props = nextProps
      this.status = 'connected'
      this.lastError = null
      this.refreshedAt = Date.now()
      void this.persist()
    } catch (err) {
      this.status = 'error'
      this.lastError = err instanceof Error ? err.message : String(err)
    }
  }

  private async loadPersisted(): Promise<void> {
    try {
      const raw = await readFile(this.persistFile, 'utf8')
      const data = JSON.parse(raw) as PersistedCache
      if (!Array.isArray(data.devices)) return
      this.homes = data.homes ?? []
      this.devices = data.devices
      this.props = new Map(Object.entries(data.props ?? {}))
      this.status = data.status ?? 'idle'
      this.lastError = data.lastError ?? null
      this.refreshedAt = data.at ?? Date.now()
    } catch {
      // first run — no persisted cache
    }
  }

  private async persist(): Promise<void> {
    if (this.saving || this.disposed) return
    this.saving = true
    try {
      const payload: PersistedCache = {
        at: this.refreshedAt ?? Date.now(),
        homes: this.homes,
        devices: this.devices,
        props: Object.fromEntries(this.props),
        status: this.status,
        lastError: this.lastError,
      }
      await mkdir(dirname(this.persistFile), { recursive: true })
      await writeFile(this.persistFile, JSON.stringify(payload), 'utf8')
    } catch {
      // best-effort persistence
    } finally {
      this.saving = false
    }
  }
}

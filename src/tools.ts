import type { Context } from '@deepseek-ai/cordis'
import {
  defineTool,
  type GenericCallView,
  type GenericResultView,
  type JsonValue,
} from '@deepseek-ai/dsh-tools'
import type { Config } from './config'
import {
  type MiClient,
  type DeviceInfo,
  type HomeInfo,
  type ChangeEvent,
  categoryOf,
  propsForCategory,
} from './mi'
import { DASHBOARD_META_KIND, type DashboardSnapshot, type DashboardDevice, type DashboardRoom } from './dashboard'

/** Text content block helper for `output.render` / card content. */
function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

function truncate(value: string, max = 4000): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value
}

function fmtProp(value: unknown): string {
  if (value === 1 || value === '1' || value === 'on' || value === true) return 'on'
  if (value === 0 || value === '0' || value === 'off' || value === '' || value === false) return 'off'
  return String(value)
}

function normState(value: unknown): string {
  if (value === 1 || value === '1' || value === 'on' || value === true) return 'on'
  if (value === 0 || value === '0' || value === 'off' || value === false) return 'off'
  return String(value ?? '')
}

// ---------------------------------------------------------------------------
// Device list cache (shared between tools and the approval policy)
// ---------------------------------------------------------------------------

let deviceCache: { at: number; homes: HomeInfo[]; devices: DeviceInfo[] } | null = null

/** Load homes + every device, cached for `ttlMs` (default 60s). */
export async function cachedDevices(client: MiClient, ttlMs = 60_000): Promise<{ homes: HomeInfo[]; devices: DeviceInfo[] }> {
  if (deviceCache && Date.now() - deviceCache.at < ttlMs) return deviceCache
  const homes = await client.getHomes()
  const devices: DeviceInfo[] = []
  for (const home of homes) {
    devices.push(...await client.getDevices(home.home_id, home.owner_id))
  }
  deviceCache = { at: Date.now(), homes, devices }
  return deviceCache
}

export function invalidateDeviceCache(): void {
  deviceCache = null
}

function deviceById(devices: DeviceInfo[], did: string): DeviceInfo | undefined {
  return devices.find(d => d.did === did)
}

// ---------------------------------------------------------------------------
// Recent-change buffer (shared with the dashboard)
// ---------------------------------------------------------------------------

export class ChangeBuffer {
  private readonly items: ChangeEvent[] = []

  constructor(private readonly limit: number) {}

  push(entry: ChangeEvent): void {
    this.items.unshift(entry)
    if (this.items.length > this.limit) this.items.length = this.limit
  }

  latest(max = 8): ChangeEvent[] {
    return this.items.slice(0, max)
  }
}

// ---------------------------------------------------------------------------
// Dashboard snapshot builder (shared by the mi_dashboard tool and the
// /dsh-mihome/state web route feeding the full-screen console)
// ---------------------------------------------------------------------------

export async function buildDashboardSnapshot(
  client: MiClient,
  config: Config,
  changes: ChangeBuffer,
): Promise<DashboardSnapshot> {
  const { homes, devices } = await cachedDevices(client)
  const home = homes[0]
  const rooms: DashboardRoom[] = home?.rooms ?? []

  // Device → room mapping across all homes (roomlist.dids).
  const roomByDid = new Map<string, number>()
  for (const h of homes) {
    for (const room of h.rooms) {
      for (const did of room.dids ?? []) roomByDid.set(did, room.room_id)
    }
  }

  // Fetch props for up to `dashboardPropsLimit` devices, individually;
  // failures degrade to an empty props map (device offline, wrong model…).
  const limit = Math.min(Math.max(config.dashboardPropsLimit, 1), 100)
  const targets = devices.slice(0, limit)
  const propsList = await Promise.allSettled(targets.map(d =>
    client.getProps(d.did, propsForCategory(categoryOf(d.model))),
  ))
  const snapshotDevices: DashboardDevice[] = targets.map((d, i) => ({
    did: d.did,
    name: d.name,
    model: d.model,
    online: d.online,
    category: categoryOf(d.model),
    props: (propsList[i]?.status === 'fulfilled' ? propsList[i].value : {}) as Record<string, unknown>,
    ...(roomByDid.has(d.did) ? { room_id: roomByDid.get(d.did) } : {}),
  }))

  return {
    kind: DASHBOARD_META_KIND,
    generatedAt: new Date().toISOString(),
    homes: homes.map(h => ({ home_id: h.home_id, name: h.name })),
    rooms,
    devices: snapshotDevices,
    events: changes.latest(8),
  }
}

/** Turn a raw connection error into a friendly, actionable message. */
function friendlyConnError(err: unknown): string {
  const raw = err instanceof Error ? err.message.replace(/^dsh-mihome: /, '') : String(err)
  if (/未配置米家账号/.test(raw) || /MIHOME_USERNAME/.test(raw)) {
    return '尚未登录米家账号——打开 DSH 设置 → 米家登录，用米家 App 扫码即可；或配置 MIHOME_USERNAME / MIHOME_PASSWORD 环境变量。'
  }
  if (/登录失败/.test(raw)) {
    return `米家登录失败（${raw}）。如账号触发了风控验证，请改用设置页的扫码登录。`
  }
  return `无法连接米家云端（${raw}）。请检查网络后重试，或到 设置 → 米家登录 重新登录。`
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(
  ctx: Context,
  client: MiClient,
  config: Config,
  changes: ChangeBuffer,
): void {
  ctx.tools.register(defineTool({
    name: 'mi_health',
    description:
      'Check the Mi Home connection and return account/region info plus ' +
      'the number of homes and devices. Call this first to verify the plugin ' +
      'is configured (QR login in Settings → 米家登录, or cloud credentials).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          account: { type: 'string' },
          region: { type: 'string' },
          homes: { type: 'number' },
          devices: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const v = value as { ok?: boolean; account?: string; region?: string; homes?: number; devices?: number }
        return text(
          v.ok
            ? `🍃 米家已连接：${v.account}（区域 ${v.region ?? 'unknown'} · ${v.homes ?? 0} 个家庭 · ${v.devices ?? 0} 台设备）`
            : '🍃 米家尚未连接——打开 DSH 设置 → 米家登录，用米家 App 扫码登录（推荐）；或配置 MIHOME_USERNAME / MIHOME_PASSWORD 环境变量后重启。',
        )
      },
    },
    async execute() {
      const health = await client.health()
      return {
        ok: health.ok,
        account: health.account,
        region: health.region,
        homes: health.homes,
        devices: health.devices,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mi_list_homes',
    description:
      'List Mi Home homes (家庭) and their rooms (房间). Returns the home_id ' +
      'and owner_id needed by mi_list_devices.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          homes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                home_id: { type: 'number', required: true },
                name: { type: 'string', required: true },
                owner_id: { type: 'number', required: true },
                rooms: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      room_id: { type: 'number', required: true },
                      name: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const homes = value.homes as Array<{ home_id: number; name: string; rooms: Array<{ name: string }> }>
        return text(truncate(homes.length
          ? homes.map(h => `- ${h.home_id}: ${h.name} (${h.rooms.map(r => r.name).join('、') || '无房间'})`).join('\n')
          : '(无家庭)'))
      },
    },
    async execute() {
      const homes = await client.getHomes()
      return {
        count: homes.length,
        homes: homes.map(h => ({
          home_id: h.home_id,
          name: h.name,
          owner_id: h.owner_id,
          rooms: h.rooms.map(r => ({ room_id: r.room_id, name: r.name })),
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mi_list_devices',
    description:
      'List Mi Home devices (across all homes), optionally filtered by text ' +
      'query on name/model/did and by category (light, outlet, sensor, climate, ' +
      'media, cleaning, camera, lock, fan, meter). Returns compact summaries.',
    parameters: {
      query: { type: 'string', description: 'Text search over device name, model or did' },
      category: { type: 'string', description: 'Category filter: light | outlet | sensor | climate | media | cleaning | camera | lock | fan | meter' },
      limit: { type: 'number', description: 'Maximum devices to return' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'number' },
          devices: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                did: { type: 'string', required: true },
                name: { type: 'string', required: true },
                model: { type: 'string', required: true },
                online: { type: 'boolean', required: true },
                category: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const devices = value.devices as Array<{ name: string; model: string; online: boolean; category: string }>
        return text(truncate(devices.length
          ? devices.map(d => `- ${d.name} (${d.model}, ${d.category}, ${d.online ? '在线' : '离线'})`).join('\n')
          : '(无设备)'))
      },
    },
    async execute(args) {
      const { devices } = await cachedDevices(client)
      const query = (args.query ?? '').toLowerCase()
      const limit = Math.min(Math.max(args.limit ?? 100, 1), 300)
      const filtered = devices
        .filter(d => !args.category || categoryOf(d.model) === args.category)
        .filter(d => !query ||
          d.name.toLowerCase().includes(query) ||
          d.model.toLowerCase().includes(query) ||
          d.did.toLowerCase().includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, limit)
        .map(d => ({
          did: d.did,
          name: d.name,
          model: d.model,
          online: d.online,
          category: categoryOf(d.model),
        }))
      return { count: filtered.length, devices: filtered }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mi_get_state',
    description:
      'Get one Mi Home device: online status, category, model, and common ' +
      'properties (power, brightness, temperature, humidity, battery, …) ' +
      'via miIO get_prop. Use mi_list_devices to find the did first.',
    parameters: {
      deviceId: { type: 'string', required: true, description: 'Device did (see mi_list_devices)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          did: { type: 'string', required: true },
          name: { type: 'string', required: true },
          model: { type: 'string', required: true },
          online: { type: 'boolean', required: true },
          category: { type: 'string', required: true },
          props: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const v = value as { name?: string; model?: string; online?: boolean; category?: string; props?: Record<string, unknown> }
        const lines = Object.entries(v.props ?? {}).map(([k, val]) => `  ${k}: ${fmtProp(val)}`)
        return text(truncate(`- ${v.name} (${v.model ?? 'unknown'}, ${v.category ?? 'other'}, ${v.online ? '在线' : '离线'})\n${lines.join('\n') || '  (无属性)'}`))
      },
    },
    async execute(args) {
      const { devices } = await cachedDevices(client)
      const device = deviceById(devices, args.deviceId)
      if (!device) throw new Error(`dsh-mihome: 未找到设备 ${args.deviceId}（先调用 mi_list_devices）`)
      const category = categoryOf(device.model)
      const props = await client.getProps(device.did, propsForCategory(category))
      return {
        did: device.did,
        name: device.name,
        model: device.model,
        online: device.online,
        category,
        props: props as JsonValue,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mi_turn',
    description:
      'Turn a Mi Home device on or off (set_power). Simple and the most ' +
      'common control action. Requires human approval (configurable). ' +
      'Use mi_control for anything richer (brightness, temperature, mode…).',
    parameters: {
      deviceId: { type: 'string', required: true, description: 'Device did (see mi_list_devices)' },
      on: { type: 'boolean', required: true, description: 'true = turn on, false = turn off' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          deviceId: { type: 'string', required: true },
          name: { type: 'string' },
          on: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => text(`✅ ${value.name ?? value.deviceId} 已${value.on ? '开启' : '关闭'}`),
    },
    presentCall(args): GenericCallView | undefined {
      const a = args as { deviceId?: string }
      if (!a.deviceId) return undefined
      return { card: 'generic', title: `set_power @ ${a.deviceId}`, kind: 'execute' }
    },
    presentResult(_args, result): GenericResultView | undefined {
      return {
        card: 'generic',
        content: result.isError
          ? result.content
          : [{ type: 'text', text: '✅ 设备已控制' }],
      }
    },
    async execute(args) {
      const { devices } = await cachedDevices(client)
      const device = deviceById(devices, args.deviceId)
      if (!device) throw new Error(`dsh-mihome: 未找到设备 ${args.deviceId}`)
      await client.rawCommand(device.did, 'set_power', [args.on ? 'on' : 'off'])
      changes.push({
        did: device.did,
        name: device.name,
        changes: [['power', null, args.on ? 'on' : 'off']],
        time: new Date().toISOString(),
      })
      return { ok: true, deviceId: device.did, name: device.name, on: args.on }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mi_control',
    description:
      'Call a Mi Home device method via miIO raw_command: set_power, set_bright, ' +
      'set_properties (MIoT), … with the raw params array. Powerful and requires ' +
      'human approval (configurable). Prefer mi_turn for simple on/off.',
    parameters: {
      deviceId: { type: 'string', required: true, description: 'Device did (see mi_list_devices)' },
      method: { type: 'string', required: true, description: 'miIO method, e.g. set_bright, set_power, set_properties' },
      params: {
        type: 'json',
        description: 'Method params. Array for miIO methods ([60] for set_bright), or object for property maps',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          deviceId: { type: 'string', required: true },
          name: { type: 'string' },
          method: { type: 'string', required: true },
          result: { type: 'json' },
        },
      },
      render: (_args, value) => {
        const v = value as { name?: string; method?: string; result?: unknown }
        return text(`✅ ${v.name ?? value.deviceId}: ${v.method} → ${JSON.stringify(v.result ?? 'ok')}`)
      },
    },
    presentCall(args): GenericCallView | undefined {
      const a = args as { deviceId?: string; method?: string }
      if (!a.deviceId || !a.method) return undefined
      return { card: 'generic', title: `${a.method} @ ${a.deviceId}`, kind: 'execute' }
    },
    presentResult(_args, result): GenericResultView | undefined {
      return {
        card: 'generic',
        content: result.isError
          ? result.content
          : [{ type: 'text', text: '✅ 设备已控制' }],
      }
    },
    async execute(args) {
      const { devices } = await cachedDevices(client)
      const device = deviceById(devices, args.deviceId)
      if (!device) throw new Error(`dsh-mihome: 未找到设备 ${args.deviceId}`)
      const params = Array.isArray(args.params) ? args.params as unknown[]
        : (args.params && typeof args.params === 'object'
            ? [args.params as JsonValue]
            : [])
      const result = await client.rawCommand(device.did, args.method, params)
      changes.push({
        did: device.did,
        name: device.name,
        changes: [[args.method, null, JSON.stringify(params)]],
        time: new Date().toISOString(),
      })
      return {
        ok: true,
        deviceId: device.did,
        name: device.name,
        method: args.method,
        result: result as JsonValue,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mi_wait_for_state',
    description:
      'Poll one device property until it matches (or stops matching) a target ' +
      'state, up to a timeout. Real monitoring: wait for the washer to finish, ' +
      'wait for the air conditioner to reach 24°, wait until a door lock opens. ' +
      'Returns matched=false on timeout (with the last state) — not an error.',
    parameters: {
      deviceId: { type: 'string', required: true, description: 'Device did to watch' },
      prop: { type: 'string', description: 'Property to poll, default "power"' },
      targetState: { type: 'string', description: 'Wait until the property EQUALS this (omit to use notTargetState)' },
      notTargetState: { type: 'string', description: 'Wait until the property no longer equals this' },
      timeoutMs: { type: 'number', description: 'Max wait in ms (default 120000, max 600000)' },
      intervalMs: { type: 'number', description: 'Poll interval in ms (default 1000, min 300)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          matched: { type: 'boolean', required: true },
          device_id: { type: 'string', required: true },
          prop: { type: 'string', required: true },
          state: { type: 'string', required: true },
          waitedMs: { type: 'number', required: true },
        },
      },
      render: (_args, value) => text(
        value.matched
          ? `${value.device_id}.${value.prop} reached "${value.state}" after ${value.waitedMs}ms`
          : `${value.device_id}.${value.prop} did not match within ${value.waitedMs}ms (last: "${value.state}")`,
      ),
    },
    async execute(args, exec) {
      const deviceId = args.deviceId
      const prop = args.prop ?? 'power'
      const timeoutMs = Math.min(Math.max(args.timeoutMs ?? 120_000, 500), 600_000)
      const intervalMs = Math.min(Math.max(args.intervalMs ?? 1000, 300), 30_000)
      const start = Date.now()
      let last = ''
      while (Date.now() - start < timeoutMs) {
        if (exec.signal.aborted) throw new Error('cancelled')
        const props = await client.getProps(deviceId, [prop])
        last = normState(props[prop])
        const hit = args.targetState !== undefined
          ? last === args.targetState
          : args.notTargetState !== undefined
            ? last !== args.notTargetState
            : true
        if (hit) {
          return { matched: true, device_id: deviceId, prop, state: last, waitedMs: Date.now() - start }
        }
        await sleep(intervalMs, exec.signal)
      }
      return { matched: false, device_id: deviceId, prop, state: last, waitedMs: Date.now() - start }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'mi_dashboard',
    description:
      'Build a full Mi Home dashboard snapshot: every device (grouped by ' +
      'category with online status and common props), rooms, and recent ' +
      'changes. The result renders as a home dashboard card in the Web UI.',
    parameters: {},
    output: {
      // The canonical value IS the durable snapshot; it is also projected onto
      // `tool/result` meta (presentationMeta) so the browser dashboard node can
      // render it on live streaming AND on session-log replay.
      schema: { type: 'json' },
      render: (_args, value) => {
        const s = value as unknown as DashboardSnapshot
        if (s.error) return text(`🍃 米家未连接：${s.error}`)
        const online = s.devices.filter(d => d.online).length
        return text(
          `🍃 米家仪表盘：${s.devices.length} 台设备（${online} 在线）· ${s.rooms.length} 个房间 · ${s.events.length} 条最近变化`,
        )
      },
      presentationMeta: (_args, value) => value as JsonValue,
    },
    presentResult(_args, result): GenericResultView | undefined {
      return {
        card: 'generic',
        content: result.isError
          ? result.content
          : [{ type: 'text', text: '🏠 米家仪表盘已就绪' }],
      }
    },
    async execute() {
      let snapshot: DashboardSnapshot
      try {
        snapshot = await buildDashboardSnapshot(client, config, changes)
      } catch (err) {
        // Not connected: hand the client enough to render a friendly offline
        // state instead of a raw tool error.
        snapshot = {
          kind: DASHBOARD_META_KIND,
          generatedAt: new Date().toISOString(),
          homes: [],
          rooms: [],
          devices: [],
          events: [],
          error: friendlyConnError(err),
        }
      }
      return snapshot as unknown as JsonValue
    },
  }))
}

/** Resolve after `ms`, abortable via the execution signal. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('cancelled'))
    }, { once: true })
  })
}

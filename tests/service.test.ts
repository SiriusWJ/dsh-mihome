import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MiHomeService } from '../src/service'
import { ChangeBuffer } from '../src/tools'
import type { MiClient, DeviceInfo, HomeInfo } from '../src/mi'

class FakeClient implements MiClient {
  homes: HomeInfo[] = [{
    home_id: 1,
    name: '测试之家',
    owner_id: 9,
    rooms: [{ room_id: 10, name: '客厅', dids: ['d1'] }],
  }]
  devices: DeviceInfo[] = [
    { did: 'd1', name: '客厅灯', model: 'yeelink.light.lamp1', online: true },
    { did: 'd2', name: '温度计', model: 'lumi.sensor_ht.v1', online: true },
    { did: 'd3', name: '离线插座', model: 'zimi.plug.v1', online: false },
  ]

  async health() {
    return { ok: true, account: 'test', region: 'cn', homes: 1, devices: 3 }
  }

  async getHomes(): Promise<HomeInfo[]> {
    return this.homes
  }

  async getDevices(): Promise<DeviceInfo[]> {
    return this.devices
  }

  async rawCommand(_did: string, _method: string, _params: unknown[]): Promise<unknown> {
    return 'ok'
  }

  async getProps(did: string): Promise<Record<string, unknown>> {
    const table: Record<string, Record<string, unknown>> = {
      d1: { power: 1, brightness: 60 },
      d2: { temperature: 22.5, humidity: 48 },
      d3: {},
    }
    return table[did] ?? {}
  }
}

describe('MiHomeService', () => {
  let dir: string | null = null

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  it('mirrors homes/devices/props after refresh and serves instant snapshots', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mihome-svc-'))
    const client = new FakeClient()
    const service = new MiHomeService(
      client,
      {
        region: 'cn', username: '', usernameEnv: 'A', password: '', passwordEnv: 'B',
        timeoutMs: 5000, requireApproval: true, allowedCategories: [],
        dashboardPropsLimit: 10, serviceRefreshMs: 60000, recentBufferSize: 20,
      },
      new ChangeBuffer(20),
      join(dir, 'device-cache.json'),
    )

    expect(service.getStatus().status).toBe('idle')

    await service.refresh()
    expect(service.getStatus().status).toBe('connected')

    const snap = service.snapshot()
    expect(snap.devices.length).toBe(3)
    const light = snap.devices.find(d => d.did === 'd1')
    expect(light?.props.power).toBe(1)
    expect(light?.room_id).toBe(10) // roomlist.dids mapping
    expect(snap.kind).toBe('mihome-dashboard')

    // Health + mirror reads are instant memory calls.
    expect(service.health().devices).toBe(3)
    expect(service.devicesMirror().devices.length).toBe(3)

    await service.dispose()
  })

  it('keeps stale data on refresh failure', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mihome-svc-'))
    const client = new FakeClient()
    const service = new MiHomeService(
      client,
      {
        region: 'cn', username: '', usernameEnv: 'A', password: '', passwordEnv: 'B',
        timeoutMs: 5000, requireApproval: true, allowedCategories: [],
        dashboardPropsLimit: 10, serviceRefreshMs: 60000, recentBufferSize: 20,
      },
      new ChangeBuffer(20),
      join(dir, 'device-cache.json'),
    )
    await service.refresh()
    const before = service.snapshot()

    client.getHomes = async () => { throw new Error('cloud down') }
    await service.refresh()

    expect(service.getStatus().status).toBe('error')
    const after = service.snapshot()
    expect(after.devices.length).toBe(before.devices.length) // stale data retained
    await service.dispose()
  })

  it('patchDeviceProps updates the mirror immediately', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-mihome-svc-'))
    const service = new MiHomeService(
      new FakeClient(),
      {
        region: 'cn', username: '', usernameEnv: 'A', password: '', passwordEnv: 'B',
        timeoutMs: 5000, requireApproval: true, allowedCategories: [],
        dashboardPropsLimit: 10, serviceRefreshMs: 60000, recentBufferSize: 20,
      },
      new ChangeBuffer(20),
      join(dir, 'device-cache.json'),
    )
    await service.refresh()
    service.patchDeviceProps('d1', { power: 0 })
    expect(service.snapshot().devices.find(d => d.did === 'd1')?.props.power).toBe(0)
    await service.dispose()
  })
})

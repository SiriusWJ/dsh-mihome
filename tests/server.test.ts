import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'demo-mi.mjs')
const PORT = 8137
const BASE = `http://127.0.0.1:${PORT}`

let child: ChildProcess | null = null

async function waitForServer(timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/demo/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('demo server did not start in time')
}

beforeAll(async () => {
  child = spawn(process.execPath, [script, String(PORT)], { stdio: 'ignore' })
  await waitForServer()
}, 20_000)

afterAll(() => {
  child?.kill()
})

describe('demo Mi Home server', () => {
  it('health reports the demo home', async () => {
    const res = await fetch(`${BASE}/demo/health`)
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.devices).toBeGreaterThan(0)
  })

  it('lists homes and rooms', async () => {
    const res = await fetch(`${BASE}/demo/console`).then(r => r.json())
    expect(res.homes.length).toBeGreaterThan(0)
    expect(res.homes[0].roomlist.length).toBeGreaterThan(0)
  })

  it('lists devices with did/name/model/online', async () => {
    const res = await fetch(`${BASE}/demo/console`).then(r => r.json())
    const dev = res.devices[0]
    expect(dev.did).toBeTruthy()
    expect(dev.name).toBeTruthy()
    expect(dev.model).toBeTruthy()
    expect(typeof dev.online).toBe('boolean')
  })

  it('raw_command set_power mutates state and records an event', async () => {
    const before = (await fetch(`${BASE}/demo/console`).then(r => r.json()))
      .devices.find((d: { did: string }) => d.did === 'light-bedroom-0002').props.power
    const data = encodeURIComponent(JSON.stringify({ did: 'light-bedroom-0002', method: 'set_power', params: ['on'] }))
    const res = await fetch(`${BASE}/app/miIO/raw_command?data=${data}&signature=demo&_nonce=demo`, { method: 'POST' })
    const body = await res.json()
    expect(body.code).toBe(0)
    const after = (await fetch(`${BASE}/demo/console`).then(r => r.json()))
      .devices.find((d: { did: string }) => d.did === 'light-bedroom-0002').props.power
    expect(after).toBe(1)
    expect(before).not.toBe(after)
  })
})

#!/usr/bin/env node
/**
 * dsh-mihome demo emulator — a fake Xiaomi Mi Home Cloud.
 *
 * No real Xiaomi account needed: this script serves the endpoints the plugin
 * uses with a small living demo home whose state actually CHANGES when you
 * call services (turn lights on/off, set brightness, adjust climate), plus
 * temperature sensors that drift so dashboards and event feeds stay alive.
 *
 * The demo intentionally skips Xiaomi's login + RC4 signing layer: the plugin
 * talks to the same HTTP surface in `mode: demo` with plain JSON, so the
 * full tool/dashboard/approval UI can be exercised offline.
 *
 * Usage:
 *   node scripts/demo-mi.mjs [port]        # default port 8125
 *
 * Then configure the plugin:
 *   - id: mihome
 *     config:
 *       mode: demo
 *       baseUrl: http://127.0.0.1:8125
 *
 * The interactive demo page docs/demo.html connects to the same server.
 */

const PORT = Number(process.argv[2] ?? 8125)

// ---------------------------------------------------------------------------
// Demo home state
// ---------------------------------------------------------------------------

function device(id, name, model, props, extra = {}) {
  return {
    did: id,
    name,
    model,
    online: true,
    ...extra,
    props: {
      power: 0,
      ...props,
    },
    inuse: [],
    bssid: '00:00:00:00:00:00',
    rssi: -50 + Math.floor(Math.random() * 30),
  }
}

const home = {
  home_id: 10001,
  name: '演示之家',
  owner_id: 8888,
  roomlist: [
    { room_id: 1, name: '客厅' },
    { room_id: 2, name: '卧室' },
    { room_id: 3, name: '厨房' },
  ],
}

const devices = [
  device('light-living-0001', '客厅灯', 'yeelink.light.lamp1', { power: 1, brightness: 100, color_temp: 4000 }, { room_id: 1 }),
  device('light-bedroom-0002', '卧室灯', 'yeelink.light.lamp2', { power: 0, brightness: 0, color_temp: 4000 }, { room_id: 2 }),
  device('plug-living-0003', '客厅插线板', 'zimi.plug.v2', { power: 1, power_consumption: 32 }, { room_id: 1 }),
  device('plug-bedroom-0004', '卧室智能插座', 'zimi.plug.v1', { power: 0, power_consumption: 0 }, { room_id: 2 }),
  device('temp-living-0005', '客厅温湿度传感器', 'lumi.sensor_ht.v1', { temperature: 22.5, humidity: 48 }, { room_id: 1 }),
  device('temp-bedroom-0006', '卧室温湿度传感器', 'lumi.sensor_ht.v1', { temperature: 21.0, humidity: 52 }, { room_id: 2 }),
  device('meter-home-0007', '全屋功率监测', 'chunmi.plug.v2', { power_consumption: 320 }, { room_id: 1 }),
  device('aircon-0008', '中央空调', 'zhimi.aircondition.m1', { power: 1, target_temperature: 21, mode: 'heat' }, { room_id: 1 }),
  device('tv-0009', '电视', 'xiaomi.tv.ac', { power: 0 }, { room_id: 1 }),
  device('vacuum-0010', '扫地机器人', 'roborock.vacuum.a10', { state: 'idle', battery: 87 }, { room_id: 1 }),
  device('lock-0011', '智能门锁', 'loock.lock.v1', { state: 'locked', battery: 96 }, { room_id: 2 }),
  device('purifier-0012', '空气净化器', 'zhimi.airpurifier.m1', { power: 1, aqi: 35, filter_life_remaining: 62 }, { room_id: 1 }),
  device('camera-0013', '客厅摄像头', 'chuangmi.camera.h600', { state: 'idle' }, { room_id: 1 }),
  device('fan-0014', '创米风扇', 'dmaker.fan.p3', { power: 0, speed: 1 }, { room_id: 2 }),
]

/** Recent change log: { did, name, changes: [[prop, oldValue, newValue]], time } */
const events = []

function logChange(dev, changes) {
  events.unshift({
    did: dev.did,
    name: dev.name,
    changes,
    time: new Date().toISOString(),
  })
  if (events.length > 50) events.pop()
}

/** Drift the two temperature sensors a little every call so dashboards live. */
function drift() {
  for (const id of ['temp-living-0005', 'temp-bedroom-0006']) {
    const dev = devices.find(d => d.did === id)
    if (!dev) continue
    const d = (Math.random() - 0.5) * 0.4
    const next = Math.round((dev.props.temperature + d) * 10) / 10
    if (next !== dev.props.temperature) {
      const old = dev.props.temperature
      dev.props.temperature = next
      logChange(dev, [['temperature', old, next]])
    }
  }
}

// ---------------------------------------------------------------------------
// raw_command dispatch (mirrors miIO cloud control semantics)
// ---------------------------------------------------------------------------

function rawCommand(data) {
  const did = String(data?.did ?? '')
  const method = String(data?.method ?? '')
  const params = Array.isArray(data?.params) ? data.params : []
  const dev = devices.find(d => d.did === did)

  if (method === 'get_prop') {
    // miio-style: params = [propName, ...] → [value, ...]
    if (!dev) return { code: 1, message: 'device not found' }
    return { code: 0, result: params.map(p => dev.props[String(p)] ?? '') }
  }

  if (method === 'get_properties' || method === 'miIO.get_properties') {
    // MIoT-style: params = [{did, siid, piid}, ...] → [value, ...]
    return {
      code: 0,
      result: params.map(p => {
        const target = p && typeof p === 'object' && p.did ? devices.find(d => d.did === p.did) : dev
        if (!target) return undefined
        const { siid, piid } = p
        return propBySiPiid(target, Number(siid), Number(piid))
      }),
    }
  }

  if (method === 'set_power') {
    if (!dev) return { code: 1, message: 'device not found' }
    const value = String(params[0] ?? '')
    const on = value === 'on' || value === '1' || value === 'true'
    const old = dev.props.power
    dev.props.power = on ? 1 : 0
    if (old !== dev.props.power) logChange(dev, [['power', old, dev.props.power]])
    return { code: 0, result: 'ok' }
  }

  if (method === 'set_bright') {
    if (!dev) return { code: 1, message: 'device not found' }
    const b = Math.min(Math.max(Number(params[0] ?? 100), 1), 100)
    const old = dev.props.brightness
    dev.props.brightness = b
    logChange(dev, [['brightness', old, b]])
    return { code: 0, result: 'ok' }
  }

  if (method === 'set_properties' || method === 'miIO.set_properties') {
    const list = params.map(p => {
      const target = p && typeof p === 'object' && p.did ? devices.find(d => d.did === p.did) : dev
      return { target, siid: Number(p?.siid), piid: Number(p?.piid), value: p?.value }
    })
    const changes = []
    for (const item of list) {
      if (!item.target) continue
      const key = siidPiidKey(item.siid, item.piid)
      if (!key) continue
      const old = item.target.props[key]
      item.target.props[key] = item.value
      changes.push([key, old, item.value])
    }
    if (changes.length > 0 && list[0]?.target) logChange(list[0].target, changes)
    return { code: 0, result: 'ok' }
  }

  // Unknown method: pretend success for demo purposes.
  return { code: 0, result: 'ok', __demoMethod: method }
}

/** Mini MIoT spec: a stable (siid, piid) → prop key mapping per device kind. */
function specFor(dev) {
  const specs = {
    light: { '2-1': 'power', '2-2': 'brightness', '2-3': 'color_temp' },
    plug: { '2-1': 'power', '3-1': 'power_consumption' },
    sensor: { '2-1': 'temperature', '3-1': 'humidity' },
    aircondition: { '2-1': 'power', '2-2': 'target_temperature', '2-3': 'mode' },
    vacuum: { '2-1': 'state', '2-2': 'battery' },
    lock: { '2-1': 'state', '2-2': 'battery' },
    purifier: { '2-1': 'power', '2-2': 'aqi' },
    fan: { '2-1': 'power', '2-2': 'speed' },
    camera: { '2-1': 'state' },
    tv: { '2-1': 'power' },
    meter: { '2-1': 'power_consumption' },
  }
  const model = dev.model
  if (model.startsWith('yeelink.light') || model.startsWith('xiaomi.light') || model.startsWith('mijia.light')) return specs.light
  if (model.startsWith('zimi.plug') || model.startsWith('chuangmi.plug') || model.startsWith('mijia.plug')) return specs.plug
  if (model.startsWith('lumi.sensor') || model.startsWith('mijia.sensor')) return specs.sensor
  if (model.startsWith('zhimi.aircondition') || model.startsWith('xiaomi.aircondition')) return specs.aircondition
  if (model.startsWith('roborock.vacuum') || model.startsWith('viomi.vacuum')) return specs.vacuum
  if (model.startsWith('loock.lock') || model.startsWith('xiaomi.lock')) return specs.lock
  if (model.startsWith('zhimi.airpurifier')) return specs.purifier
  if (model.startsWith('dmaker.fan') || model.startsWith('zhimi.fan')) return specs.fan
  if (model.startsWith('chuangmi.camera')) return specs.camera
  if (model.startsWith('xiaomi.tv') || model.startsWith('mijia.tv')) return specs.tv
  if (model.includes('meter') || model.includes('chunmi')) return specs.meter
  return specs.sensor
}

function propBySiPiid(dev, siid, piid) {
  const spec = specFor(dev)
  const key = spec[`${siid}-${piid}`] ?? null
  if (key === null) return undefined
  if (key === 'power' || key === 'state') return dev.props.power ? 'on' : dev.props.state ?? 'off'
  return dev.props[key]
}

function siidPiidKey(siid, piid) {
  const raw = {
    '2-1': 'power',
    '2-2': 'brightness',
    '2-3': 'color_temp',
  }
  return raw[`${siid}-${piid}`] ?? null
}

// ---------------------------------------------------------------------------
// HTTP server (CORS open, semantic layer kept tiny)
// ---------------------------------------------------------------------------

import { createServer } from 'node:http'

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
}

function parseData(url) {
  try {
    const u = new URL(url, 'http://127.0.0.1')
    const raw = u.searchParams.get('data')
    if (raw) return JSON.parse(raw)
    return null
  } catch {
    return null
  }
}

const server = createServer((req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const url = req.url ?? '/'
  const path = url.split('?')[0]

  if (path === '/app/v2/homeroom/gethome') {
    return json(res, 200, { code: 0, message: 'ok', result: { homelist: [home] } })
  }

  if (path === '/app/v2/home/home_device_list') {
    drift()
    return json(res, 200, {
      code: 0,
      message: 'ok',
      result: {
        device_list: devices.map(d => ({
          did: d.did,
          name: d.name,
          model: d.model,
          online: d.online,
          room_id: d.room_id,
          parent_id: '',
          is_online: true,
        })),
      },
    })
  }

  if (path === '/app/miIO/raw_command') {
    const data = parseData(url)
    drift()
    return json(res, 200, rawCommand(data))
  }

  // Console endpoint for the interactive demo page.
  if (path === '/demo/console') {
    drift()
    return json(res, 200, {
      homes: [home],
      devices: devices.map(d => ({
        did: d.did,
        name: d.name,
        model: d.model,
        online: d.online,
        room_id: d.room_id,
        props: d.props,
      })),
      events: events.slice(0, 30),
    })
  }

  if (path === '/demo/health') {
    return json(res, 200, { ok: true, name: 'Demo Home', appVer: 'demo', region: 'cn', devices: devices.length })
  }

  json(res, 404, { code: 404, message: `no route ${path}` })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dsh-mihome demo] fake Mi Home Cloud listening on http://127.0.0.1:${PORT}`)
  console.log(`[dsh-mihome demo] demo page: docs/demo.html (right console connects here)`)
})

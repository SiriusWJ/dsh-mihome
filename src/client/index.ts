/**
 * Browser half of dsh-mihome:
 *  - renders the Mi Home dashboard card into the conversation when
 *    `mi_dashboard` runs (keyed chat node from tool/result meta);
 *  - registers a "🏠 米家" conversation view (id `mihome`) in the session's
 *    top view ring: one click replaces the chat area with the full-screen
 *    Mi Home console — sidebar, header and title stay in place. Data comes
 *    from the same-origin read-only endpoint /dsh-mihome/state.
 * Loaded by the Web Client's module loader from the package's `dsh.client`
 * manifest.
 */
import { createElement, useEffect, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { dashboardDefinition, type DashboardChatData } from './dashboard'
import type { DashboardDevice, DashboardSnapshot } from '../dashboard'

/** Required services: the conversation-node registry and the slots service. */
export const inject = ['conversationEvents', 'slots']

// ---------------------------------------------------------------------------
// Theme (matches the DSH Web dark surface)
// ---------------------------------------------------------------------------
const COLORS = {
  bg: '#12151a',
  card: '#16191e',
  border: '#262b33',
  text: '#e6e9ee',
  muted: '#8b93a1',
  on: '#6ee7b7',
  off: '#4a5160',
  accent: '#4d7cfe',
  warn: '#fbbf24',
  danger: '#f87171',
}

// ---------------------------------------------------------------------------
// Light neumorphic palette for the Mi Home console (soft dual shadows and a
// pink-violet accent, matching the reference soft-UI style). The in-chat
// dashboard card and settings stay on the dark DSH surface (COLORS above).
// ---------------------------------------------------------------------------
const NEO = {
  bg: '#e9ecf3',
  card: '#eef1f6',
  text: '#3d4356',
  muted: '#8f96a8',
  on: '#21c48b',
  off: '#b8bfce',
  danger: '#ec5f7b',
  accent: '#e8559b',
  accent2: '#8f6bff',
  warn: '#c07a18',
  line: '#d7dbe6',
}

/** Neumorphic dual shadow: light from top-left, dark from bottom-right. */
function neoShadow(px: number): string {
  return `${px}px ${px}px ${px * 2}px rgba(163, 170, 190, 0.42), -${px}px -${px}px ${px * 2}px rgba(255, 255, 255, 0.95)`
}

/** Pink → violet signature gradient. */
const NEO_GRADIENT = 'linear-gradient(135deg, #ff7ab8 0%, #a06bff 100%)'

function categoryOf(device: DashboardDevice): string {
  return device.category ?? 'other'
}

function iconFor(device: DashboardDevice): string {
  const cat = categoryOf(device)
  const model = device.model ?? ''
  if (cat === 'light') return '💡'
  if (cat === 'outlet') return '🔌'
  if (cat === 'climate') return '❄️'
  if (cat === 'media') return '📺'
  if (cat === 'cleaning') {
    if (model.includes('vacuum') || model.includes('scishare')) return '🧹'
    if (model.includes('purifier')) return '♻️'
    if (model.includes('humidifier')) return '💦'
    return '🧺'
  }
  if (cat === 'camera') return '📷'
  if (cat === 'lock') return '🔒'
  if (cat === 'fan') return '🌀'
  if (cat === 'meter') return '⚡'
  if (cat === 'sensor') {
    const name = device.name
    const model2 = model
    if (name.includes('温') || name.includes('温度') || model2.includes('temp')) return '🌡️'
    if (name.includes('湿') || name.includes('湿度') || model2.includes('humid')) return '💧'
    if (name.includes('人体') || name.includes('motion')) return '🚶'
    return '📊'
  }
  return '🏠'
}

function stateDot(device: DashboardDevice): { color: string; label: string } {
  if (!device.online) return { color: COLORS.danger, label: 'offline' }
  const power = device.props.power
  const on = power === 1 || power === '1' || power === 'on' || power === true
  return on
    ? { color: COLORS.on, label: 'on' }
    : { color: COLORS.off, label: 'off' }
}

function fmtValue(value: unknown): string {
  if (value === 1 || value === '1' || value === 'on' || value === true) return 'on'
  if (value === 0 || value === '0' || value === 'off' || value === false) return 'off'
  return String(value)
}

/** Display value with a unit hint for known props. */
function fmtPropValue(key: string, value: unknown): string {
  const v = fmtValue(value)
  if (key === 'brightness') return `${v}%`
  if (key === 'temperature') return `${v}°C`
  if (key === 'humidity') return `${v}%`
  if (key === 'power_consumption') return `${v} W`
  if (key === 'battery') return `${v}%`
  return v
}

/** One highlight prop for the row: brightness → %, temp → °C, else raw. */
function highlightProp(props: Record<string, unknown>): { key: string; value: string } | null {
  const entries = Object.entries(props)
  if (entries.length === 0) return null
  const preferred = ['brightness', 'temperature', 'humidity', 'power_consumption', 'battery', 'state', 'aqi']
  for (const key of preferred) {
    if (key in props) {
      return { key, value: fmtPropValue(key, props[key]) }
    }
  }
  const [k, v] = entries[0]!
  return { key: k, value: fmtValue(v) }
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

const GROUP_TITLES: Array<[string, string]> = [
  ['light', '💡 灯光'],
  ['outlet', '🔌 插座'],
  ['sensor', '📊 传感器'],
  ['climate', '❄️ 空调'],
  ['media', '📺 影音'],
  ['cleaning', '🧹 清洁'],
  ['camera', '📷 摄像头'],
  ['lock', '🔒 门锁'],
  ['fan', '🌀 风扇'],
  ['meter', '⚡ 电表'],
]

function groupDevices(devices: DashboardDevice[]): Array<{ title: string; items: DashboardDevice[] }> {
  const groups = GROUP_TITLES.map(([key, title]) => ({
    title,
    items: devices.filter(d => categoryOf(d) === key),
  }))
  const others = devices.filter(d => !GROUP_TITLES.some(([key]) => categoryOf(d) === key))
  if (others.length > 0) groups.push({ title: '🏠 其他', items: others })
  return groups.filter(g => g.items.length > 0)
}

// ---------------------------------------------------------------------------
// Console data (same-origin read-only route)
// ---------------------------------------------------------------------------
interface ConsoleState {
  ok: boolean
  snapshot: DashboardSnapshot | null
  health: { account?: string; region?: string; mode?: string; homes?: number; devices?: number } | null
  error?: string
  at: number
  /** Rendered from the last cached snapshot (shown instantly, refreshed in background). */
  fromCache?: boolean
}

interface ConsoleBody {
  ok?: boolean
  snapshot?: DashboardSnapshot
  health?: ConsoleState['health']
  error?: string
}

const CONSOLE_CACHE_KEY = 'dsh-mihome:console:snapshot:v1'

function readCachedConsole(): ConsoleState | null {
  try {
    const raw = localStorage.getItem(CONSOLE_CACHE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as { snapshot?: DashboardSnapshot; health?: ConsoleState['health']; at?: number }
    const snapshot = data.snapshot
    if (!snapshot || snapshot.kind !== 'mihome-dashboard' || !Array.isArray(snapshot.devices)) return null
    return {
      ok: true,
      snapshot,
      health: data.health ?? null,
      at: data.at ?? Date.now(),
      fromCache: true,
    }
  } catch {
    return null
  }
}

function saveConsoleCache(state: ConsoleState): void {
  try {
    localStorage.setItem(CONSOLE_CACHE_KEY, JSON.stringify({
      snapshot: state.snapshot,
      health: state.health,
      at: state.at,
    }))
  } catch {
    // quota / private mode — the console still works, just without warm start
  }
}

function useConsoleState(tick: number): ConsoleState | null {
  const [state, setState] = useState<ConsoleState | null>(() => readCachedConsole())
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/dsh-mihome/state')
        const body = (await res.json()) as ConsoleBody
        if (cancelled) return
        if (body.ok && body.snapshot) {
          const fresh: ConsoleState = {
            ok: true,
            snapshot: body.snapshot,
            health: body.health ?? null,
            at: Date.now(),
          }
          setState(fresh)
          saveConsoleCache(fresh)
        } else {
          setState(prev => prev?.fromCache
            ? { ...prev, at: Date.now() }
            : { ok: false, snapshot: null, health: null, error: body.error, at: Date.now() })
        }
      } catch (err) {
        if (!cancelled) {
          setState(prev => prev?.fromCache
            ? { ...prev, at: Date.now() }
            : { ok: false, snapshot: null, health: null, error: String(err), at: Date.now() })
        }
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [tick])
  return state
}

// ---------------------------------------------------------------------------
// Device cards
// ---------------------------------------------------------------------------

/** Categories the console may switch (power on/off). */
const CONTROLLABLE: string[] = ['light', 'outlet', 'climate', 'media', 'fan', 'cleaning']

function DeviceCard({ device, busy, onToggle }: { device: DashboardDevice; busy?: boolean; onToggle?: () => void }): ReactNode {
  const props = Object.entries(device.props ?? {})
    .filter(([key]) => key !== 'power')
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${fmtPropValue(key, value)}`)
  const power = device.props.power
  const on = power === 1 || power === '1' || power === 'on' || power === true
  const controllable = device.online && CONTROLLABLE.includes(categoryOf(device))
  return createElement('div', {
    className: 'mihome-card',
    style: {
      background: NEO.card,
      borderRadius: 18,
      padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 6,
    },
  },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      createElement('span', {
        style: {
          fontSize: 17, width: 34, height: 34, flex: 'none',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 11,
          background: on ? NEO_GRADIENT : NEO.card,
          boxShadow: on ? 'none' : neoShadow(3),
        },
      }, iconFor(device)),
      createElement('span', {
        style: { flex: 1, color: NEO.text, fontSize: 13, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, device.name || device.did),
      createElement('span', {
        style: { color: device.online ? (on ? NEO.on : NEO.muted) : NEO.danger, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' },
      }, device.online ? (on ? 'on' : 'off') : '离线'),
      ...(controllable ? [
        createElement('button', {
          key: 'sw', onClick: onToggle, disabled: busy,
          style: {
            width: 44, height: 24, borderRadius: 99, padding: 2, border: 'none', flex: 'none',
            cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
            display: 'inline-flex', alignItems: 'center',
            justifyContent: on ? 'flex-end' : 'flex-start',
            background: on ? NEO_GRADIENT : '#dde1ea',
            boxShadow: on
              ? 'inset 2px 2px 4px rgba(140, 55, 110, 0.35), inset -2px -2px 4px rgba(255, 255, 255, 0.30)'
              : 'inset 2px 2px 4px rgba(163, 170, 190, 0.55), inset -2px -2px 4px rgba(255, 255, 255, 0.90)',
          },
        },
          createElement('span', {
            style: {
              width: 20, height: 20, borderRadius: '50%',
              background: on ? '#fff' : '#f4f6fa',
              boxShadow: '1px 1px 3px rgba(120, 127, 145, 0.40)',
            },
          }, busy ? '' : null),
        ),
      ] : []),
    ),
    createElement('div', {
      style: { color: NEO.muted, fontSize: 12, minHeight: 16 },
    }, props.length > 0 ? props.join(' · ') : (device.online ? '—' : '设备离线')),
    createElement('div', {
      style: { color: '#a9b0c0', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, device.model),
  )
}

// ---------------------------------------------------------------------------
// Card templates — one design per device type (research-backed: thermostat
// gets a dial, sensors get big-metric tiles, lock/camera get status cards,
// switches get the pill toggle).
// ---------------------------------------------------------------------------

function powerOn(device: DashboardDevice): boolean {
  const power = device.props.power
  return power === 1 || power === '1' || power === 'on' || power === true || power === true
}

function nameStatusRow(device: DashboardDevice): ReactNode {
  return createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
    createElement('span', { style: { fontSize: 14, flex: 1, color: NEO.text, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      device.name || device.did),
    createElement('span', { style: { color: device.online ? NEO.muted : NEO.danger, fontSize: 11, fontWeight: 700 } },
      device.online ? '在线' : '离线'))
}

/** Inner tile: pressed-in neumorphic well for metrics. */
const TILE_PRESET = {
  background: '#e2e6ef',
  borderRadius: 14,
  boxShadow: 'inset 3px 3px 6px rgba(163, 170, 190, 0.45), inset -3px -3px 6px rgba(255, 255, 255, 0.95)',
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
  flex: 1, minWidth: 0,
} as const

/** Climate card — ring dial with mode/temperature (reference screen 2/3). */
function ThermostatCard({ device, busy, onToggle }: { device: DashboardDevice; busy?: boolean; onToggle?: () => void }): ReactNode {
  const on = powerOn(device)
  const temp = Number(device.props.temperature ?? device.props.target_temperature ?? 0) || 0
  const mode = String(device.props.mode ?? (on ? 'heating' : 'off'))
  const pct = Math.max(0, Math.min(100, ((temp - 5) / 30) * 100))
  const controllable = device.online
  return createElement('div', {
    className: 'mihome-card',
    style: { background: NEO.card, borderRadius: 18, padding: '14px', display: 'flex', flexDirection: 'column', gap: 10 },
  },
    nameStatusRow(device),
    createElement('div', { style: { display: 'flex', justifyContent: 'center' } },
      createElement('div', {
        style: {
          width: 108, height: 108, borderRadius: '50%', position: 'relative',
          background: `conic-gradient(from 210deg, #ff7ab8 0% ${pct}%, #e2e6ef ${pct}% 100%)`,
          boxShadow: neoShadow(6),
        },
      },
        createElement('div', {
          style: {
            position: 'absolute', inset: 14, borderRadius: '50%', background: NEO.card,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            boxShadow: 'inset 3px 3px 7px rgba(163, 170, 190, 0.45), inset -3px -3px 7px rgba(255, 255, 255, 0.95)',
          },
        },
          createElement('span', { style: { color: NEO.muted, fontSize: 11, fontWeight: 800, letterSpacing: '0.05em' } }, mode.toUpperCase()),
          createElement('span', { style: { color: NEO.text, fontSize: 26, fontWeight: 800 } }, temp ? `${Math.round(temp)}°` : '--'),
          createElement('span', { style: { color: NEO.muted, fontSize: 10 } }, '温度'),
        ),
      ),
    ),
    createElement('div', { style: { display: 'flex', gap: 10 } },
      createElement('div', { style: { ...TILE_PRESET, padding: '8px 6px' } },
        createElement('span', { style: { color: NEO.muted, fontSize: 10, fontWeight: 700 } }, '湿度'),
        createElement('span', { style: { color: NEO.text, fontSize: 14, fontWeight: 800 } },
          device.props.humidity != null ? `${fmtPropValue('humidity', device.props.humidity)}` : '--'),
      ),
      createElement('div', { style: { ...TILE_PRESET, padding: '8px 6px' } },
        createElement('span', { style: { color: NEO.muted, fontSize: 10, fontWeight: 700 } }, '模式'),
        createElement('span', { style: { color: NEO.text, fontSize: 14, fontWeight: 800 } }, mode || '--'),
      ),
    ),
    ...(controllable ? [
      createElement('button', {
        key: 'sw', onClick: onToggle, disabled: busy,
        style: {
          alignSelf: 'flex-end', width: 44, height: 24, borderRadius: 99, padding: 2, border: 'none',
          cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
          display: 'inline-flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start',
          background: on ? NEO_GRADIENT : '#dde1ea',
          boxShadow: on
            ? 'inset 2px 2px 4px rgba(140, 55, 110, 0.35), inset -2px -2px 4px rgba(255, 255, 255, 0.30)'
            : 'inset 2px 2px 4px rgba(163, 170, 190, 0.55), inset -2px -2px 4px rgba(255, 255, 255, 0.90)',
        },
      },
        createElement('span', {
          style: { width: 20, height: 20, borderRadius: '50%', background: on ? '#fff' : '#f4f6fa', boxShadow: '1px 1px 3px rgba(120, 127, 145, 0.40)' },
        }, busy ? '' : null),
      ),
    ] : []),
  )
}

/** Sensor card — big metric tiles (temperature / humidity), read-only. */
function SensorCard({ device }: { device: DashboardDevice }): ReactNode {
  const temp = device.props.temperature
  const humidity = device.props.humidity
  const pairs: Array<[string, unknown]> = [
    ['温度', temp],
    ['湿度', humidity],
  ].filter(([, v]) => v != null) as Array<[string, unknown]>
  return createElement('div', {
    className: 'mihome-card',
    style: { background: NEO.card, borderRadius: 18, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
  },
    nameStatusRow(device),
    createElement('div', { style: { display: 'flex', gap: 10 } },
      ...pairs.map(([label, value]) =>
        createElement('div', { key: label, style: { ...TILE_PRESET, padding: '10px 6px' } },
          createElement('span', { style: { color: NEO.muted, fontSize: 10, fontWeight: 700 } }, label),
          createElement('span', { style: { color: NEO.text, fontSize: 16, fontWeight: 800 } }, fmtPropValue(label === '温度' ? 'temperature' : 'humidity', value)),
        ),
      ),
    ),
    createElement('div', { style: { color: '#a9b0c0', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, device.model),
  )
}

/** Outlet / power meter card — consumption readout, read-only. */
function PowerCard({ device }: { device: DashboardDevice }): ReactNode {
  const watt = device.props.power_consumption
  return createElement('div', {
    className: 'mihome-card',
    style: { background: NEO.card, borderRadius: 18, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
  },
    nameStatusRow(device),
    createElement('div', { style: { display: 'flex', gap: 10 } },
      createElement('div', { style: { ...TILE_PRESET, padding: '12px 6px' } },
        createElement('span', { style: { fontSize: 18 } }, '⚡'),
        createElement('span', { style: { color: NEO.muted, fontSize: 10, fontWeight: 700 } }, '功率'),
        createElement('span', { style: { color: NEO.text, fontSize: 16, fontWeight: 800 } },
          watt != null ? `${fmtPropValue('power_consumption', watt)}` : '--'),
      ),
    ),
    createElement('div', { style: { color: '#a9b0c0', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, device.model),
  )
}

/** Lock card — security status (locked/unlocked + battery), read-only. */
function LockCard({ device }: { device: DashboardDevice }): ReactNode {
  const state = String(device.props.power ?? device.props.state ?? '—')
  const locked = !/unlock|off|0|false|开/i.test(state)
  return createElement('div', {
    className: 'mihome-card',
    style: { background: NEO.card, borderRadius: 18, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
  },
    nameStatusRow(device),
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
      createElement('span', {
        style: {
          fontSize: 22, width: 44, height: 44, flex: 'none',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 12, background: locked ? NEO_GRADIENT : '#e2e6ef',
          boxShadow: locked ? neoShadow(4) : 'inset 3px 3px 6px rgba(163, 170, 190, 0.45), inset -3px -3px 6px rgba(255, 255, 255, 0.95)',
        },
      }, locked ? '🔒' : '🔓'),
      createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 } },
        createElement('span', { style: { color: NEO.text, fontSize: 14, fontWeight: 800 } }, locked ? '已上锁' : '未上锁'),
        createElement('span', { style: { color: NEO.muted, fontSize: 11 } },
          device.props.battery != null ? `电量 ${fmtPropValue('battery', device.props.battery)}` : '—'),
      ),
    ),
    createElement('div', { style: { color: '#a9b0c0', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, device.model),
  )
}

/** Camera card — status tile, read-only. */
function CameraCard({ device }: { device: DashboardDevice }): ReactNode {
  return createElement('div', {
    className: 'mihome-card',
    style: { background: NEO.card, borderRadius: 18, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 },
  },
    nameStatusRow(device),
    createElement('div', { style: { ...TILE_PRESET, padding: '12px 6px' } },
      createElement('span', { style: { fontSize: 18 } }, device.online ? '📷' : '📷'),
      createElement('span', { style: { color: NEO.muted, fontSize: 10, fontWeight: 700 } }, '状态'),
      createElement('span', { style: { color: device.online ? NEO.on : NEO.danger, fontSize: 14, fontWeight: 800 } },
        device.online ? '在线 · 预览已就绪' : '离线'),
    ),
    createElement('div', { style: { color: '#a9b0c0', fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, device.model),
  )
}

/** Dispatch: device type → its card template. */
function deviceCardFor(device: DashboardDevice, busy: boolean, onToggle: () => void): ReactNode {
  switch (categoryOf(device)) {
    case 'climate':
      return createElement(ThermostatCard, { key: device.did, device, busy, onToggle })
    case 'sensor':
      return createElement(SensorCard, { key: device.did, device })
    case 'meter':
      return createElement(PowerCard, { key: device.did, device })
    case 'lock':
      return createElement(LockCard, { key: device.did, device })
    case 'camera':
      return createElement(CameraCard, { key: device.did, device })
    default:
      return createElement(DeviceCard, { key: device.did, device, busy, onToggle })
  }
}

// ---------------------------------------------------------------------------
// Mi Home view (replaces the chat area while active; lives in the top view
// ring as a "🏠 米家" tab, so sidebar and header stay untouched)
// ---------------------------------------------------------------------------
function MihomeView(): ReactNode {
  const [tick, setTick] = useState(0)
  const [roomFilter, setRoomFilter] = useState<number | 'all'>('all')
  const [busyDid, setBusyDid] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const state = useConsoleState(tick)
  const snapshot = state?.snapshot ?? null
  const onlineCount = snapshot ? snapshot.devices.filter(d => d.online).length : 0
  const notConnected = state !== null && !state.ok
  const loading = state === null

  const visibleDevices = snapshot && roomFilter !== 'all'
    ? snapshot.devices.filter(d => (d.room_id ?? -1) === roomFilter)
    : (snapshot?.devices ?? [])
  const groups = snapshot ? groupDevices(visibleDevices) : []

  const toggleDevice = async (device: DashboardDevice): Promise<void> => {
    const power = device.props.power
    const isOn = power === 1 || power === '1' || power === 'on' || power === true
    setBusyDid(device.did)
    setNotice(null)
    try {
      const res = await fetch(
        `/dsh-mihome/control?deviceId=${encodeURIComponent(device.did)}&on=${isOn ? '0' : '1'}`,
        { method: 'POST' },
      )
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
      if (body?.ok) {
        setTick(t => t + 1)
      } else {
        setNotice(body?.error ?? '控制失败，请重试')
      }
    } catch {
      setNotice('无法连接控制接口（/dsh-mihome/control）')
    }
    setBusyDid(null)
  }

  const pill = snapshot
    ? {
        text: `● ${onlineCount}/${snapshot.devices.length} 在线`,
        color: onlineCount > 0 ? '#188a5f' : NEO.muted,
        bg: onlineCount > 0 ? '#dcf5e8' : '#e3e6ee',
      }
    : notConnected
      ? { text: '未连接', color: NEO.danger, bg: '#fbe3e9' }
      : { text: '连接中…', color: NEO.warn, bg: '#f6ecd9' }

  return createElement('div', {
    style: {
      height: '100%', overflowY: 'auto',
      background: NEO.bg,
      fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
    },
  },
    createElement('div', { style: { maxWidth: 1100, margin: '0 auto', padding: '22px 24px 40px' } },
      // Top bar
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 } },
        createElement('span', { style: { fontSize: 20 } }, '🏠'),
        createElement('span', { style: { color: NEO.text, fontSize: 18, fontWeight: 800 } }, '米家控制台'),
        createElement('span', {
          style: {
            padding: '4px 12px', borderRadius: 99, fontSize: 11, fontWeight: 700,
            color: pill.color, background: pill.bg,
          },
        }, pill.text),
        createElement('span', { style: { color: NEO.muted, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          state && !notConnected
            ? (state.fromCache
                ? `缓存数据 · 更新于 ${shortTime(new Date(state.at).toISOString())} · 正在刷新…`
                : (state.health
                    ? `${state.health.account ?? '...'} · 区域 ${state.health.region ?? 'cn'} · ${state.health.homes ?? 0} 家庭 / ${state.health.devices ?? 0} 设备 · ${shortTime(new Date(state.at).toISOString())}`
                    : ''))
            : ''),
        createElement('button', {
          onClick: () => setTick(t => t + 1),
          style: {
            height: 32, padding: '0 14px', borderRadius: 12,
            background: NEO.card, border: 'none',
            boxShadow: neoShadow(4), color: NEO.text,
            fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          },
        }, '↻ 刷新'),
      ),
      // Not connected: friendly onboarding hero
      ...(notConnected ? [
        createElement('div', {
          key: 'hero', className: 'mihome-hero',
          style: {
            maxWidth: 520, margin: '48px auto 0', textAlign: 'center',
            background: NEO.card, borderRadius: 24, padding: '38px 30px',
            boxShadow: neoShadow(10),
            display: 'flex', flexDirection: 'column', gap: 10,
          },
        },
          createElement('div', { style: { fontSize: 44 } }, '🏠'),
          createElement('div', { style: { color: NEO.text, fontSize: 18, fontWeight: 800 } }, '米家还没有连接'),
          createElement('div', { style: { color: NEO.muted, fontSize: 13, lineHeight: 1.7 } }, '两步接入你的米家设备：'),
          createElement('div', {
            style: {
              textAlign: 'left', background: '#e2e6ef',
              boxShadow: 'inset 3px 3px 6px rgba(163, 170, 190, 0.45), inset -3px -3px 6px rgba(255, 255, 255, 0.95)',
              borderRadius: 14, padding: '14px 16px', margin: '6px 0 2px',
              display: 'flex', flexDirection: 'column', gap: 6,
            },
          },
            createElement('div', { style: { color: NEO.text, fontSize: 13 } }, '① 打开 DSH 设置 → 米家登录'),
            createElement('div', { style: { color: NEO.text, fontSize: 13 } }, '② 生成二维码，用米家 App 扫一扫并确认'),
            createElement('div', { style: { color: NEO.muted, fontSize: 12, lineHeight: 1.6 } },
              '登录成功后会保存会话，本页自动显示房间、设备与最近变化。'),
          ),
          ...(state?.error ? [
            createElement('div', {
              key: 'why', style: { color: NEO.muted, fontSize: 12, wordBreak: 'break-all', lineHeight: 1.6 },
            }, `原因：${state.error}`),
          ] : []),
          createElement('button', {
            onClick: () => setTick(t => t + 1),
            style: {
              alignSelf: 'center', marginTop: 6, height: 36, padding: '0 18px', borderRadius: 99,
              background: NEO_GRADIENT, border: 'none',
              boxShadow: neoShadow(5), color: '#fff',
              fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            },
          }, '↻ 重新检查'),
        ),
      ] : []),
      // Loading skeleton
      ...(loading ? [
        createElement('div', {
          key: 'skeleton',
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 },
        },
          ...Array.from({ length: 6 }, (_, i) =>
            createElement('div', {
              key: i,
              style: {
                background: NEO.card, borderRadius: 18, height: 84,
                boxShadow: neoShadow(4),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: NEO.muted, fontSize: 12,
              },
            }, '连接中…')),
        ),
      ] : []),
      // Connected content
      ...(!loading && !notConnected && snapshot ? [
        // Room filter chips
        ...(snapshot.rooms.length > 0 ? [
          createElement('div', {
            key: 'rooms', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
          },
            createElement('button', {
              key: 'all', onClick: () => setRoomFilter('all'),
              style: roomChipStyle(roomFilter === 'all'),
            }, `🏠 全部 ${snapshot.devices.length}`),
            ...snapshot.rooms.map(room => {
              const count = snapshot.devices.filter(d => d.room_id === room.room_id).length
              return createElement('button', {
                key: room.room_id, onClick: () => setRoomFilter(room.room_id),
                style: roomChipStyle(roomFilter === room.room_id),
              }, `🏠 ${room.name} ${count}`)
            }),
          ),
        ] : []),
        // Operation notice
        ...(notice ? [
          createElement('div', {
            key: 'notice',
            style: {
              background: '#f6ecd9', border: '1px solid rgba(192, 122, 24, 0.35)',
              borderRadius: 14, padding: '10px 14px', color: NEO.warn, fontSize: 13, marginBottom: 12,
              boxShadow: neoShadow(3),
            },
          }, `⚠️ ${notice}`),
        ] : []),
        // Summary line
        createElement('div', {
          key: 'summary',
          style: { color: NEO.muted, fontSize: 12, marginBottom: 14 },
        }, `${visibleDevices.length} 台设备（${visibleDevices.filter(d => d.online).length} 在线）· 每 3 秒自动刷新 · 卡片拨动开关即点即控（人工操作，类别白名单生效）`),
        // Device groups
        ...groups.map(group =>
          createElement('div', { key: group.title, style: { marginBottom: 18 } },
            createElement('div', { style: { color: '#71788a', fontSize: 12, marginBottom: 10, fontWeight: 800, letterSpacing: '0.04em' } }, group.title),
            createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 12 } },
              ...group.items.map(device => deviceCardFor(
                device,
                busyDid === device.did,
                () => { void toggleDevice(device) },
              )),
            ),
          ),
        ),
        // Recent events
        ...(snapshot.events.length > 0 ? [
          createElement('div', {
            key: 'events', style: { marginTop: 8, paddingTop: 14, borderTop: `1px solid ${NEO.line}` },
          },
            createElement('div', { style: { color: NEO.muted, fontSize: 12, marginBottom: 6, fontWeight: 700 } }, '🕐 最近变化'),
            ...snapshot.events.slice(0, 8).map((event, i) =>
              createElement('div', {
                key: i, style: { color: NEO.muted, fontSize: 13, display: 'flex', gap: 8, padding: '2px 0' },
              },
                createElement('span', {}, '📌'),
                createElement('span', { style: { flex: 1 } },
                  `${event.name}: ${event.changes.map(c => `${c[0]} ${c[1] ?? '—'} → ${c[2] ?? ''}`).join('，')}`),
                createElement('span', {}, shortTime(event.time)),
              ),
            ),
          ),
        ] : []),
      ] : []),
    ),
  )
}

/** Active/inactive chip style for the room filter (neumorphic). */
function roomChipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700,
    color: active ? '#fff' : NEO.text,
    background: active ? NEO_GRADIENT : NEO.card,
    border: 'none', borderRadius: 99, padding: '6px 14px',
    boxShadow: active ? neoShadow(3) : neoShadow(4),
  }
}

// ---------------------------------------------------------------------------
// Conversation dashboard card (mi_dashboard)
// ---------------------------------------------------------------------------
function DeviceRow({ device }: { device: DashboardDevice }) {
  const dot = stateDot(device)
  const hl = highlightProp(device.props)
  const value = device.online
    ? `${dot.label === 'on' ? 'on' : 'off'}${hl ? ` · ${hl.value}` : ''}`
    : '离线'
  return createElement('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 10px', borderRadius: 8, background: COLORS.card,
      border: `1px solid ${COLORS.border}`,
    },
  },
    createElement('span', { style: { fontSize: 15 } }, iconFor(device)),
    createElement('span', {
      style: { flex: 1, color: COLORS.text, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, device.name || device.did),
    createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
      createElement('span', { style: { fontSize: 12, color: device.online ? dot.color : COLORS.danger, fontWeight: 600 } }, value),
      createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: dot.color } }),
    ),
  )
}

/**
 * Renders the dashboard card. The prop type is the structural slice of the
 * keyed Chat-node seat (`node.data`), which satisfies both the view contract
 * and the slot component signature without pulling the locale-bound props.
 */
function DashboardView(props: { node: { data: DashboardChatData } }) {
  const { node } = props
  const snapshot: DashboardSnapshot = node.data.snapshot

  // Friendly offline state instead of a bare error card.
  if (snapshot.error) {
    return createElement('div', {
      style: {
        background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 12,
        padding: '18px 16px', maxWidth: 560, textAlign: 'center',
        fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
      },
    },
      createElement('div', { style: { fontSize: 30 } }, '🍃'),
      createElement('div', { style: { color: COLORS.text, fontSize: 14, fontWeight: 700, marginTop: 6 } }, '米家仪表盘 · 未连接'),
      createElement('div', { style: { color: COLORS.muted, fontSize: 12, lineHeight: 1.7, marginTop: 6 } }, snapshot.error),
      createElement('div', { style: { color: COLORS.muted, fontSize: 12, marginTop: 8 } },
        '登录入口：设置 → 米家登录 · 扫码后自动完成'),
    )
  }

  const groups = groupDevices(snapshot.devices)
  const onlineCount = snapshot.devices.filter(d => d.online).length

  return createElement('div', {
    style: {
      background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 12,
      padding: '12px 14px', maxWidth: 560, fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
    },
  },
    // Header
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
      createElement('span', { style: { fontSize: 16 } }, '🏠'),
      createElement('span', { style: { color: COLORS.text, fontWeight: 700, fontSize: 14, flex: 1 } }, '米家仪表盘'),
      createElement('span', { style: { color: COLORS.muted, fontSize: 11 } },
        `${snapshot.devices.length} 台设备 · ${onlineCount} 在线 · ${shortTime(snapshot.generatedAt)}`),
    ),
    // Rooms
    ...(snapshot.rooms.length > 0 ? [
      createElement('div', { key: 'rooms', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
        ...snapshot.rooms.map(room =>
          createElement('span', {
            key: room.room_id,
            style: {
              fontSize: 12, color: COLORS.text, background: COLORS.card,
              border: `1px solid ${COLORS.border}`, borderRadius: 99, padding: '3px 10px',
            },
          }, `🏠 ${room.name}`)),
      ),
    ] : []),
    // Category groups
    ...groups.map(group =>
      createElement('div', { key: group.title, style: { marginBottom: 8 } },
        createElement('div', { style: { color: COLORS.muted, fontSize: 11, marginBottom: 4 } }, group.title),
        createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 } },
          ...group.items.map(device => createElement(DeviceRow, { key: device.did, device })),
        ),
      ),
    ),
    // Recent changes
    ...(snapshot.events.length > 0 ? [
      createElement('div', { key: 'events', style: { marginTop: 8, paddingTop: 8, borderTop: `1px solid ${COLORS.border}` } },
        createElement('div', { style: { color: COLORS.muted, fontSize: 11, marginBottom: 4 } }, '🕐 最近变化'),
        ...snapshot.events.slice(0, 5).map((event, i) =>
          createElement('div', { key: i, style: { color: COLORS.muted, fontSize: 12, display: 'flex', gap: 6 } },
            createElement('span', {}, '📌'),
            createElement('span', { style: { flex: 1 } },
              `${event.name}: ${event.changes.map(c => `${c[0]} ${c[1] ?? '—'} → ${c[2]}`).join('，')}`),
            createElement('span', {}, shortTime(event.time)),
          ),
        ),
      ),
    ] : []),
  )
}

// ---------------------------------------------------------------------------
// Settings page: Mi Home QR login (米家 App 扫码登录)
// ---------------------------------------------------------------------------
interface AuthStatusBody {
  ok?: boolean
  stored?: boolean
  username?: string
  state?: { phase: string; message: string; expiresAt: number | null }
}

const PHASE_TEXT: Record<string, string> = {
  idle: '尚未登录',
  waiting: '请用米家 App 扫描二维码',
  scanned: '已提交，请在米家 App 上确认登录',
  ok: '登录成功，会话已保存',
  expired: '二维码已过期，请重新生成',
  failed: '登录失败',
}

function SettingsMihome(): ReactNode {
  const [data, setData] = useState<AuthStatusBody | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/dsh-mihome/auth/status')
        const body = (await res.json().catch(() => null)) as AuthStatusBody | null
        if (cancelled) return
        if (!body) {
          setError(`无法连接插件路由（HTTP ${res.status}）—— 请确认 Settings → 插件 中 dsh-mihome 已启用，且重启过 dsh`)
        } else {
          setError(null)
          setData(body)
        }
      } catch {
        if (!cancelled) setError('无法连接插件路由（/dsh-mihome/…）—— 请确认 dsh-mihome 已加载并重启过 dsh')
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const startQr = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/dsh-mihome/auth/qr', { method: 'POST' })
      const body = (await res.json()) as AuthStatusBody & { qr?: string; error?: string }
      if (body.ok && body.qr) {
        setQr(body.qr)
        setData(d => ({ ...(d ?? {}), state: body.state }))
      } else {
        setError(body.error ?? '生成二维码失败')
      }
    } catch {
      setError('无法请求二维码')
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    setBusy(true)
    try {
      await fetch('/dsh-mihome/auth/logout', { method: 'POST' })
      setQr(null)
      const res = await fetch('/dsh-mihome/auth/status')
      setData((await res.json()) as AuthStatusBody)
    } catch {
      setError('退出登录失败')
    } finally {
      setBusy(false)
    }
  }

  const phase = data?.state?.phase ?? 'idle'
  const phaseColor = phase === 'ok'
    ? COLORS.on
    : phase === 'expired' || phase === 'failed'
      ? COLORS.danger
      : phase === 'waiting' || phase === 'scanned'
        ? COLORS.warn
        : COLORS.muted

  return createElement('div', { style: { maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 12 } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('span', { style: { fontSize: 16 } }, '🐋'),
      createElement('span', { style: { color: COLORS.text, fontSize: 15, fontWeight: 700 } }, '米家登录'),
      createElement('span', { style: { marginLeft: 'auto', fontSize: 12, color: phaseColor, fontWeight: 600 } },
        PHASE_TEXT[phase] ?? phase),
    ),
    ...(data?.stored ? [
      createElement('div', {
        key: 'stored', style: {
          background: 'rgba(110, 231, 183, 0.08)', border: '1px solid rgba(110, 231, 183, 0.35)',
          borderRadius: 10, padding: '10px 14px', color: COLORS.on, fontSize: 13,
        },
      }, '✅ 已保存米家会话，插件会自动使用它访问云端。'),
    ] : []),
    ...(qr ? [
      createElement('img', { key: 'qr', src: qr, width: 240, height: 240, alt: '米家登录二维码', style: { borderRadius: 10, border: `1px solid ${COLORS.border}`, background: '#fff' } }),
    ] : []),
    ...(phase === 'waiting' || phase === 'scanned' ? [
      createElement('div', { key: 'hint', style: { color: COLORS.muted, fontSize: 12 } },
        '用米家 App 首页右上角「+」→ 扫一扫，或 App 设置 → 账号安全 内的扫码入口；确认后本页自动变为“登录成功”。'),
    ] : []),
    ...(error ? [
      createElement('div', { key: 'err', style: { color: COLORS.danger, fontSize: 13 } }, error),
    ] : []),
    createElement('div', { key: 'btns', style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
      createElement('button', {
        onClick: startQr,
        disabled: busy,
        style: btnStyle,
      }, qr ? '↻ 刷新二维码' : '生成登录二维码'),
      createElement('button', {
        onClick: logout,
        disabled: busy || !data?.stored,
        style: { ...btnStyle, color: COLORS.danger },
      }, '退出登录'),
    ),
    createElement('div', {
      key: 'foot', style: { color: COLORS.muted, fontSize: 12, lineHeight: 1.6 },
    },
      '扫码成功后会话保存在 $DSH_HOME/plugin-data/dsh-mihome/session.json，工具自动优先使用；' +
      '会话失效时会自动清除并回退到 MIHOME_USERNAME / MIHOME_PASSWORD 环境变量登录。'),
  )
}

const btnStyle = {
  height: 32, padding: '0 14px', borderRadius: 8,
  background: COLORS.card, border: `1px solid ${COLORS.border}`,
  color: COLORS.text, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
} as const

// ---------------------------------------------------------------------------
// Client plugin body
// ---------------------------------------------------------------------------
export function apply(ctx: ClientContext & Context): void {
  // Small stylesheet for hover/animation polish (removed with the fiber).
  if (typeof document !== 'undefined') {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.setAttribute('data-mihome-styles', '')
      tag.textContent = [
        '.mihome-card { box-shadow: 8px 8px 18px rgba(163, 170, 190, 0.40), -8px -8px 18px rgba(255, 255, 255, 0.92); transition: box-shadow .15s ease, transform .15s ease; }',
        '.mihome-card:hover { transform: translateY(-2px); box-shadow: 11px 11px 24px rgba(163, 170, 190, 0.48), -11px -11px 24px rgba(255, 255, 255, 1); }',
        '.mihome-hero { animation: mihome-pop .28s ease both; }',
        '@keyframes mihome-pop { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }',
      ].join('\n')
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }, 'dsh-mihome.styles')
  }

  ctx.conversationEvents.register(dashboardDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'mihome-dashboard',
  }, DashboardView))
  // Fixed top entry in the session view ring: one click replaces the chat
  // area with the Mi Home console (sidebar + header stay; chat tab returns).
  // Last position in the tab ring.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mihome',
    order: 100,
    label: '🏠 米家',
  }, MihomeView))
  // Settings page with Mi Home QR login (settings.section may not be part of
  // the 0.1.1-rc.2 typed SlotMap; the lenient view matches its runtime).
  const lenient = ctx.slots as unknown as {
    inject(key: string, cb: () => void): void
    register(options: { name: string; id?: string; key?: string; order?: number; label?: string }, component: (props?: unknown) => unknown): () => void
  }
  lenient.inject('settings.section', () => lenient.register({
    name: 'settings.section',
    id: 'mihome',
    order: 30,
    label: '米家登录',
  }, SettingsMihome as (props?: unknown) => unknown))
}

// Keep the type referenced so the augmentation stays part of the program.
export type { DashboardChatData }
export type { DashboardView as DashboardViewComponent }
export type { ReactNode }

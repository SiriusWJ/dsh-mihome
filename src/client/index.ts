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
import type { Context, Context as ClientContext } from '@deepseek-ai/cordis'
import { dashboardDefinition, type DashboardChatData } from './dashboard'
import type { DashboardDevice, DashboardSnapshot } from '../dashboard'

/** Required services: the conversation-node registry and the slots service. */
export const inject = ['uiConversation', 'slots']

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
// Neumorphic palette: SELF-OWNED CSS variables (light + dark defaults in the
// injected stylesheet, auto-switched via prefers-color-scheme), so the soft
// dual-shadow look survives any render context and follows the OS/app scheme.
// ---------------------------------------------------------------------------
const NEO = {
  bg: 'var(--mihome-bg)',
  card: 'var(--mihome-card)',
  cardAlt: 'var(--mihome-card)',
  text: 'var(--mihome-text)',
  muted: 'var(--mihome-muted)',
  line: 'var(--mihome-line)',
  on: '#21c48b',
  off: 'var(--mihome-muted)',
  danger: '#ec5f7b',
  warn: '#c07a18',
  accent: '#e8559b',
  accent2: '#8f6bff',
}

/** Neumorphic dual shadow (chips, buttons, pressed wells). */
function neoShadow(px: number): string {
  return `${px}px ${px}px ${px * 2}px var(--mihome-shadow-a), -${px}px -${px}px ${px * 2}px var(--mihome-shadow-b)`
}

/** Pink → violet signature gradient (accent constant, readable on both themes). */
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
// Compact neumorphic device cards (theme-adaptive soft UI; click → advanced
// operations panel)
// ---------------------------------------------------------------------------

/** Categories the console may switch (power on/off). */
const CONTROLLABLE: string[] = ['light', 'outlet', 'climate', 'media', 'fan', 'cleaning']

function powerOn(device: DashboardDevice): boolean {
  const power = device.props.power
  return power === 1 || power === '1' || power === 'on' || power === true
}

/** Short state line under the device name ('开着 100%', '28.2°C 76%', …). */
function deviceStateText(device: DashboardDevice): string {
  const props = device.props
  const on = powerOn(device)
  const category = categoryOf(device)
  if (!device.online) return '离线'
  if (category === 'sensor') {
    const t = props.temperature
    const h = props.humidity
    return [t != null ? fmtPropValue('temperature', t) : null, h != null ? fmtPropValue('humidity', h) : null]
      .filter((v): v is string => v !== null)
      .join(' ')
  }
  if (category === 'meter') return props.power_consumption != null ? fmtPropValue('power_consumption', props.power_consumption) : '—'
  if (category === 'climate') return `${String(props.mode ?? (on ? '加热' : '关'))}${props.temperature != null ? ` ${fmtPropValue('temperature', props.temperature)}` : ''}`
  if (category === 'lock') return String(props.power ?? props.state ?? '—')
  if (category === 'camera') return device.online ? '在线' : '离线'
  const b = props.brightness
  return `${on ? '开着' : '关'}${b != null ? ` ${fmtPropValue('brightness', b)}` : ''}`
}

function TileCard({ device, busy, onToggle, onOpen, roomName, stateText }: {
  device: DashboardDevice
  busy?: boolean
  onToggle?: () => void
  onOpen?: () => void
  roomName?: string
  stateText: string
}): ReactNode {
  const on = powerOn(device)
  const controllable = device.online && CONTROLLABLE.includes(categoryOf(device))
  return createElement('div', {
    className: 'mihome-card', onClick: onOpen,
    style: {
      background: NEO.card, borderRadius: 14, padding: '10px 12px', minHeight: 84,
      display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer',
    },
  },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('span', {
        style: {
          fontSize: 15, width: 28, height: 28, flex: 'none',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 9,
          background: on ? NEO_GRADIENT : 'rgba(232, 85, 155, 0.12)',
          opacity: on ? 1 : 0.92,
        },
      }, iconFor(device)),
      createElement('span', {
        style: { flex: 1, color: NEO.text, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, device.name || device.did),
      ...(controllable
        ? [createElement('button', {
            key: 'pw', onClick: (e) => { e.stopPropagation(); onToggle?.() }, disabled: busy,
            style: {
              width: 30, height: 30, borderRadius: '50%', border: 'none', flex: 'none',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
              background: on ? 'linear-gradient(160deg, #43d08a, #1f9e68)' : NEO.cardAlt,
              color: on ? '#fff' : NEO.muted,
              boxShadow: on ? '0 3px 8px rgba(24, 158, 104, 0.35)' : 'inset 1px 1px 2px rgba(0, 0, 0, 0.12)',
            },
          }, '⏻'),
        ] : [
          createElement('span', {
            key: 'st',
            style: {
              width: 26, height: 26, borderRadius: '50%', flex: 'none',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, color: NEO.muted, background: NEO.cardAlt,
              boxShadow: 'inset 1px 1px 2px rgba(0, 0, 0, 0.10)',
            },
          }, device.online ? '⏵' : '⏸'),
        ]),
    ),
    createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
      createElement('div', { style: { color: NEO.muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
        [roomName, stateText].filter(Boolean).join(' · ') || '—'),
    ),
  )
}

// ---------------------------------------------------------------------------
// Advanced operations panel (reference: centered dark dialog — name +
// power circle, big metric, mode circles, more operations)
// ---------------------------------------------------------------------------

/** Type-specific presets for the panel's circle row. */
const SHEET_MODES: Record<string, Array<{ label: string; icon: string; value: string }>> = {
  light: [
    { label: '柔和', icon: '◐', value: '30' },
    { label: '适中', icon: '◑', value: '60' },
    { label: '全亮', icon: '☀', value: '100' },
  ],
  climate: [
    { label: '制冷', icon: '❄', value: 'cool' },
    { label: '制热', icon: '♨', value: 'heat' },
    { label: '自动', icon: 'A', value: 'auto' },
  ],
}

/** Big-metric line for the panel center (reference: '2 ug/m³' + label). */
function deviceMetric(device: DashboardDevice): { value: string; unit: string; label: string } {
  const p = device.props
  const category = categoryOf(device)
  if (category === 'sensor') {
    return p.temperature != null
      ? { value: String(p.temperature), unit: '°C', label: '温度' }
      : { value: p.humidity != null ? String(p.humidity) : '--', unit: p.humidity != null ? '%' : '', label: '湿度' }
  }
  if (category === 'climate') {
    return { value: p.temperature != null ? String(Math.round(Number(p.temperature))) : '--', unit: '°', label: String(p.mode ?? '温度') }
  }
  if (category === 'meter') {
    return { value: p.power_consumption != null ? String(p.power_consumption) : '--', unit: 'W', label: '功率' }
  }
  if (category === 'lock') {
    const locked = !/unlock|off|0|false|开/i.test(String(p.power ?? p.state ?? '—'))
    return { value: locked ? '已上锁' : '未上锁', unit: '', label: '状态' }
  }
  return { value: powerOn(device) ? '开' : '关', unit: '', label: '电源' }
}

function DeviceSheet({ device, roomName, busy, onClose, onAction }: {
  device: DashboardDevice
  roomName?: string
  busy: boolean
  onClose: () => void
  onAction: (action: string, value?: string) => void
}): ReactNode {
  const [more, setMore] = useState(false)
  const on = powerOn(device)
  const modes = SHEET_MODES[categoryOf(device)] ?? []
  const metric = deviceMetric(device)
  const activeMode = (mode: { value: string }): boolean =>
    categoryOf(device) === 'light'
      ? String(device.props.brightness ?? '') === String(mode.value)
      : String(device.props.mode ?? '').toLowerCase() === String(mode.value)

  return createElement('div', {
    style: {
      position: 'fixed', inset: 0, zIndex: 600,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(10, 14, 12, 0.55)',
    },
    onClick: onClose,
  },
    createElement('div', {
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      key: device.did,
      style: {
        width: 'min(500px, 92vw)',
        background: 'var(--mihome-sheet)',
        borderRadius: 24, padding: '20px 22px 10px',
        color: 'var(--mihome-text)', display: 'flex', flexDirection: 'column', gap: 14,
        boxShadow: '0 26px 70px rgba(0, 0, 0, 0.5)',
      },
    },
      // Header: name + power circle
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
        createElement('div', { style: { flex: 1, minWidth: 0 } },
          createElement('div', { style: { fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            device.name || device.did),
          createElement('div', { style: { fontSize: 12, color: 'var(--mihome-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            [roomName, device.model].filter(Boolean).join(' · ')),
        ),
        createElement('button', {
          onClick: () => onAction('power', on ? '0' : '1'), disabled: busy,
          style: {
            width: 40, height: 40, borderRadius: '50%', border: 'none', flex: 'none',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, cursor: busy ? 'default' : 'pointer', fontFamily: 'inherit',
            background: on ? 'linear-gradient(160deg, #35c7b0, #1f9c87)' : 'rgba(255,255,255,0.10)',
            color: '#fff',
          },
        }, '⏻'),
      ),
      // Big metric
      createElement('div', { style: { textAlign: 'center', padding: '6px 0' } },
        createElement('div', { style: { display: 'inline-flex', alignItems: 'baseline', gap: 4 } },
          createElement('span', { style: { fontSize: 42, fontWeight: 300, color: 'var(--mihome-text)', letterSpacing: '-0.02em' } }, metric.value),
          createElement('span', { style: { fontSize: 15, color: 'var(--mihome-muted)' } }, metric.unit),
        ),
        createElement('div', { style: { fontSize: 12, color: 'var(--mihome-muted)', marginTop: 2 } }, metric.label),
      ),
      // Mode circles (light: brightness presets; climate: mode presets)
      ...(modes.length > 0 ? [
        createElement('div', { key: 'modes', style: { display: 'flex', justifyContent: 'center', gap: 26 } },
          ...modes.map(mode =>
            createElement('div', { key: mode.value, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 } },
              createElement('button', {
                onClick: () => onAction(categoryOf(device) === 'light' ? 'bright' : 'mode', mode.value),
                disabled: busy,
                style: {
                  width: 54, height: 54, borderRadius: '50%', border: 'none', fontFamily: 'inherit',
                  fontSize: 20, fontWeight: 700, cursor: busy ? 'default' : 'pointer',
                  background: activeMode(mode) ? 'linear-gradient(160deg, #3da5f5, #2b7fe0)' : 'rgba(128, 134, 150, 0.18)',
                  color: '#fff',
                },
              }, mode.icon),
              createElement('span', { style: { fontSize: 12, color: activeMode(mode) ? '#3d9bee' : 'var(--mihome-muted)' } }, mode.label),
            ),
          ),
        ),
      ] : []),
      // More operations
      createElement('button', {
        onClick: () => setMore(m => !m),
        style: {
          width: '100%', padding: '9px 0', border: 'none', background: 'transparent',
          borderTop: '1px solid var(--mihome-line)',
          color: 'var(--mihome-muted)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
        },
      }, '更多操作'),
      ...(more ? [
        createElement('div', {
          key: 'raw',
          style: {
            background: 'rgba(128, 134, 150, 0.12)', borderRadius: 12, padding: '10px 12px',
            fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12,
            color: 'var(--mihome-muted)', lineHeight: 1.7, wordBreak: 'break-all',
            maxHeight: 140, overflowY: 'auto',
          },
        },
          Object.entries(device.props ?? {}).map(([k, v]) => `${k}: ${fmtValue(v)}`).join('\n') || '(无属性)'),
      ] : []),
    ),
  )
}

/** Dispatch: uniform tile card every device (type detail lives in the panel). */
function deviceCardFor(device: DashboardDevice, busy: boolean, onToggle: () => void, onOpen: () => void, roomName: string | undefined): ReactNode {
  return createElement(TileCard, { key: device.did, device, busy, onToggle, onOpen, roomName, stateText: deviceStateText(device) })
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
  const [sheetDid, setSheetDid] = useState<string | null>(null)
  const state = useConsoleState(tick)
  const snapshot = state?.snapshot ?? null
  const onlineCount = snapshot ? snapshot.devices.filter(d => d.online).length : 0
  const notConnected = state !== null && !state.ok
  const loading = state === null

  const visibleDevices = snapshot && roomFilter !== 'all'
    ? snapshot.devices.filter(d => (d.room_id ?? -1) === roomFilter)
    : (snapshot?.devices ?? [])
  const groups = snapshot ? groupDevices(visibleDevices) : []

  const roomNameFor = (device: DashboardDevice): string | undefined =>
    snapshot?.rooms.find(r => r.room_id === device.room_id)?.name
  const sheetDevice = snapshot?.devices.find(d => d.did === sheetDid) ?? null

  const control = async (device: DashboardDevice, query: string): Promise<void> => {
    setBusyDid(device.did)
    setNotice(null)
    try {
      const res = await fetch(`/dsh-mihome/control?deviceId=${encodeURIComponent(device.did)}${query}`, { method: 'POST' })
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

  const toggleDevice = async (device: DashboardDevice): Promise<void> => {
    const isOn = powerOn(device)
    await control(device, `&action=power&on=${isOn ? '0' : '1'}`)
  }

  const sheetAction = async (device: DashboardDevice, action: string, value?: string): Promise<void> => {
    if (action === 'power') {
      await control(device, `&action=power&on=${value === '0' ? '0' : '1'}`)
    } else {
      await control(device, `&action=${action}&value=${encodeURIComponent(value ?? '')}`)
    }
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
    createElement('div', { style: { maxWidth: 1040, margin: '0 auto', padding: '16px 20px 28px' } },
      // Top bar
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 } },
        createElement('span', { style: { fontSize: 18 } }, '🏠'),
        createElement('span', { style: { color: NEO.text, fontSize: 16, fontWeight: 800 } }, '米家控制台'),
        createElement('span', {
          style: {
            padding: '3px 10px', borderRadius: 99, fontSize: 10, fontWeight: 700,
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
            height: 28, padding: '0 12px', borderRadius: 10,
            background: NEO.card, border: 'none',
            boxShadow: neoShadow(3), color: NEO.text,
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          },
        }, '↻ 刷新'),
      ),
      // Not connected: friendly onboarding hero
      ...(notConnected ? [
        createElement('div', {
          key: 'hero', className: 'mihome-hero',
          style: {
            maxWidth: 440, margin: '40px auto 0', textAlign: 'center',
            background: NEO.card, borderRadius: 20, padding: '26px 22px',
            boxShadow: neoShadow(8),
            display: 'flex', flexDirection: 'column', gap: 8,
          },
        },
          createElement('div', { style: { fontSize: 34 } }, '🏠'),
          createElement('div', { style: { color: NEO.text, fontSize: 16, fontWeight: 800 } }, '米家还没有连接'),
          createElement('div', { style: { color: NEO.muted, fontSize: 12, lineHeight: 1.7 } }, '两步接入你的米家设备：'),
          createElement('div', {
            style: {
              textAlign: 'left', background: 'rgba(128, 134, 150, 0.10)',
              boxShadow: 'inset 2px 2px 5px var(--mihome-inset-a), inset -2px -2px 5px var(--mihome-inset-b)',
              borderRadius: 12, padding: '10px 12px', margin: '4px 0 2px',
              display: 'flex', flexDirection: 'column', gap: 5,
            },
          },
            createElement('div', { style: { color: NEO.text, fontSize: 12 } }, '① 打开 DSH 设置 → 米家登录'),
            createElement('div', { style: { color: NEO.text, fontSize: 12 } }, '② 生成二维码，用米家 App 扫一扫并确认'),
            createElement('div', { style: { color: NEO.muted, fontSize: 11, lineHeight: 1.6 } },
              '登录成功后会保存会话，本页自动显示房间、设备与最近变化。'),
          ),
          ...(state?.error ? [
            createElement('div', {
              key: 'why', style: { color: NEO.muted, fontSize: 11, wordBreak: 'break-all', lineHeight: 1.6 },
            }, `原因：${state.error}`),
          ] : []),
          createElement('button', {
            onClick: () => setTick(t => t + 1),
            style: {
              alignSelf: 'center', marginTop: 4, height: 30, padding: '0 14px', borderRadius: 99,
              background: NEO_GRADIENT, border: 'none',
              boxShadow: neoShadow(4), color: '#fff',
              fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
            },
          }, '↻ 重新检查'),
        ),
      ] : []),
      // Loading skeleton
      ...(loading ? [
        createElement('div', {
          key: 'skeleton',
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 },
        },
          ...Array.from({ length: 6 }, (_, i) =>
            createElement('div', {
              key: i,
              style: {
                background: NEO.card, borderRadius: 14, height: 72,
                boxShadow: neoShadow(3),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: NEO.muted, fontSize: 11,
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
              background: 'rgba(192, 122, 24, 0.12)',
              border: '1px solid rgba(192, 122, 24, 0.35)',
              borderRadius: 12, padding: '8px 12px', color: NEO.warn, fontSize: 12, marginBottom: 10,
              boxShadow: neoShadow(2),
            },
          }, `⚠️ ${notice}`),
        ] : []),
        // Summary line
        createElement('div', {
          key: 'summary',
          style: { color: NEO.muted, fontSize: 11, marginBottom: 10 },
        }, `${visibleDevices.length} 台设备（${visibleDevices.filter(d => d.online).length} 在线）· 每 3 秒自动刷新 · 卡片拨动开关即点即控（人工操作，类别白名单生效）`),
        // Device groups
        ...groups.map(group =>
          createElement('div', { key: group.title, style: { marginBottom: 12 } },
            createElement('div', { style: { color: NEO.muted, fontSize: 11, marginBottom: 6, fontWeight: 700, letterSpacing: '0.04em' } }, group.title),
            createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 } },
              ...group.items.map(device => deviceCardFor(
                device,
                busyDid === device.did,
                () => { void toggleDevice(device) },
                () => setSheetDid(device.did),
                roomNameFor(device),
              )),
            ),
          ),
        ),
        // Recent events
        ...(snapshot.events.length > 0 ? [
          createElement('div', {
            key: 'events', style: { marginTop: 6, paddingTop: 10, borderTop: `1px solid ${NEO.line}` },
          },
            createElement('div', { style: { color: NEO.muted, fontSize: 11, marginBottom: 4, fontWeight: 700 } }, '🕐 最近变化'),
            ...snapshot.events.slice(0, 8).map((event, i) =>
              createElement('div', {
                key: i, style: { color: NEO.muted, fontSize: 12, display: 'flex', gap: 8, padding: '2px 0' },
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
      ...(sheetDevice ? [
        createElement(DeviceSheet, {
          key: sheetDevice.did,
          device: sheetDevice,
          roomName: roomNameFor(sheetDevice),
          busy: busyDid === sheetDevice.did,
          onClose: () => setSheetDid(null),
          onAction: (action, value) => { void sheetAction(sheetDevice, action, value) },
        }),
      ] : []),
    ),
  )
}

/** Active/inactive chip style for the room filter (compact neumorphic). */
function roomChipStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700,
    color: active ? '#fff' : NEO.text,
    background: active ? NEO_GRADIENT : NEO.card,
    border: 'none', borderRadius: 99, padding: '4px 10px',
    boxShadow: active ? neoShadow(2) : neoShadow(3),
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
        ':root {',
        '  --mihome-bg: #e9ecf3; --mihome-card: #eef1f6; --mihome-text: #3d4356; --mihome-muted: #8f96a8; --mihome-line: #d7dbe6; --mihome-sheet: #f4f6fa;',
        '  --mihome-shadow-a: rgba(163, 170, 190, 0.42); --mihome-shadow-b: rgba(255, 255, 255, 0.95);',
        '  --mihome-inset-a: rgba(163, 170, 190, 0.45); --mihome-inset-b: rgba(255, 255, 255, 0.95);',
        '}',
        '@media (prefers-color-scheme: dark) {',
        '  :root {',
        '    --mihome-bg: #1a2026; --mihome-card: #242b33; --mihome-text: #e6e9ee; --mihome-muted: #8b93a1; --mihome-line: #2c343d; --mihome-sheet: #1f262d;',
        '    --mihome-shadow-a: rgba(0, 0, 0, 0.55); --mihome-shadow-b: rgba(255, 255, 255, 0.06);',
        '    --mihome-inset-a: rgba(0, 0, 0, 0.50); --mihome-inset-b: rgba(255, 255, 255, 0.05);',
        '  }',
        '}',
        '.mihome-card { transition: box-shadow .15s ease, transform .15s ease; }',
        '.mihome-card:hover { transform: translateY(-2px); box-shadow: 9px 9px 20px var(--mihome-shadow-a), -9px -9px 20px var(--mihome-shadow-b); }',
        '.mihome-hero { animation: mihome-pop .28s ease both; }',
        '@keyframes mihome-pop { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }',
      ].join('\n')
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }, 'dsh-mihome.styles')
  }

  ctx.uiConversation.events.register(dashboardDefinition)
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

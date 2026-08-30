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
}

interface ConsoleBody {
  ok?: boolean
  snapshot?: DashboardSnapshot
  health?: ConsoleState['health']
  error?: string
}

function useConsoleState(tick: number): ConsoleState | null {
  const [state, setState] = useState<ConsoleState | null>(null)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/dsh-mihome/state')
        const body = (await res.json()) as ConsoleBody
        if (cancelled) return
        setState({
          ok: body.ok === true,
          snapshot: body.snapshot ?? null,
          health: body.health ?? null,
          error: body.error,
          at: Date.now(),
        })
      } catch (err) {
        if (!cancelled) {
          setState({ ok: false, snapshot: null, health: null, error: String(err), at: Date.now() })
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
function DeviceCard({ device }: { device: DashboardDevice }): ReactNode {
  const dot = stateDot(device)
  const props = Object.entries(device.props ?? {})
    .filter(([key]) => key !== 'power')
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${fmtPropValue(key, value)}`)
  const power = device.props.power
  const on = power === 1 || power === '1' || power === 'on' || power === true
  return createElement('div', {
    style: {
      background: COLORS.card,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 10,
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 4,
    },
  },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('span', { style: { fontSize: 16 } }, iconFor(device)),
      createElement('span', {
        style: { flex: 1, color: COLORS.text, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, device.name || device.did),
      createElement('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
        createElement('span', {
          style: { fontSize: 11, color: device.online ? (on ? COLORS.on : COLORS.muted) : COLORS.danger },
        }, device.online ? (on ? 'on' : 'off') : '离线'),
        createElement('span', { style: { width: 7, height: 7, borderRadius: '50%', background: dot.color } }),
      ),
    ),
    createElement('div', {
      style: { color: COLORS.muted, fontSize: 12, lineHeight: 1.5, minHeight: 18 },
    }, props.length > 0 ? props.join(' · ') : (device.online ? '—' : '设备离线')),
    createElement('div', { style: { color: COLORS.muted, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace' } },
      device.model),
  )
}

// ---------------------------------------------------------------------------
// Mi Home view (replaces the chat area while active; lives in the top view
// ring as a "🏠 米家" tab, so sidebar and header stay untouched)
// ---------------------------------------------------------------------------
function MihomeView(): ReactNode {
  const [tick, setTick] = useState(0)
  const state = useConsoleState(tick)
  const snapshot = state?.snapshot ?? null
  const groups = snapshot ? groupDevices(snapshot.devices) : []
  const onlineCount = snapshot ? snapshot.devices.filter(d => d.online).length : 0

  return createElement('div', {
    style: {
      height: '100%', overflowY: 'auto', background: '#0e1013',
      fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
    },
  },
    createElement('div', { style: { maxWidth: 1100, margin: '0 auto', padding: '20px 24px 40px' } },
      // Top bar
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 } },
        createElement('span', { style: { fontSize: 20 } }, '🏠'),
        createElement('span', { style: { color: COLORS.text, fontSize: 18, fontWeight: 700 } }, '米家控制台'),
        createElement('span', { style: { color: COLORS.muted, fontSize: 12, flex: 1 } },
          state
            ? (state.health
                ? `${state.health.account ?? '...'} · 区域 ${state.health.region ?? 'cn'} · ${state.health.homes ?? 0} 家庭 / ${state.health.devices ?? 0} 设备 · 更新于 ${shortTime(new Date(state.at).toISOString())}`
                : '加载中…')
            : '加载中…'),
        createElement('button', {
          onClick: () => setTick(t => t + 1),
          style: {
            height: 30, padding: '0 12px', borderRadius: 8,
            background: 'transparent', border: `1px solid ${COLORS.border}`,
            color: COLORS.text, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
          },
        }, '↻ 刷新'),
      ),
      // Connection problem
      ...(state && !state.ok ? [
        createElement('div', {
          key: 'err',
          style: {
            background: 'rgba(248, 113, 113, 0.08)', border: '1px solid rgba(248, 113, 113, 0.4)',
            borderRadius: 10, padding: '10px 14px', color: COLORS.danger, fontSize: 13, marginBottom: 12,
          },
        }, `连接米家失败：${state.error ?? '未知错误'}`),
      ] : []),
      // Rooms
      ...(snapshot && snapshot.rooms.length > 0 ? [
        createElement('div', {
          key: 'rooms', style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 },
        },
          ...snapshot.rooms.map(room =>
            createElement('span', {
              key: room.room_id,
              style: {
                fontSize: 12, color: COLORS.text, background: COLORS.card,
                border: `1px solid ${COLORS.border}`, borderRadius: 99, padding: '4px 12px',
              },
            }, `🏠 ${room.name}`)),
        ),
      ] : []),
      // Summary line
      ...(snapshot ? [
        createElement('div', {
          key: 'summary',
          style: { color: COLORS.muted, fontSize: 12, marginBottom: 14 },
        }, `${snapshot.devices.length} 台设备（${onlineCount} 在线）· 每 3 秒自动刷新 · 控制请回聊天用 mi_turn / mi_control（需人工审批）`),
      ] : []),
      // Device groups
      ...groups.map(group =>
        createElement('div', { key: group.title, style: { marginBottom: 18 } },
          createElement('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 8, fontWeight: 600 } }, group.title),
          createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 8 } },
            ...group.items.map(device => createElement(DeviceCard, { key: device.did, device })),
          ),
        ),
      ),
      // Empty / waiting
      ...(!snapshot && !state ? [
        createElement('div', {
          key: 'loading', style: { color: COLORS.muted, fontSize: 13, padding: '40px 0', textAlign: 'center' },
        }, '正在连接米家…'),
      ] : []),
      ...(!snapshot && state ? [
        createElement('div', {
          key: 'empty',
          style: { color: COLORS.muted, fontSize: 13, padding: '40px 0', textAlign: 'center' },
        }, '暂无设备数据'),
      ] : []),
      // Recent events
      ...(snapshot && snapshot.events.length > 0 ? [
        createElement('div', {
          key: 'events', style: { marginTop: 8, paddingTop: 14, borderTop: `1px solid ${COLORS.border}` },
        },
          createElement('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 6, fontWeight: 600 } }, '🕐 最近变化'),
          ...snapshot.events.slice(0, 8).map((event, i) =>
            createElement('div', {
              key: i, style: { color: COLORS.muted, fontSize: 13, display: 'flex', gap: 8, padding: '2px 0' },
            },
              createElement('span', {}, '📌'),
              createElement('span', { style: { flex: 1 } },
                `${event.name}: ${event.changes.map(c => `${c[0]} ${c[1] ?? '—'} → ${c[2] ?? ''}`).join('，')}`),
              createElement('span', {}, shortTime(event.time)),
            ),
          ),
        ),
      ] : []),
    ),
  )
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
// Client plugin body
// ---------------------------------------------------------------------------
export function apply(ctx: ClientContext & Context): void {
  ctx.conversationEvents.register(dashboardDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'mihome-dashboard',
  }, DashboardView))
  // Fixed top entry in the session view ring: one click replaces the chat
  // area with the Mi Home console (sidebar + header stay; chat tab returns).
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'mihome',
    order: 5,
    label: '🏠 米家',
  }, MihomeView))
}

// Keep the type referenced so the augmentation stays part of the program.
export type { DashboardChatData }
export type { DashboardView as DashboardViewComponent }
export type { ReactNode }

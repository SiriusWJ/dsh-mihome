/**
 * Browser half of dsh-mihome: renders a pretty Mi Home dashboard card into
 * the conversation when `mi_dashboard` runs. Loaded by the Web Client's
 * module loader from the package's `dsh.client` manifest.
 */
import { createElement, type ReactNode } from 'react'
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

/** One highlight prop for the row: brightness → %, temp → °C, else raw. */
function highlightProp(props: Record<string, unknown>): { key: string; value: string } | null {
  const entries = Object.entries(props)
  if (entries.length === 0) return null
  const preferred = ['brightness', 'temperature', 'humidity', 'power_consumption', 'battery', 'state', 'aqi']
  for (const key of preferred) {
    if (key in props) {
      const v = fmtValue(props[key])
      const unit = key === 'brightness' ? '%' : key === 'temperature' ? '°C' : key === 'humidity' ? '%' : ''
      return { key, value: `${v}${unit}` }
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
// Dashboard card
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
}

// Keep the type referenced so the augmentation stays part of the program.
export type { DashboardChatData }
export type { DashboardView as DashboardViewComponent }
export type { ReactNode }

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
    className: 'mihome-card',
    style: {
      background: COLORS.card,
      border: `1px solid ${COLORS.border}`,
      borderRadius: 12,
      padding: '10px 12px',
      display: 'flex', flexDirection: 'column', gap: 4,
    },
  },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('span', {
        style: {
          fontSize: 16, width: 30, height: 30, flex: 'none',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(77, 124, 254, 0.10)', borderRadius: 8,
        },
      }, iconFor(device)),
      createElement('span', {
        style: { flex: 1, color: COLORS.text, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, device.name || device.did),
      createElement('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 99,
          fontSize: 11, fontWeight: 600, flex: 'none',
          color: device.online ? (on ? COLORS.on : COLORS.muted) : COLORS.danger,
          background: device.online ? (on ? 'rgba(110, 231, 183, 0.10)' : 'rgba(139, 147, 161, 0.10)') : 'rgba(248, 113, 113, 0.10)',
        },
      }, device.online ? (on ? 'on' : 'off') : '离线'),
    ),
    createElement('div', {
      style: { color: COLORS.muted, fontSize: 12, lineHeight: 1.5, minHeight: 18 },
    }, props.length > 0 ? props.join(' · ') : (device.online ? '—' : '设备离线')),
    createElement('div', {
      style: { color: COLORS.muted, fontSize: 11, fontFamily: 'ui-monospace, Menlo, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    }, device.model),
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
  const notConnected = state !== null && !state.ok
  const loading = state === null

  const pill = snapshot
    ? {
        text: `● ${onlineCount}/${snapshot.devices.length} 在线`,
        color: onlineCount > 0 ? COLORS.on : COLORS.muted,
        bg: onlineCount > 0 ? 'rgba(110, 231, 183, 0.10)' : 'rgba(139, 147, 161, 0.10)',
      }
    : notConnected
      ? { text: '未连接', color: COLORS.danger, bg: 'rgba(248, 113, 113, 0.10)' }
      : { text: '连接中…', color: COLORS.warn, bg: 'rgba(251, 191, 36, 0.10)' }

  return createElement('div', {
    style: {
      height: '100%', overflowY: 'auto',
      background: 'linear-gradient(180deg, #0e1013 0%, #12151a 100%)',
      fontFamily: 'system-ui, -apple-system, "PingFang SC", sans-serif',
    },
  },
    createElement('div', { style: { maxWidth: 1100, margin: '0 auto', padding: '22px 24px 40px' } },
      // Top bar
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 } },
        createElement('span', { style: { fontSize: 20 } }, '🏠'),
        createElement('span', { style: { color: COLORS.text, fontSize: 18, fontWeight: 700 } }, '米家控制台'),
        createElement('span', {
          style: {
            padding: '2px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600,
            color: pill.color, background: pill.bg,
          },
        }, pill.text),
        createElement('span', { style: { color: COLORS.muted, fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          state && !notConnected
            ? (state.health
                ? `${state.health.account ?? '...'} · 区域 ${state.health.region ?? 'cn'} · ${state.health.homes ?? 0} 家庭 / ${state.health.devices ?? 0} 设备 · ${shortTime(new Date(state.at).toISOString())}`
                : '')
            : ''),
        createElement('button', {
          onClick: () => setTick(t => t + 1),
          style: {
            height: 30, padding: '0 12px', borderRadius: 8,
            background: 'transparent', border: `1px solid ${COLORS.border}`,
            color: COLORS.text, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
          },
        }, '↻ 刷新'),
      ),
      // Not connected: friendly onboarding hero
      ...(notConnected ? [
        createElement('div', {
          key: 'hero', className: 'mihome-hero',
          style: {
            maxWidth: 520, margin: '48px auto 0', textAlign: 'center',
            background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 18,
            padding: '36px 28px', display: 'flex', flexDirection: 'column', gap: 10,
          },
        },
          createElement('div', { style: { fontSize: 44 } }, '🏠'),
          createElement('div', { style: { color: COLORS.text, fontSize: 18, fontWeight: 700 } }, '米家还没有连接'),
          createElement('div', { style: { color: COLORS.muted, fontSize: 13, lineHeight: 1.7 } }, '两步接入你的米家设备：'),
          createElement('div', {
            style: {
              textAlign: 'left', background: '#101318', border: `1px solid ${COLORS.border}`,
              borderRadius: 10, padding: '12px 14px', margin: '6px 0 2px',
              display: 'flex', flexDirection: 'column', gap: 6,
            },
          },
            createElement('div', { style: { color: COLORS.text, fontSize: 13 } }, '① 打开 DSH 设置 → 米家登录'),
            createElement('div', { style: { color: COLORS.text, fontSize: 13 } }, '② 生成二维码，用米家 App 扫一扫并确认'),
            createElement('div', { style: { color: COLORS.muted, fontSize: 12, lineHeight: 1.6 } },
              '登录成功后会保存会话，本页自动显示房间、设备与最近变化。'),
          ),
          ...(state?.error ? [
            createElement('div', {
              key: 'why', style: { color: COLORS.muted, fontSize: 12, wordBreak: 'break-all', lineHeight: 1.6 },
            }, `原因：${state.error}`),
          ] : []),
          createElement('button', {
            onClick: () => setTick(t => t + 1),
            style: {
              alignSelf: 'center', marginTop: 6, height: 32, padding: '0 16px', borderRadius: 8,
              background: 'rgba(77, 124, 254, 0.15)', border: `1px solid ${COLORS.accent}`,
              color: COLORS.accent, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
            },
          }, '↻ 重新检查'),
        ),
      ] : []),
      // Loading skeleton
      ...(loading ? [
        createElement('div', {
          key: 'skeleton',
          style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 8 },
        },
          ...Array.from({ length: 6 }, (_, i) =>
            createElement('div', {
              key: i,
              style: {
                background: COLORS.card, border: `1px dashed ${COLORS.border}`, borderRadius: 12, height: 74,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: COLORS.off, fontSize: 12,
              },
            }, '连接中…')),
        ),
      ] : []),
      // Connected content
      ...(!loading && !notConnected && snapshot ? [
        // Rooms
        ...(snapshot.rooms.length > 0 ? [
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
        createElement('div', {
          key: 'summary',
          style: { color: COLORS.muted, fontSize: 12, marginBottom: 14 },
        }, `${snapshot.devices.length} 台设备（${onlineCount} 在线）· 每 3 秒自动刷新 · 控制请回聊天用 mi_turn / mi_control（需人工审批）`),
        // Device groups
        ...groups.map(group =>
          createElement('div', { key: group.title, style: { marginBottom: 18 } },
            createElement('div', { style: { color: COLORS.muted, fontSize: 12, marginBottom: 8, fontWeight: 600 } }, group.title),
            createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 8 } },
              ...group.items.map(device => createElement(DeviceCard, { key: device.did, device })),
            ),
          ),
        ),
        // Recent events
        ...(snapshot.events.length > 0 ? [
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
        '.mihome-card { transition: transform .12s ease, border-color .12s ease; }',
        '.mihome-card:hover { transform: translateY(-1px); border-color: #4d7cfe66; }',
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

/**
 * Shared dashboard snapshot contract between the host tool (`mi_dashboard`)
 * and the browser client node. Type-only — the client bundle imports it for
 * types only; the marker literal is duplicated deliberately so neither side
 * needs a runtime import of the other.
 */

/** Marker carried on `tool/result` meta to identify a dashboard snapshot. */
export const DASHBOARD_META_KIND = 'mihome-dashboard' as const

/** One device in the dashboard snapshot. */
export type DashboardDevice = {
  did: string
  name: string
  model: string
  online: boolean
  category: string
  props: Record<string, unknown>
}

/** One room chip in the dashboard snapshot. */
export type DashboardRoom = {
  room_id: number
  name: string
}

/** One recent change in the dashboard snapshot. */
export type DashboardEvent = {
  did: string
  name: string
  changes: Array<[string, unknown, unknown]>
  time: string
}

/** Full dashboard snapshot persisted on the `tool/result` meta. */
export type DashboardSnapshot = {
  kind: typeof DASHBOARD_META_KIND
  generatedAt: string
  homes: Array<{ home_id: number; name: string }>
  rooms: DashboardRoom[]
  devices: DashboardDevice[]
  events: DashboardEvent[]
  /** Present when Mi Home is not reachable — the card renders a friendly offline state. */
  error?: string
}

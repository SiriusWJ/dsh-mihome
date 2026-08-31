import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Mi Cloud region: cn | de | ru | us | tw | sg | in | … */
  region: string
  /** Xiaomi account username (fallback: usernameEnv). */
  username: string
  /** Environment variable holding the username. */
  usernameEnv: string
  /** Xiaomi account password (fallback: passwordEnv). */
  password: string
  /** Environment variable holding the password. */
  passwordEnv: string
  /** Request timeout in milliseconds. */
  timeoutMs: number
  /** Require human approval before state-changing calls (mi_control, mi_turn). */
  requireApproval: boolean
  /** Allowlist of device categories that may be controlled; empty = every category. */
  allowedCategories: string[]
  /** Devices whose props are fetched for a dashboard snapshot (upper bound). */
  dashboardPropsLimit: number
  /** Resident host service refresh interval (ms). */
  serviceRefreshMs: number
  /** Rolling size of the in-memory change buffer shown as "recent changes". */
  recentBufferSize: number
}

export const Config: Schema<Config> = Schema.object({
  region: Schema.string()
    .description('Mi Cloud region, e.g. cn, de, ru, us, tw, sg, in')
    .default('cn'),
  username: Schema.string()
    .description('Xiaomi account username (do not use when usernameEnv is available)')
    .default(''),
  usernameEnv: Schema.string()
    .description('Environment variable holding the username')
    .default('MIHOME_USERNAME'),
  password: Schema.string()
    .description('Xiaomi account password (do not use when passwordEnv is available)')
    .default(''),
  passwordEnv: Schema.string()
    .description('Environment variable holding the password')
    .default('MIHOME_PASSWORD'),
  timeoutMs: Schema.number()
    .description('Request timeout in milliseconds')
    .default(15000),
  requireApproval: Schema.boolean()
    .description('Require human approval before state-changing calls')
    .default(true),
  allowedCategories: Schema.array(Schema.string())
    .description('Allowed device categories to control (light, outlet, climate, …); empty allows every category')
    .default([]),
  dashboardPropsLimit: Schema.number()
    .description('Devices whose props are fetched for a dashboard snapshot')
    .default(30),
  serviceRefreshMs: Schema.number()
    .description('Resident host service refresh interval (ms); homes/devices/props are mirrored in memory')
    .default(20000),
  recentBufferSize: Schema.number()
    .description('Rolling size of the recent-change buffer')
    .default(50),
})

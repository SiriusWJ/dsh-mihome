import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config as ConfigSchema, type Config } from './config'
import { MiCloudClient, DemoMiClient, categoryOf, type MiClient } from './mi'
import { QrLoginManager, QrSessionStore } from './qr'
import { registerTools, cachedDevices, ChangeBuffer, buildDashboardSnapshot } from './tools'

export const name = 'dsh-mihome'
export const inject = ['tools']

export { ConfigSchema as Config }

/** Tools that change (or can be abused to change) Mi Home device state. */
const SENSITIVE_TOOLS = new Set(['mi_control', 'mi_turn'])

/** Structural view of the optional credentials seam (see @deepseek-ai/dsh-credentials). */
interface CredentialsService {
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
}

export function apply(ctx: Context, config: Config) {
  // Credentials resolved through the harness credential seam when present,
  // with the process environment as fallback. `usernameEnv`/`passwordEnv`
  // are credential references: POSIX environment-variable names resolved per
  // request, so rotated credentials reach the next call without a restart.
  const credentials = ctx.get('credentials') as CredentialsService | undefined
  const resolveCredential = (env: string): (() => Promise<string>) => () => {
    if (credentials) {
      const ref = credentialRef(env)
      return credentials.resolve(ref).then(hit => hit?.value ?? process.env[env] ?? '')
    }
    return Promise.resolve(process.env[env] ?? '')
  }
  const resolveUsername = resolveCredential(config.usernameEnv)
  const resolvePassword = resolveCredential(config.passwordEnv)

  // QR-login session storage under $DSH_HOME/plugin-data (works alongside
  // password credentials: the session wins until it expires).
  const sessionFile = join(
    process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    'plugin-data', 'dsh-mihome', 'session.json',
  )
  const sessionStore = new QrSessionStore(sessionFile)

  let qrManager: QrLoginManager | null = null

  const client: MiClient = config.mode === 'demo'
    ? new DemoMiClient(config.baseUrl, config.timeoutMs)
    : new MiCloudClient({
        region: config.region,
        timeoutMs: config.timeoutMs,
        resolveUsername,
        resolvePassword,
        sessionStore,
      })

  if (client instanceof MiCloudClient) {
    qrManager = new QrLoginManager(sessionStore, async (session) => {
      client.setSession({ userId: session.userId, serviceToken: session.serviceToken, ssecurity: session.ssecurity })
    })
    ctx.effect(() => () => qrManager?.dispose(), 'dsh-mihome.qr')
  }

  const changes = new ChangeBuffer(config.recentBufferSize)

  registerTools(ctx, client, config, changes)

  // Read-only state endpoint powering the full-screen Mi Home console in the
  // Web UI (header entry + shell.overlay). GET only — control stays on the
  // approval-gated tools, so this route cannot change anything.
  const webServer = ctx.get('webServer') as {
    register(route: {
      kind: string
      path: string
      handler: (req: unknown, res: {
        writeHead(status: number, headers?: Record<string, string>): void
        end(body?: string): void
      }) => void | Promise<void>
    }): () => void
  } | undefined
  if (webServer) {
    type JsonRes = {
      writeHead(status: number, headers?: Record<string, string>): void
      end(body?: string): void
    }
    const sendJson = (res: JsonRes, status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const sameOrigin = (req: unknown): boolean => {
      const headers = (req as { headers?: Record<string, unknown> })?.headers ?? {}
      const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin
      const host = Array.isArray(headers.host) ? headers.host[0] : headers.host
      if (!origin || origin === 'null') return true
      if (!host) return false
      try {
        return new URL(String(origin)).host === String(host)
      } catch {
        return false
      }
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-mihome/state',
      handler: async (_req, res) => {
        try {
          const [snapshot, health] = await Promise.all([
            buildDashboardSnapshot(client, config, changes),
            client.health(),
          ])
          sendJson(res, 200, { ok: true, snapshot, health })
        } catch (err) {
          sendJson(res, 200, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    }), 'dsh-mihome.web')
    // The state route could also feed the QR login status page; register the
    // auth surface next to it. All auth routes are same-origin guarded.

    // Auth routes are registered in BOTH modes so the settings page always
    // finds them; demo mode answers with a friendly hint instead of starting
    // QR against the cloud.
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-mihome/auth/status',
      handler: async (req, res) => {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        const stored = await sessionStore.load()
        sendJson(res, 200, {
          ok: true,
          mode: config.mode,
          stored: stored !== null,
          username: config.username || '',
          state: qrManager?.state ?? { phase: 'idle', message: '演示模式', expiresAt: null },
        })
      },
    }), 'dsh-mihome.auth.status')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-mihome/auth/qr',
      handler: async (req, res) => {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        if (!qrManager || config.mode !== 'cloud') {
          sendJson(res, 200, {
            ok: false,
            error: '演示模式无需登录：把配置里的 mode 改为 cloud 后再扫码。',
            state: { phase: 'idle', message: '演示模式', expiresAt: null },
          })
          return
        }
        const result = await qrManager.start()
        if ('error' in result) {
          sendJson(res, 200, { ok: false, error: result.error, state: qrManager.state })
        } else {
          sendJson(res, 200, { ok: true, qr: result.qr, state: result.state })
        }
      },
    }), 'dsh-mihome.auth.qr')

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-mihome/auth/logout',
      handler: async (req, res) => {
        if (!sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
          return
        }
        await sessionStore.clear()
        if (client instanceof MiCloudClient) client.clearSession()
        sendJson(res, 200, { ok: true })
      },
    }), 'dsh-mihome.auth.logout')
  }

  // Approval + category-allowlist policy on the tools/pre-execute waterfall.
  // `ask` pauses the call until a human approves through the approval seam.
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    if (!exec.name.startsWith('mi_')) return next()

    // Deny control calls on categories outside the configured allowlist.
    if (SENSITIVE_TOOLS.has(exec.name) && config.allowedCategories.length > 0) {
      const args = exec.arguments as { deviceId?: unknown } | undefined
      const deviceId = typeof args?.deviceId === 'string' ? args.deviceId : undefined
      if (deviceId) {
        try {
          const { devices } = await cachedDevices(client)
          const dev = devices.find(d => d.did === deviceId)
          if (!dev || !config.allowedCategories.includes(categoryOf(dev.model))) {
            return {
              kind: 'deny',
              reason: `dsh-mihome: 设备 ${deviceId} 的类别不在 allowedCategories（${config.allowedCategories.join(', ')}）内。`,
            }
          }
        } catch {
          return {
            kind: 'deny',
            reason: 'dsh-mihome: 无法解析设备类别（设备列表获取失败），已按最小权限拒绝。',
          }
        }
      }
    }

    // Require human approval for state-changing calls unless disabled.
    if (config.requireApproval && SENSITIVE_TOOLS.has(exec.name)) {
      return {
        kind: 'ask',
        reason: `dsh-mihome: "${exec.name}" 会改变米家设备状态 — 请批准后继续。`,
      }
    }

    return next()
  })
}

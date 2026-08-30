import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialRef, type ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { Config as ConfigSchema, type Config } from './config'
import { MiCloudClient, DemoMiClient, categoryOf, type MiClient } from './mi'
import { registerTools, cachedDevices, ChangeBuffer } from './tools'

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

  const client: MiClient = config.mode === 'demo'
    ? new DemoMiClient(config.baseUrl, config.timeoutMs)
    : new MiCloudClient({
        region: config.region,
        timeoutMs: config.timeoutMs,
        resolveUsername,
        resolvePassword,
      })

  const changes = new ChangeBuffer(config.recentBufferSize)

  registerTools(ctx, client, config, changes)

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

/**
 * Mi Home QR-code login (米家 App 扫码) for the dsh-mihome settings page.
 *
 * Mirrors the community-proven QrCodeXiaomiCloudConnector flow
 * (Xiaomi-cloud-tokens-extractor):
 *
 *   1. GET  https://account.xiaomi.com/longPolling/loginUrl  → JSONP
 *      (strip the `&&&START&&&` prefix) with `qr`, `lp` (long-poll URL),
 *      `loginUrl` and `timeout` (seconds).
 *   2. GET  `qr`                               → PNG bytes.
 *   3. GET  `lp` repeatedly until a 200        → body JSON containing
 *      `userId`, `ssecurity`, `cUserId`, `passToken`, `location`.
 *   4. GET  `location` (STS)                   → sets `serviceToken` cookie.
 *
 * The resulting session { userId, serviceToken, ssecurity } is persisted
 * through a {@link QrSessionStore} so the cloud client can reuse it until
 * it expires (then the client clears it and falls back to password login).
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { generateAgent } from './mi'

const AGENT = generateAgent()
const LOGIN_URL = 'https://account.xiaomi.com/longPolling/loginUrl'

export interface QrSession {
  userId: string
  serviceToken: string
  ssecurity: string
  cUserId?: string
  savedAt: string
}

export type QrPhase = 'idle' | 'waiting' | 'scanned' | 'ok' | 'expired' | 'failed'

export interface QrState {
  phase: QrPhase
  message: string
  expiresAt: number | null
}

/** Strip the `&&&START&&&` JSONP prefix Xiaomi wraps responses in. */
export function stripJsonpPrefix(text: string): string {
  const start = text.indexOf('{')
  return start >= 0 ? text.slice(start) : text
}

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(stripJsonpPrefix(text)) as Record<string, unknown>
}

function pickCookie(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of headers.getSetCookie()) {
    const first = line.split(';')[0] ?? ''
    const index = first.indexOf('=')
    if (index > 0) out[first.slice(0, index).trim()] = first.slice(index + 1).trim()
  }
  return out
}

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

export class QrSessionStore {
  constructor(private readonly file: string) {}

  async load(): Promise<QrSession | null> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const data = JSON.parse(raw) as Partial<QrSession>
      if (data.userId && data.serviceToken && data.ssecurity) {
        return data as QrSession
      }
      return null
    } catch {
      return null
    }
  }

  async save(session: QrSession): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, JSON.stringify(session, null, 2), 'utf8')
  }

  async clear(): Promise<void> {
    try {
      await rm(this.file, { force: true })
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// QR login manager (one flow at a time)
// ---------------------------------------------------------------------------

export class QrLoginManager {
  state: QrState = { phase: 'idle', message: '', expiresAt: null }
  private pollUrl: string | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private deadline = 0
  private disposed = false

  constructor(
    private readonly store: QrSessionStore,
    private readonly onSession: (session: QrSession) => void | Promise<void>,
  ) {}

  private setState(phase: QrPhase, message?: string): void {
    this.state = {
      phase,
      message: message ?? this.state.message,
      expiresAt: this.deadline || null,
    }
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.pollUrl = null
  }

  dispose(): void {
    this.disposed = true
    this.stopPoll()
  }

  /** Start a new QR flow. Returns the data-URL of the QR image. */
  async start(): Promise<{ qr: string; state: QrState } | { error: string }> {
    this.stopPoll()
    this.setState('idle', '正在请求二维码…')

    const params = new URLSearchParams({
      _qrsize: '480',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      callback: 'https://sts.api.io.mi.com/sts',
      _hasLogo: 'false',
      sid: 'xiaomiio',
      serviceParam: '',
      _locale: 'en_GB',
      _dc: String(Date.now()),
    })
    let res: Response
    try {
      res = await fetch(`${LOGIN_URL}?${params.toString()}`, {
        headers: { 'User-Agent': AGENT },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setState('failed', `无法连接米家登录服务：${message}`)
      return { error: this.state.message }
    }
    if (res.status !== 200) {
      this.setState('failed', `loginUrl status ${res.status}`)
      return { error: this.state.message }
    }
    let body: Record<string, unknown>
    try {
      body = parseJson(await res.text())
    } catch {
      this.setState('failed', 'loginUrl 响应解析失败')
      return { error: this.state.message }
    }
    if (body.code !== 0 || typeof body.qr !== 'string' || typeof body.lp !== 'string') {
      this.setState('failed', `loginUrl 响应异常（code=${String(body.code ?? '?')}）`)
      return { error: this.state.message }
    }

    let image: Response
    try {
      image = await fetch(body.qr as string, {
        headers: { 'User-Agent': AGENT },
        signal: AbortSignal.timeout(15_000),
      })
    } catch {
      this.setState('failed', '二维码图片下载失败')
      return { error: this.state.message }
    }
    if (!image.ok) {
      this.setState('failed', `二维码图片 status ${image.status}`)
      return { error: this.state.message }
    }
    const buf = Buffer.from(await image.arrayBuffer())

    const timeoutSeconds = Number(body.timeout ?? 300)
    this.pollUrl = body.lp as string
    this.deadline = Date.now() + timeoutSeconds * 1000
    this.setState('waiting', `请用米家 App 扫描二维码（${timeoutSeconds} 秒内有效）`)
    this.schedulePoll(500)
    return { qr: `data:image/png;base64,${buf.toString('base64')}`, state: this.state }
  }

  private schedulePoll(delayMs: number): void {
    if (this.disposed || !this.pollUrl) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.pollOnce()
    }, delayMs)
  }

  private async pollOnce(): Promise<void> {
    if (this.disposed || !this.pollUrl) return
    if (Date.now() > this.deadline) {
      this.setState('expired', '二维码已过期，请重新生成')
      this.stopPoll()
      return
    }
    try {
      const res = await fetch(this.pollUrl, {
        headers: { 'User-Agent': AGENT },
        signal: AbortSignal.timeout(12_000),
      })
      if (res.status === 200) {
        const body = parseJson(await res.text())
        const location = body.location
        if (typeof location === 'string' && location) {
          await this.finish(location, body)
          return
        }
        if (body.code !== undefined && body.code !== 0 && body.code !== 204) {
          const desc = String(body.desc ?? body.description ?? '')
          if (/过期|expire|timeout|invalid/i.test(desc)) {
            this.setState('expired', desc || '二维码已过期')
            this.stopPoll()
            return
          }
        }
        // Still pending; distinguish "scanned, confirm on phone" when possible.
        this.setState('scanned', '已提交，请在米家 App 上确认登录')
      }
      // else: keep polling (transient states) until the deadline.
    } catch {
      // network blip — keep polling; the deadline aborts the flow anyway.
    }
    this.schedulePoll(2000)
  }

  private async finish(location: string, body: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(location, {
        headers: { 'User-Agent': AGENT, 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status !== 200) {
        this.setState('failed', `STS status ${res.status}`)
        this.stopPoll()
        return
      }
      const cookies = pickCookie(res.headers)
      const serviceToken = cookies.serviceToken ?? cookies.yetAnotherServiceToken
      const ssecurity = typeof body.ssecurity === 'string' && body.ssecurity
        ? body.ssecurity
        : (cookies.ssecurity ?? '')
      const userId = String(body.userId ?? cookies.userId ?? cookies.cUserId ?? '')
      if (!serviceToken || !ssecurity || !userId) {
        this.setState('failed',
          `登录响应缺少凭证（serviceToken=${serviceToken ? '✓' : '✗'} ssecurity=${ssecurity ? '✓' : '✗'} userId=${userId ? '✓' : '✗'}）`)
        this.stopPoll()
        return
      }
      const session: QrSession = {
        userId,
        serviceToken,
        ssecurity,
        ...(typeof body.cUserId === 'string' && body.cUserId ? { cUserId: body.cUserId } : {}),
        savedAt: new Date().toISOString(),
      }
      await this.store.save(session)
      await this.onSession(session)
      this.setState('ok', '登录成功，会话已保存')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.setState('failed', `登录收尾失败：${message}`)
    }
    this.stopPoll()
  }
}

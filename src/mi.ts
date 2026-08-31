import { createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * Mi Home (米家) cloud client.
 *
 * Cloud path implements the community-documented Xiaomi Mi Home app API:
 *
 *   1. Login:  account.xiaomi.com/pass/serviceLogin → _sign (sid=xiaomiio)
 *              POST serviceLoginAuth2 (md5(password).toUpperCase() as `hash`)
 *              → `location` redirect → sts.api.io.mi.com sets the session
 *              cookies { userId, serviceToken, ssecurity }.
 *   2. API:    https://api.io.mi.com/app/<method>  (region-prefixed host)
 *              - v2/* methods use the ENCRYPTED channel: RC4-encrypted
 *                params, sha1 signature, `ssecurity`, `_nonce`, `_sessionId`
 *              - miIO/raw_command uses the PLAIN channel: hmac-sha256
 *                signature over [path, signed_nonce, nonce, data=...], plus
 *                data/signature/_nonce/ssecurity query fields.
 *
 * This mirrors the flow proven by Xiaomi-cloud-tokens-extractor and
 * python-miio's cloud extractor. The API is not officially documented and
 * may change without notice; errors are surfaced as clear messages.
 */

// ---------------------------------------------------------------------------
// Crypto helpers (RC4 is not exposed by Node's OpenSSL 3 default provider)
// ---------------------------------------------------------------------------

function rc4Core(key: Buffer, data: Buffer, drop: number): Buffer {
  // KSA
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff
    const t = s[i]!
    s[i] = s[j]!
    s[j] = t
  }
  // PRGA
  let i = 0
  j = 0
  const next = (): number => {
    i = (i + 1) & 0xff
    j = (j + s[i]!) & 0xff
    const t = s[i]!
    s[i] = s[j]!
    s[j] = t
    return s[(s[i]! + s[j]!) & 0xff]!
  }
  for (let k = 0; k < drop; k++) next()
  const out = Buffer.alloc(data.length)
  for (let k = 0; k < data.length; k++) out[k] = data[k]! ^ next()
  return out
}

/** Standard RC4 (test reference; classic vector compatibility). */
export function rc4(key: Buffer, data: Buffer): Buffer {
  return rc4Core(key, data, 0)
}

/**
 * RC4 as used by Xiaomi's cloud channel: the first 1024 keystream bytes are
 * discarded (RC4-drop-1024, matching `RC4.init1024()` from the actively
 * maintained al-one/hass-xiaomi-miot implementation — the plain-ARC4 variant
 * of the older extractors no longer decrypts current responses).
 */
export function rc4Drop1024(key: Buffer, data: Buffer): Buffer {
  return rc4Core(key, data, 1024)
}

/** base64 of sha256(concat(a, b)). */
function sha256ConcatB64(a: Buffer, b: Buffer): string {
  return createHash('sha256').update(Buffer.concat([a, b])).digest('base64')
}

// ---------------------------------------------------------------------------
// Signing primitives (exported for tests)
// ---------------------------------------------------------------------------

/** Random agent string used by the Mi Home app. */
export function generateAgent(): string {
  const rand = (n: number, lo: number, hi: number, table: number[]) =>
    Array.from({ length: n }, () => String.fromCharCode(lo + Math.floor(Math.random() * (hi - lo + 1)))).join('')
  return `${rand(18, 97, 122, [])}-${rand(13, 65, 69, [])} APP/com.xiaomi.mihome APPV/10.5.201`
}

/** B64 nonce: 8 random bytes + 4-byte BE minute slot. */
export function generateNonce(millis: number): string {
  const buf = Buffer.alloc(12)
  randomBytes(8).copy(buf, 0)
  buf.writeUInt32BE(Math.floor(millis / 60000), 8)
  return buf.toString('base64')
}

/** base64(sha256(base64(ssecurity) + base64(nonce))). */
export function signedNonce(nonce: string, ssecurity: string): string {
  return sha256ConcatB64(Buffer.from(ssecurity, 'base64'), Buffer.from(nonce, 'base64'))
}

/**
 * Plain-channel signature (miIO/*): hmac-sha256 over
 * [url path (leading slash), signedNonce, nonce, sorted k=v, ...] joined
 * with "&", key = base64(signedNonce) — matches the current micloud
 * `miutils.gen_signature` (al-one path); the older extractor variant with
 * the host-less `split('com')[1]` string is no longer accepted.
 */
export function generateSignature(url: string, signedNonce: string, nonce: string, params: Record<string, string>): string {
  const path = new URL(url).pathname
  const parts = [path, signedNonce, nonce]
  for (const [k, v] of Object.entries(params).sort(([a], [b]) => a.localeCompare(b))) parts.push(`${k}=${v}`)
  return createHmac('sha256', Buffer.from(signedNonce, 'base64'))
    .update(parts.join('&'))
    .digest('base64')
}

/**
 * Encrypted-channel signature: base64(sha1([METHOD, path (leading slash,
 * minus the /app prefix), k=v, ..., signedNonce] joined "&")) — matches the
 * actively maintained al-one/hass-xiaomi-miot `sha1_sign` (the older
 * extractors' `split('com')[1]` variant is no longer accepted).
 */
export function generateEncSignature(url: string, method: string, signedNonce: string, params: Record<string, string>): string {
  let path = new URL(url).pathname
  if (path.startsWith('/app/')) path = path.slice(4)
  const parts = [method.toUpperCase(), path, ...Object.entries(params).map(([k, v]) => `${k}=${v}`), signedNonce]
  return createHash('sha1').update(parts.join('&'), 'utf8').digest('base64')
}

export function encryptRc4(signedNonce: string, value: string): string {
  return rc4Drop1024(Buffer.from(signedNonce, 'base64'), Buffer.from(value, 'utf8')).toString('base64')
}

export function decryptRc4(signedNonce: string, value: string): string {
  return rc4Drop1024(Buffer.from(signedNonce, 'base64'), Buffer.from(value, 'base64')).toString('utf8')
}

// ---------------------------------------------------------------------------
// Device category mapping (model prefix → category)
// ---------------------------------------------------------------------------

export type DeviceCategory =
  | 'light' | 'outlet' | 'sensor' | 'climate' | 'media' | 'cleaning'
  | 'camera' | 'lock' | 'fan' | 'meter' | 'other'

const CATEGORY_RULES: Array<[DeviceCategory, RegExp]> = [
  ['light', /^(yeelink\.light|xiaomi\.light|mijia\.light|philips\.light|yeelight\.)/],
  ['outlet', /(plug\.|zimi\.plug|chunmi\.plug|chuangmi\.plug|mijia\.plug|hub\.)/],
  ['climate', /(aircondition|airconditioner|yeelink\.air)/],
  ['media', /(tv\.|xiaomi\.tv|mijia\.tv|speaker\.|soundbox)/],
  ['cleaning', /(vacuum|purifier|humidifier|washer|airer|scishare|dmaker\.w)/],
  ['camera', /(camera\.|chuangmi\.camera|xiaomi\.camera)/],
  ['lock', /(lock\.|loock|dabai\.|mijia\.lock)/],
  ['fan', /(fan\.|dmaker\.fan|zhimi\.fan)/],
  ['sensor', /(sensor\.|lumi\.sensor|lumi\.motion|mijia\.sensor|xiaomi\.scales|sensor_)/],
  ['meter', /(meter|energy|power|chunmi\.)/],
]

export function categoryOf(model: string): DeviceCategory {
  for (const [category, re] of CATEGORY_RULES) {
    if (re.test(model)) return category
  }
  return 'other'
}

const CATEGORY_PROPS: Record<DeviceCategory, string[]> = {
  light: ['power', 'brightness', 'color_temp'],
  outlet: ['power', 'power_consumption', 'temperature'],
  sensor: ['temperature', 'humidity', 'battery'],
  climate: ['power', 'target_temperature', 'mode'],
  media: ['power', 'volume'],
  cleaning: ['state', 'battery', 'filter_life_remaining'],
  camera: ['power', 'state'],
  lock: ['state', 'battery'],
  fan: ['power', 'speed'],
  meter: ['power_consumption', 'temperature'],
  other: ['power'],
}

/** Common property names to try, per category (miIO `get_prop`). */
export function propsForCategory(category: DeviceCategory): string[] {
  return CATEGORY_PROPS[category]
}

// ---------------------------------------------------------------------------
// Shared client interface
// ---------------------------------------------------------------------------

export interface HomeInfo {
  home_id: number
  name: string
  owner_id: number
  rooms: Array<{ room_id: number; name: string; dids?: string[] }>
}

export interface DeviceInfo {
  did: string
  name: string
  model: string
  online: boolean
  room_id?: number
}

export interface ChangeEvent {
  did: string
  name: string
  changes: Array<[string, unknown, unknown]>
  time: string
}

export interface MiClient {
  health(): Promise<{ ok: boolean; account: string; region: string; homes: number; devices: number }>
  getHomes(): Promise<HomeInfo[]>
  getDevices(homeId: number, ownerId: number): Promise<DeviceInfo[]>
  /** Returns raw `result` of `miIO/raw_command` (any method). */
  rawCommand(did: string, method: string, params: unknown[]): Promise<unknown>
  /** Convenience: read props of one device (miIO get_prop). */
  getProps(did: string, props: string[]): Promise<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Cloud client (login + signed api.io.mi.com calls)
// ---------------------------------------------------------------------------

interface Session {
  userId: string
  serviceToken: string
  ssecurity: string
}

function parseSetCookie(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of headers.getSetCookie()) {
    const first = line.split(';')[0]!
    const idx = first.indexOf('=')
    if (idx > 0) out[first.slice(0, idx).trim()] = first.slice(idx + 1).trim()
  }
  return out
}

function cookieHeader(session: Session): string {
  const parts = [
    `userId=${session.userId}`,
    `serviceToken=${session.serviceToken}`,
    `yetAnotherServiceToken=${session.serviceToken}`,
    `ssecurity=${session.ssecurity}`,
    'locale=en_GB',
    'timezone=Asia/Shanghai',
  ]
  return parts.join('; ')
}

export class MiCloudClient implements MiClient {
  private session: Session | null = null
  private readonly agent = generateAgent()
  private readonly base: string

  constructor(
    private readonly opts: {
      region: string
      timeoutMs: number
      resolveUsername: () => Promise<string>
      resolvePassword: () => Promise<string>
      /** Optional QR-login session persistence (used before password login). */
      sessionStore?: {
        load(): Promise<{ userId: string; serviceToken: string; ssecurity: string } | null>
        clear(): Promise<void>
      }
    },
  ) {
    const region = opts.region === 'cn' ? '' : `${opts.region}.`
    this.base = `https://${region}api.io.mi.com/app`
  }

  /** Adopt a freshly obtained session (e.g. right after QR login). */
  setSession(session: { userId: string; serviceToken: string; ssecurity: string }): void {
    this.session = { userId: session.userId, serviceToken: session.serviceToken, ssecurity: session.ssecurity }
  }

  clearSession(): void {
    this.session = null
  }

  /** Full login flow. Records the session used by all API calls. */
  async login(): Promise<Session> {
    const username = await this.opts.resolveUsername()
    const password = await this.opts.resolvePassword()
    if (!username || !password) {
      throw new Error('dsh-mihome: 未配置米家账号（MIHOME_USERNAME / MIHOME_PASSWORD，或 config.username/password）—— 也可以在 DSH 设置 → 米家 中扫码登录，会话会自动保存。')
    }

    // Step 1: obtain `_sign` for sid=xiaomiio
    const r1 = await fetch('https://account.xiaomi.com/pass/serviceLogin?sid=xiaomiio&_json=true', {
      headers: { 'User-Agent': this.agent },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    })
    if (r1.status !== 200) throw new Error(`dsh-mihome: serviceLogin status ${r1.status}`)
    const j1 = (await r1.json()) as { _sign?: string; code?: number; desc?: string }
    const sign = j1._sign
    if (!sign) throw new Error(`dsh-mihome: serviceLogin no _sign (code=${j1.code} desc=${j1.desc ?? 'unknown'})`)

    // Step 2: POST serviceLoginAuth2 (form fields go in the query string, as
    // the Mi Home app does), no redirects.
    const fields: Record<string, string> = {
      sid: 'xiaomiio',
      hash: createHash('md5').update(password, 'utf8').digest('hex').toUpperCase(),
      callback: 'https://sts.api.io.mi.com/sts',
      qs: '%3Fsid%3Dxiaomiio%26_json%3Dtrue',
      user: username,
      _sign: sign,
      _json: 'true',
    }
    const qs = new URLSearchParams(fields).toString()
    const r2 = await fetch(`https://account.xiaomi.com/pass/serviceLoginAuth2?${qs}`, {
      method: 'POST',
      headers: { 'User-Agent': this.agent, 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    })
    const text2 = await r2.text()
    if (r2.status !== 200) throw new Error(`dsh-mihome: serviceLoginAuth2 status ${r2.status}: ${text2.slice(0, 200)}`)
    let j2: Record<string, unknown>
    try {
      j2 = JSON.parse(text2) as Record<string, unknown>
    } catch {
      throw new Error(`dsh-mihome: serviceLoginAuth2 unexpected response: ${text2.slice(0, 200)}`)
    }
    if (j2.code !== 0 || typeof j2.location !== 'string') {
      const code = j2.code
      const desc = String(j2.desc ?? j2.result ?? 'unknown')
      throw new Error(
        `dsh-mihome: 米家登录失败 (code=${code} desc=${desc})` +
          (code === 700 || code === 6100 || /验证码|captcha|security/i.test(desc)
            ? ' —— 该账号需要验证码/2FA，当前版本请改用无 2FA 的账号或从米家 App 获取会话'
            : ''),
      )
    }

    // Step 3: follow the location redirect to STS; it sets serviceToken,
    // ssecurity and userId cookies.
    const r3 = await fetch(j2.location as string, {
      headers: { 'User-Agent': this.agent },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    })
    if (r3.status !== 200) throw new Error(`dsh-mihome: STS redirect status ${r3.status}`)
    const cookies = parseSetCookie(r3.headers)
    const serviceToken = cookies.serviceToken ?? cookies.yetAnotherServiceToken
    const ssecurity = cookies.ssecurity
    const userId = cookies.userId ?? cookies.cUserId ?? String(j2.userId ?? '')
    if (!serviceToken || !ssecurity || !userId) {
      throw new Error('dsh-mihome: 登录成功但未取得会话凭证（serviceToken/ssecurity/userId 缺失）')
    }
    this.session = { userId, serviceToken, ssecurity }
    return this.session
  }

  private async sessionOrThrow(): Promise<Session> {
    if (this.session) return this.session
    // QR-login session persisted by the settings flow, if present.
    if (this.opts.sessionStore) {
      const stored = await this.opts.sessionStore.load()
      if (stored) {
        this.session = {
          userId: stored.userId,
          serviceToken: stored.serviceToken,
          ssecurity: stored.ssecurity,
        }
        return this.session
      }
    }
    return this.login()
  }

  private apiUrl(method: string): string {
    return `${this.base}/${method}`
  }

  /** Plain-channel POST (miIO/*): hmac-sha256 signature, form body, plain JSON reply. */
  private async plain(method: string, payload: Record<string, unknown>, retry = true): Promise<Record<string, unknown>> {
    const session = await this.sessionOrThrow()
    const url = this.apiUrl(method)
    const millis = Date.now()
    const nonce = generateNonce(millis)
    const sNonce = signedNonce(nonce, session.ssecurity)
    const data = JSON.stringify(payload)
    const signature = generateSignature(url, sNonce, nonce, { data })
    const form = new URLSearchParams({
      data,
      signature,
      _nonce: nonce,
    }).toString()
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      headers: {
        'User-Agent': this.agent,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader(session),
      },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    })
    if (res.status !== 200) throw new Error(`dsh-mihome: ${method} status ${res.status}`)
    const json = (await res.json()) as Record<string, unknown>
    if (json.code === -1 && retry) {
      // Session expired (QR tokens do expire): drop it and let the retry
      // re-negotiate (stored QR session is cleared; password login follows).
      this.session = null
      await this.opts.sessionStore?.clear()
      return this.plain(method, payload, false)
    }
    if (json.code !== 0) {
      throw new Error(`dsh-mihome: ${method} failed (code=${json.code} message=${String(json.message ?? json.desc ?? '')})`)
    }
    return json
  }

  /** Encrypted-channel POST (v2/*): RC4 params, sha1 signature. */
  private async encrypted(method: string, payload: Record<string, unknown>, retry = true): Promise<Record<string, unknown>> {
    const session = await this.sessionOrThrow()
    const url = this.apiUrl(method)
    const millis = Date.now()
    const nonce = generateNonce(millis)
    const sNonce = signedNonce(nonce, session.ssecurity)
    const params: Record<string, string> = { data: JSON.stringify(payload) }

    const rc4Hash = generateEncSignature(url, 'POST', sNonce, params)
    params.rc4_hash__ = rc4Hash
    for (const key of Object.keys(params)) {
      params[key] = encryptRc4(sNonce, params[key]!)
    }
    params.signature = generateEncSignature(url, 'POST', sNonce, params)
    params.ssecurity = session.ssecurity
    params._nonce = nonce

    const qs = new URLSearchParams(params).toString()
    const res = await fetch(`${url}?${qs}`, {
      method: 'POST',
      headers: {
        'User-Agent': this.agent,
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-xiaomi-protocal-flag-cli': 'PROTOCAL-HTTP2',
        'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4',
        Cookie: cookieHeader(session),
      },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    })
    if (res.status !== 200) throw new Error(`dsh-mihome: ${method} status ${res.status}`)
    const body = await res.text()
    let json: Record<string, unknown>
    try {
      json = JSON.parse(decryptRc4(sNonce, body)) as Record<string, unknown>
    } catch {
      throw new Error(`dsh-mihome: ${method} 响应无法解密（登录态可能过期，请重试）`)
    }
    if (json.code === -1 && retry) {
      // Session expired: drop it and let the retry re-negotiate.
      this.session = null
      await this.opts.sessionStore?.clear()
      return this.encrypted(method, payload, false)
    }
    if (json.code !== 0) {
      throw new Error(`dsh-mihome: ${method} failed (code=${json.code} message=${String(json.message ?? json.desc ?? '')})`)
    }
    return json
  }

  async health() {
    let homes: HomeInfo[] = []
    try {
      homes = await this.getHomes()
    } catch {
      // Login or reachability problem: report as disconnected.
      return { ok: false, account: '', region: this.opts.region, homes: 0, devices: 0 }
    }
    let devices = 0
    if (homes[0]) {
      try {
        devices = (await this.getDevices(homes[0].home_id, homes[0].owner_id)).length
      } catch {
        devices = 0
      }
    }
    const username = await this.opts.resolveUsername()
    return { ok: true, account: username || 'mi-account', region: this.opts.region, homes: homes.length, devices }
  }

  async getHomes(): Promise<HomeInfo[]> {
    const json = await this.encrypted('v2/homeroom/gethome', {
      fg: true,
      fetch_share: true,
      fetch_share_dev: true,
      limit: 300,
      app_ver: 7,
    })
    const result = (json.result ?? {}) as Record<string, unknown>
    const list = (Array.isArray(result.homelist) ? result.homelist : []) as Array<Record<string, unknown>>
    return list.map(h => {
      const roomsRaw = Array.isArray(h.roomlist) ? h.roomlist : []
      return {
        // Current API: home id = `id`, owner = `uid`; old shape `home_id`/`owner_id` kept for compatibility.
        home_id: Number(h.id ?? h.home_id ?? 0),
        name: String(h.name ?? h.label ?? '未命名家庭'),
        owner_id: Number(h.uid ?? h.owner_id ?? 0),
        rooms: roomsRaw.map(r => {
          const room = r as Record<string, unknown>
          return {
            room_id: Number(room.id ?? room.room_id ?? 0),
            name: String(room.name ?? room.label ?? ''),
            ...(Array.isArray(room.dids) ? { dids: room.dids.map(d => String(d)) } : {}),
          }
        }),
      }
    })
  }

  async getDevices(homeId: number, ownerId: number): Promise<DeviceInfo[]> {
    const json = await this.encrypted('v2/home/home_device_list', {
      home_owner: ownerId,
      home_id: homeId,
      limit: 200,
      get_split_device: true,
      support_smart_home: true,
    })
    const result = (json.result ?? {}) as Record<string, unknown>
    // Current API: `device_info` with `isOnline`; old shapes kept for compatibility.
    const list = (Array.isArray(result.device_info) ? result.device_info
      : Array.isArray(result.device_list) ? result.device_list
        : Array.isArray(result.list) ? result.list
          : []) as Array<Record<string, unknown>>
    return list.map(d => ({
      did: String(d.did ?? ''),
      name: String(d.name ?? d.label ?? d.did ?? ''),
      model: String(d.model ?? ''),
      online: Boolean(d.isOnline ?? d.online ?? d.is_online ?? false),
      ...(d.room_id !== undefined && d.room_id !== null ? { room_id: Number(d.room_id) } : {}),
    }))
  }

  async rawCommand(did: string, method: string, params: unknown[]): Promise<unknown> {
    // Modern cloud channel for device control: encrypted `miotspec/prop/set`
    // with known property iids. `set_power` (bool) and `set_bright` (1-100)
    // are mapped; other methods need per-model MIoT spec knowledge.
    if (method === 'set_power') {
      const value = params[0] === 'on' || params[0] === true || params[0] === 1
      return this.miotSet(did, 2, 1, value)
    }
    if (method === 'set_bright') {
      const value = Number(params[0])
      if (Number.isNaN(value)) throw new Error(`dsh-mihome: set_bright 需要 1-100 的数值`)
      return this.miotSet(did, 2, 2, value)
    }
    throw new Error(`dsh-mihome: 方法 ${method} 尚未支持云端映射（当前支持 set_power / set_bright）`)
  }

  private async miotSet(did: string, siid: number, piid: number, value: unknown): Promise<unknown> {
    const json = await this.encrypted('miotspec/prop/set', {
      params: [{ did, siid, piid, value }],
    })
    return json.result ?? json.code
  }

  async getProps(did: string, props: string[]): Promise<Record<string, unknown>> {
    // Modern channel: encrypted `miotspec/prop/get` with (siid, piid) grid.
    // Common MIoT identifiers; unsupported entries come back with a negative
    // `code` and are skipped.
    const wanted = props.flatMap(name =>
      (MiCloudClient.PROP_IIDS[name] ?? []).map(i => ({ did, siid: i.siid, piid: i.piid, name })),
    )
    if (wanted.length === 0) return {}
    try {
      const json = await this.encrypted('miotspec/prop/get', {
        params: wanted.map(w => ({ did: w.did, siid: w.siid, piid: w.piid })),
      })
      const result = (Array.isArray(json.result) ? json.result : []) as Array<{
        siid?: number
        piid?: number
        value?: unknown
        code?: number
      }>
      const out: Record<string, unknown> = {}
      for (const entry of result) {
        if (entry.code !== undefined && entry.code !== 0) continue
        const found = wanted.find(w => w.siid === entry.siid && w.piid === entry.piid)
        if (found && entry.value !== undefined) out[found.name] = entry.value
      }
      return out
    } catch {
      return {}
    }
  }

  private static readonly PROP_IIDS: Record<string, Array<{ siid: number; piid: number }>> = {
    power: [{ siid: 2, piid: 1 }],
    brightness: [{ siid: 2, piid: 2 }],
    color_temp: [{ siid: 2, piid: 3 }],
    temperature: [{ siid: 3, piid: 1 }],
    humidity: [{ siid: 3, piid: 2 }],
    battery: [{ siid: 4, piid: 1 }, { siid: 3, piid: 3 }],
  }
}



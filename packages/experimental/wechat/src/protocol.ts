import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
export const API_TIMEOUT_MS = 15_000
export const LONG_POLL_TIMEOUT_MS = 40_000
export const MAX_INBOUND_BYTES = 100 * 1024 * 1024
export const MAX_OUTBOUND_BYTES = 20 * 1024 * 1024

export const ITEM_TYPE = { text: 1, image: 2, voice: 3, file: 4, video: 5 } as const
const CDN_HOSTS = new Set([
  'novac2c.cdn.weixin.qq.com', 'ilinkai.weixin.qq.com', 'wx.qlogo.cn',
  'thirdwx.qlogo.cn', 'res.wx.qq.com', 'mmbiz.qpic.cn', 'mmbiz.qlogo.cn',
])

export interface IlinkEnvelope {
  readonly ret?: number | string
  readonly errcode?: number | string
  readonly errmsg?: string
  readonly [key: string]: unknown
}

export interface IlinkMessage {
  readonly message_id?: string | number
  readonly from_user_id?: string
  readonly group_id?: string
  readonly context_token?: string
  readonly create_time_ms?: number | string
  readonly item_list?: readonly IlinkItem[]
  readonly [key: string]: unknown
}

export interface IlinkItem {
  readonly type?: number | string
  readonly [key: string]: unknown
}

export interface IlinkQr {
  readonly qrcode: string
  readonly qrDataUrl: string
}

export class IlinkApiError extends Error {
  constructor(message: string, readonly ret?: number | string, readonly errcode?: number | string) {
    super(message)
    this.name = 'IlinkApiError'
  }
}

/** Minimal iLink client following the validated Tencent wire protocol. */
export class IlinkClient {
  constructor(
    readonly baseUrl: string,
    private readonly token?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async getQr(signal?: AbortSignal): Promise<IlinkQr> {
    const response = await this.request('ilink/bot/get_bot_qrcode?bot_type=3', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    })
    assertSuccess(response)
    if (typeof response.qrcode !== 'string' || typeof response.qrcode_img_content !== 'string') {
      throw new IlinkApiError('iLink QR response was incomplete')
    }
    const image = normalizeQrImage(response.qrcode_img_content)
    if (image !== undefined) return { qrcode: response.qrcode, qrDataUrl: image }
    const qrModule = await import('qrcode')
    const qrDataUrl = await qrModule.default.toDataURL(response.qrcode_img_content, {
      errorCorrectionLevel: 'M',
      width: 512,
      margin: 4,
    })
    return { qrcode: response.qrcode, qrDataUrl }
  }

  async getQrStatus(qrcode: string, verifyCode = '', signal?: AbortSignal): Promise<IlinkEnvelope> {
    const query = new URLSearchParams({ qrcode })
    if (verifyCode) query.set('verify_code', verifyCode)
    return await this.request(`ilink/bot/get_qrcode_status?${query}`, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    })
  }

  async notifyStart(signal?: AbortSignal): Promise<IlinkEnvelope> {
    const result = await this.request('ilink/bot/msg/notifystart', signal === undefined ? {} : { signal })
    assertSuccess(result)
    return result
  }

  async notifyStop(): Promise<void> {
    const result = await this.request('ilink/bot/msg/notifystop')
    assertSuccess(result)
  }

  async getConfig(ownerUserId: string, contextToken?: string, signal?: AbortSignal): Promise<IlinkEnvelope> {
    const result = await this.request('ilink/bot/getconfig', {
      body: { ilink_user_id: ownerUserId, ...(contextToken ? { context_token: contextToken } : {}) },
      ...(signal === undefined ? {} : { signal }),
    })
    assertSuccess(result)
    return result
  }

  async sendTyping(ownerUserId: string, ticket: string, signal?: AbortSignal): Promise<void> {
    const result = await this.request('ilink/bot/sendtyping', {
      body: { ilink_user_id: ownerUserId, typing_ticket: ticket, typing_status: 1 },
      ...(signal === undefined ? {} : { signal }),
    })
    assertSuccess(result)
  }

  async getUpdates(cursor: string, signal?: AbortSignal): Promise<IlinkEnvelope> {
    return await this.request('ilink/bot/getupdates', {
      body: { get_updates_buf: cursor },
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    })
  }

  async sendText(toUserId: string, text: string, contextToken?: string, signal?: AbortSignal): Promise<IlinkEnvelope> {
    const result = await this.request('ilink/bot/sendmessage', {
      body: { msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `dsh-wechat-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [{ type: ITEM_TYPE.text, text_item: { text } }],
      } },
      ...(signal === undefined ? {} : { signal }),
    })
    assertSuccess(result)
    return result
  }

  async sendMedia(
    kind: 'image' | 'video' | 'file',
    filename: string,
    bytes: Uint8Array,
    toUserId: string,
    contextToken?: string,
    signal?: AbortSignal,
  ): Promise<{ readonly upload: IlinkEnvelope; readonly send: IlinkEnvelope }> {
    const key = randomBytes(16)
    const filekey = randomBytes(16).toString('hex')
    const encrypted = encryptAesEcb(bytes, key)
    const mediaType = kind === 'image' ? 1 : kind === 'video' ? 2 : 3
    const upload = await this.request('ilink/bot/getuploadurl', {
      body: {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize: bytes.byteLength,
        rawfilemd5: createHash('md5').update(bytes).digest('hex'),
        filesize: encrypted.byteLength,
        no_need_thumb: true,
        aeskey: key.toString('hex'),
      },
      ...(signal === undefined ? {} : { signal }),
    })
    assertSuccess(upload)
    const uploadUrl = typeof upload.upload_full_url === 'string'
      ? upload.upload_full_url
      : typeof upload.upload_param === 'string'
        ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}`
        : ''
    const safeUploadUrl = assertCdnUrl(uploadUrl)
    const cdnResponse = await this.fetcher(safeUploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: encrypted as BodyInit,
      signal: signal ?? AbortSignal.timeout(120_000),
    })
    if (cdnResponse.status !== 200) throw new IlinkApiError(`WeChat CDN upload failed (HTTP ${cdnResponse.status})`)
    const encryptedQuery = cdnResponse.headers.get('x-encrypted-param')
    if (!encryptedQuery) throw new IlinkApiError('WeChat CDN upload response was incomplete')
    const media = {
      encrypt_query_param: encryptedQuery,
      aes_key: Buffer.from(key.toString('hex'), 'utf8').toString('base64'),
      encrypt_type: 1,
    }
    const item = kind === 'image'
      ? { type: ITEM_TYPE.image, image_item: { media, mid_size: encrypted.byteLength } }
      : kind === 'video'
        ? { type: ITEM_TYPE.video, video_item: { media, video_size: encrypted.byteLength } }
        : { type: ITEM_TYPE.file, file_item: { media, file_name: filename, len: String(bytes.byteLength) } }
    const send = await this.request('ilink/bot/sendmessage', {
      body: { msg: {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `dsh-wechat-${randomUUID()}`,
        message_type: 2,
        message_state: 2,
        ...(contextToken ? { context_token: contextToken } : {}),
        item_list: [item],
      } },
      ...(signal === undefined ? {} : { signal }),
    })
    assertSuccess(send)
    return { upload, send }
  }

  async downloadMedia(item: IlinkItem, signal?: AbortSignal): Promise<Buffer> {
    const type = Number(item.type)
    const key = type === ITEM_TYPE.image ? 'image_item'
      : type === ITEM_TYPE.voice ? 'voice_item'
        : type === ITEM_TYPE.file ? 'file_item'
          : type === ITEM_TYPE.video ? 'video_item' : ''
    if (!key) throw new Error('Unsupported WeChat attachment')
    const mediaItem = record(item[key]) ?? {}
    const media = record(mediaItem.media) ?? {}
    let encodedKey = typeof media.aes_key === 'string' ? media.aes_key : ''
    if (!encodedKey && typeof mediaItem.aeskey === 'string') {
      encodedKey = /^[0-9a-f]{32}$/i.test(mediaItem.aeskey)
        ? Buffer.from(mediaItem.aeskey, 'hex').toString('base64')
        : mediaItem.aeskey
    }
    const fullUrl = typeof media.full_url === 'string' ? media.full_url : ''
    const query = typeof media.encrypt_query_param === 'string' ? media.encrypt_query_param : ''
    const url = assertCdnUrl(fullUrl || `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(query)}`)
    const response = await this.fetcher(url, { signal: signal ?? AbortSignal.timeout(90_000) })
    if (!response.ok) throw new IlinkApiError(`WeChat CDN download failed (HTTP ${response.status})`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_INBOUND_BYTES) throw new Error('WeChat attachment exceeds 100 MB')
    if (response.body === null) throw new Error('WeChat attachment response had no body')
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        total += next.value.byteLength
        if (total > MAX_INBOUND_BYTES) {
          await reader.cancel()
          throw new Error('WeChat attachment exceeds 100 MB')
        }
        chunks.push(Buffer.from(next.value))
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = Buffer.concat(chunks, total)
    return encodedKey ? decryptAesEcb(bytes, parseAesKey(encodedKey)) : bytes
  }

  private async request(
    endpoint: string,
    options: { readonly method?: 'GET' | 'POST'; readonly body?: Record<string, unknown>; readonly signal?: AbortSignal; readonly timeoutMs?: number } = {},
  ): Promise<IlinkEnvelope> {
    const method = options.method ?? 'POST'
    const headers: Record<string, string> = {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
    }
    const init: RequestInit = { method, headers }
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json'
      headers.AuthorizationType = 'ilink_bot_token'
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
      if (this.token) headers.Authorization = `Bearer ${this.token}`
      init.body = JSON.stringify({ ...options.body, base_info: { channel_version: '2.4.10', bot_agent: 'OpenClaw' } })
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS)
    init.signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let response: Response
    let text: string
    try {
      response = await this.fetcher(new URL(endpoint, normalizeBaseUrl(this.baseUrl)), init)
      text = await response.text()
    } catch (error) {
      if (isTimeoutError(error)) throw error
      throw new IlinkApiError(redact(safeError(error), this.token ? [this.token] : []))
    }
    let envelope: IlinkEnvelope
    try {
      envelope = parseLosslessJson(text) as IlinkEnvelope
    } catch {
      throw new IlinkApiError(`iLink returned invalid JSON (HTTP ${response.status})`)
    }
    if (!response.ok) throw new IlinkApiError(`iLink request failed (HTTP ${response.status})`)
    return envelope
  }
}

export function assertSuccess(envelope: IlinkEnvelope): void {
  if (nonzero(envelope.ret) || nonzero(envelope.errcode)) {
    throw new IlinkApiError(
      `iLink rejected the request (ret=${envelope.ret ?? 'none'}, errcode=${envelope.errcode ?? 'none'})`,
      envelope.ret,
      envelope.errcode,
    )
  }
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

export function isExpiredSession(error: unknown): boolean {
  return error instanceof IlinkApiError && (Number(error.ret) === -14 || Number(error.errcode) === -14)
}

export function parseAesKey(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 16) return decoded
  const hex = decoded.toString('ascii')
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(hex)) return Buffer.from(hex, 'hex')
  throw new Error('WeChat attachment AES key is invalid')
}

export function decryptAesEcb(ciphertext: Uint8Array, key: Uint8Array): Buffer {
  if (key.byteLength !== 16 || ciphertext.byteLength === 0 || ciphertext.byteLength % 16 !== 0) {
    throw new Error('WeChat attachment encryption is invalid')
  }
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(false)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const padding = plaintext.at(-1) ?? 0
  if (padding < 1 || padding > 16 || padding > plaintext.length
    || !plaintext.subarray(-padding).every(byte => byte === padding)) {
    throw new Error('WeChat attachment padding is invalid')
  }
  return plaintext.subarray(0, plaintext.length - padding)
}

export function encryptAesEcb(plaintext: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

export function safeFilename(value: string, fallback: string): string {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1) ?? ''
  const clean = leaf.replace(/[\x00-\x1f<>:"|?*]/g, '_').replace(/^\.+$/, '').slice(0, 120)
  return clean || fallback
}

function normalizeQrImage(value: string): string | undefined {
  const content = value.trim()
  if (/^data:image\//i.test(content)) return content
  const base64 = content.replace(/\s+/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64) || base64.length < 8) {
    return undefined
  }
  const bytes = Buffer.from(base64, 'base64')
  let mime = 'image/png'
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) mime = 'image/jpeg'
  else if (bytes.subarray(0, 4).toString() === 'GIF8') mime = 'image/gif'
  else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp'
  return `data:${mime};base64,${base64}`
}

export function messageText(message: IlinkMessage): string {
  return (message.item_list ?? [])
    .filter(item => Number(item.type) === ITEM_TYPE.text)
    .map(item => record(item.text_item)?.text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
}

export function voiceTranscript(message: IlinkMessage): string {
  return (message.item_list ?? [])
    .filter(item => Number(item.type) === ITEM_TYPE.voice)
    .map((item) => {
      const voice = record(item.voice_item)
      return typeof voice?.text === 'string' ? voice.text : typeof voice?.transcript === 'string' ? voice.transcript : ''
    })
    .filter(Boolean)
    .join('\n')
}

export function messageId(message: IlinkMessage): string {
  const value = message.message_id ?? message.client_id
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString()
  if (typeof value === 'bigint') return value.toString()
  return ''
}

export function redact(value: unknown, secrets: readonly string[] = []): string {
  let text = typeof value === 'string' ? value
    : value instanceof Error ? value.message
      : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint' ? String(value) : ''
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]')
  return text
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:token|bot[_-]?token|aes[_-]?key|aeskey|authorization)["']?\s*[:=]\s*["']?)[^"',&\s}]+/gi, '$1[redacted]')
    .replace(/([?&](?:qrcode|token|aeskey)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 300)
}

export function maskId(id: string): string {
  return id.length <= 5 ? '*'.repeat(id.length) : `${id.slice(0, 3)}…${id.slice(-2)}`
}

export function parseLosslessJson(text: string): unknown {
  const ids = new Set(['message_id', 'msg_id', 'svr_id'])
  let output = '', index = 0
  while (index < text.length) {
    if (text[index] !== '"') {
      output += text[index++] ?? ''
      continue
    }
    const start = index++
    let escaped = false
    while (index < text.length) {
      const char = text[index++] ?? ''
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') break
    }
    const token = text.slice(start, index)
    output += token
    let cursor = index
    while (/\s/.test(text[cursor] ?? '')) cursor++
    if (text[cursor] !== ':') continue
    let key: unknown
    try { key = JSON.parse(token) } catch { continue }
    if (typeof key !== 'string' || !ids.has(key)) continue
    output += text.slice(index, cursor + 1)
    cursor++
    while (/\s/.test(text[cursor] ?? '')) output += text[cursor++] ?? ''
    const valueStart = cursor
    if (text[cursor] === '-') cursor++
    while (/\d/.test(text[cursor] ?? '')) cursor++
    if (cursor > valueStart && !(cursor === valueStart + 1 && text[valueStart] === '-')) {
      output += `"${text.slice(valueStart, cursor)}"`
      index = cursor
    } else index = valueStart
  }
  return JSON.parse(output)
}

function normalizeBaseUrl(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new IlinkApiError('iLink base URL is invalid') }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new IlinkApiError('iLink base URL is invalid')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url
}

function assertCdnUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('WeChat media URL is invalid') }
  if (url.protocol !== 'https:' || url.username || url.password || !CDN_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('WeChat media URL is outside the trusted CDN')
  }
  return url.toString()
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonzero(value: unknown): boolean {
  return value !== undefined && value !== null && Number(value) !== 0
}

function safeError(error: unknown): string {
  if (error instanceof Error) return redact(error.message)
  return redact(error)
}

import { createCipheriv } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IlinkClient, decryptAesEcb, encryptAesEcb, isTimeoutError, messageId, parseAesKey,
  parseLosslessJson,
} from '../src/protocol.ts'

describe('iLink protocol', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server?.close((error) => {
      if (error !== undefined) reject(error)
      else resolve()
    }))
    server = undefined
  })

  it.each([
    ['image data URI', 'data:image/png;base64,iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo='],
    ['bare image base64', 'iVBORw0KGgo=', 'data:image/png;base64,iVBORw0KGgo='],
  ])('normalizes QR %s into an image data URL', async (_name, content, expected) => {
    const client = await clientFor(response => response.end(JSON.stringify({
      ret: 0,
      qrcode: 'qr-code',
      qrcode_img_content: content,
    })))
    await expect(client.getQr()).resolves.toMatchObject({ qrcode: 'qr-code', qrDataUrl: expected })
  })

  it('checks HTTP-200 business errors without exposing server details', async () => {
    const client = await clientFor(response => response.end(JSON.stringify({
      ret: -7,
      errmsg: 'credential-bearing server detail',
    })))
    await expect(client.notifyStart())
      .rejects.toMatchObject({ name: 'IlinkApiError', ret: -7 })
    await expect(client.notifyStart())
      .rejects.not.toThrow('credential-bearing')
  })

  it('redacts the bot token from transport errors', async () => {
    const client = new IlinkClient('https://ilink.example', 'private-token', async () => {
      throw new Error('request failed: private-token')
    })
    await expect(client.notifyStart()).rejects.not.toThrow('private-token')
  })

  it('treats a long-poll timeout as an ordinary timeout error', async () => {
    const client = new IlinkClient('http://127.0.0.1:1', undefined, async () => {
      throw new DOMException('request timed out', 'TimeoutError')
    })
    const result = client.getUpdates('cursor')
    await expect(result).rejects.toMatchObject({ name: 'TimeoutError' })
    await expect(result.catch((error: unknown) => isTimeoutError(error))).resolves.toBe(true)
  })

  it('preserves numeric message IDs and cursor payloads losslessly', async () => {
    const envelope = parseLosslessJson('{"msgs":[{"message_id":90071992547409931234}],"get_updates_buf":"cursor"}')
    const message = (envelope as { msgs: [{ message_id: string }] }).msgs[0]
    expect(messageId(message)).toBe('90071992547409931234')
    expect(envelope).toMatchObject({ get_updates_buf: 'cursor' })
  })

  it('accepts raw-base64 and base64-encoded hexadecimal AES keys', () => {
    const raw = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    expect(parseAesKey(raw.toString('base64'))).toEqual(raw)
    expect(parseAesKey(Buffer.from(raw.toString('hex')).toString('base64'))).toEqual(raw)
    const encrypted = encryptAesEcb(Buffer.from('wechat media'), raw)
    expect(decryptAesEcb(encrypted, raw).toString()).toBe('wechat media')
  })

  it('rejects invalid PKCS#7 padding', () => {
    const key = Buffer.alloc(16, 3)
    const cipher = createCipheriv('aes-128-ecb', key, null)
    cipher.setAutoPadding(false)
    const invalid = Buffer.concat([cipher.update(Buffer.alloc(16)), cipher.final()])
    expect(() => decryptAesEcb(invalid, key)).toThrow('WeChat attachment padding is invalid')
  })

  async function clientFor(
    respond: (response: ServerResponse) => void,
  ): Promise<IlinkClient> {
    server = createServer((_request, response) => { respond(response) })
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address() as AddressInfo
    return new IlinkClient(`http://127.0.0.1:${address.port}`)
  }
})

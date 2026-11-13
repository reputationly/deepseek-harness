/**
 * Canned media gateway for recorded-session scenarios: image, video, speech, and catalog responses
 * that never leave the machine, so a replay exercises the generation path without spending money.
 * @module
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One running canned gateway. */
export interface FakeGateway {
  /** Root URL including the `/v1` prefix a media client expects. */
  readonly url: string
  /** Stop the server. */
  close(): Promise<void>
}

/** Smallest valid PNG, used as every image response. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Capability catalog the canned gateway publishes. */
function catalog(): unknown {
  const duration = { type: 'string', enum: ['3', '4', '5', '6', '9', '12', '15'] }
  const resolution = { type: 'string', enum: ['768P', '2K'] }
  return {
    version: 'fake',
    capabilities: [
      {
        id: 'generate_image:fake-image', operation: 'generate_image', model: 'fake-image', default: true,
        paramSchema: { properties: { size: { type: 'string', enum: ['1024x1024'] } } },
      },
      {
        id: 'generate_video:fake-video', operation: 'generate_video', model: 'fake-video', default: true,
        paramSchema: { properties: { duration, resolution, ratio: { type: 'string', enum: ['9:16', '16:9'] } } },
        limits: { maxDurationSeconds: 15 },
      },
      {
        id: 'generate_video:fake-video-ref', operation: 'generate_video', model: 'fake-video-ref',
        paramSchema: { properties: { duration, resolution, ratio: { type: 'string', enum: ['9:16', '16:9'] }, src_ref_images: { type: 'string' } } },
        limits: { maxDurationSeconds: 15 },
      },
      { id: 'generate_speech:fake-speech', operation: 'generate_speech', model: 'fake-speech', default: true },
    ],
  }
}

/** Answer one request from the canned gateway. */
function respond(path: string): { status: number; type: string; body: string | Buffer } {
  if (path === '/v1/ov/capabilities') return { status: 200, type: 'application/json', body: JSON.stringify(catalog()) }
  if (path === '/v1/images/generations' || path === '/v1/images/edits') {
    return { status: 200, type: 'application/json', body: JSON.stringify({ data: [{ url: `data:image/png;base64,${PNG}` }] }) }
  }
  if (path === '/v1/audio/speech') return { status: 200, type: 'audio/mpeg', body: Buffer.from('fake-mp3') }
  if (/^\/v1\/videos\/[^/]+$/u.test(path)) {
    return {
      status: 200, type: 'application/json',
      body: JSON.stringify({ status: 'succeeded', url: `data:video/mp4;base64,${Buffer.from('fake-mp4').toString('base64')}` }),
    }
  }
  if (path === '/v1/videos') return { status: 200, type: 'application/json', body: JSON.stringify({ id: 'fake-task' }) }
  return { status: 404, type: 'application/json', body: JSON.stringify({ error: { message: `no canned response for ${path}` } }) }
}

/**
 * Start the canned gateway on a free loopback port.
 * @returns the root URL and a closer.
 */
export async function startFakeGateway(): Promise<FakeGateway> {
  const server: Server = createServer((request, response) => {
    const path = (request.url as string).split('?')[0] as string
    const answer = respond(path)
    response.writeHead(answer.status, { 'content-type': answer.type })
    response.end(answer.body)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    },
  }
}

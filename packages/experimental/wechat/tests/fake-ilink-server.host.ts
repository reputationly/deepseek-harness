import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Server, ServerResponse } from 'node:http'

export interface FakeIlinkRequest {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown>
}

export type FakeIlinkHandler = (
  request: FakeIlinkRequest,
  response: ServerResponse,
) => void | Promise<void>

export async function createFakeIlinkServer(handler: FakeIlinkHandler): Promise<{
  readonly url: string
  readonly requests: FakeIlinkRequest[]
  close(): Promise<void>
}> {
  const requests: FakeIlinkRequest[] = []
  const server: Server = createServer((request, response) => {
    void (async () => {
      let text = ''
      request.setEncoding('utf8')
      for await (const chunk of request) text += String(chunk)
      const body: Record<string, unknown> = text ? JSON.parse(text) as Record<string, unknown> : {}
      const captured = { method: request.method ?? 'GET', path: request.url ?? '/', body }
      requests.push(captured)
      await handler(captured, response)
    })().catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error('fake iLink handler failed'))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve()
      }))
    },
  }
}

export function respond(response: ServerResponse, body: Record<string, unknown>): void {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

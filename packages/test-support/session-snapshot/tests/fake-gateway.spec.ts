import { describe, expect, it } from 'vitest'
import { startFakeGateway } from '../src/fake-gateway.ts'

describe('fake media gateway', () => {
  it('answers the media endpoints a generation run needs', async () => {
    const gateway = await startFakeGateway()
    try {
      const catalog = await fetch(`${gateway.url}/ov/capabilities`).then(response => response.json()) as { capabilities: unknown[] }
      expect(catalog.capabilities.length).toBeGreaterThan(0)
      const image = await fetch(`${gateway.url}/images/generations`, { method: 'POST' }).then(response => response.json()) as { data: { url: string }[] }
      expect(image.data[0]?.url).toContain('data:image/png')
      const edit = await fetch(`${gateway.url}/images/edits`, { method: 'POST' }).then(response => response.json()) as { data: { url: string }[] }
      expect(edit.data[0]?.url).toContain('data:image/png')
      const speech = await fetch(`${gateway.url}/audio/speech`, { method: 'POST' })
      expect(speech.headers.get('content-type')).toContain('audio/mpeg')
      const task = await fetch(`${gateway.url}/videos`, { method: 'POST' }).then(response => response.json()) as { id: string }
      expect(task.id).toBe('fake-task')
      const state = await fetch(`${gateway.url}/videos/${task.id}`).then(response => response.json()) as { status: string; url: string }
      expect(state.status).toBe('succeeded')
      expect(state.url).toContain('data:video/mp4')
      const missing = await fetch(`${gateway.url}/nope`)
      expect(missing.status).toBe(404)
    } finally {
      await gateway.close()
    }
  })

  it('reports a second close', async () => {
    const gateway = await startFakeGateway()
    await gateway.close()
    await expect(gateway.close()).rejects.toThrow()
  })
})

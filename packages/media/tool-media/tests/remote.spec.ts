import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MediaService } from '../src/remote.ts'
import type { MediaRuntime } from '../src/remote.ts'
import type { MediaCatalog } from '../src/catalog.ts'

const totals = { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 0 }
const runtime: MediaRuntime = {
  plan: vi.fn(async () => ({ state: 'ready' as const, lines: [], totals, jobs: [] })),
  generate: vi.fn(async () => ({ state: 'started' as const, lines: [], totals, jobs: [] })),
  cancel: vi.fn(() => true),
}

const catalog: MediaCatalog = {
  version: 'x',
  source: 'live',
  capabilities: [{
    id: 'v', operation: 'generate_video', model: 'video-model',
    paramSchema: { properties: { duration: { enum: ['5'] }, resolution: { enum: ['2K'] } } },
  }],
}

describe('media Remote namespace', () => {
  it('lists the models one operation offers with their parameter names', async () => {
    const service = new MediaService(new Context(), () => Promise.resolve(catalog), runtime)
    await expect(service.capabilities({} as never, 'generate_video')).resolves.toEqual([
      {
        id: 'v', model: 'video-model', operation: 'generate_video',
        params: [
          { id: 'duration', options: ['5'] },
          { id: 'resolution', options: ['2K'] },
        ],
      },
    ])
  })

  it('returns nothing when the deployment has no catalog', async () => {
    const service = new MediaService(new Context(), () => Promise.resolve(undefined), runtime)
    await expect(service.capabilities({} as never, 'generate_image')).resolves.toEqual([])
  })
})

describe('media generation endpoints', () => {
  it('delegates planning, starting with a token, and cancellation to the runtime', async () => {
    const service = new MediaService(new Context(), () => Promise.resolve(undefined), runtime)
    await expect(service.planNodes({} as never, ['n1'])).resolves.toMatchObject({ state: 'ready' })
    await expect(service.generateNodes({} as never, ['n1'], 'tok')).resolves.toMatchObject({ state: 'started' })
    expect(service.cancelMediaJob({} as never, 'j1')).toBe(true)
    expect(runtime.plan).toHaveBeenCalledWith(expect.anything(), ['n1'])
    expect(runtime.generate).toHaveBeenCalledWith(expect.anything(), ['n1'], 'tok')
    expect(runtime.cancel).toHaveBeenCalledWith(expect.anything(), 'j1')
  })
})

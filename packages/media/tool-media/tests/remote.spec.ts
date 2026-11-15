import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MediaService } from '../src/remote.ts'
import type { MediaRuntime } from '../src/remote.ts'
import type { MediaCatalog } from '../src/catalog.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasNodeId, EpisodeId, VersionId } from '@deepseek-ai/dsh-canvas/client'
import { LocalMediaEditError } from '../src/local-edit.ts'

const totals = { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 0 }
const runtime: MediaRuntime = {
  preview: vi.fn(async () => '/project/.canvas/previews/v.webm'),
  plan: vi.fn(async () => ({ state: 'ready' as const, lines: [], totals, jobs: [] })),
  generate: vi.fn(async () => ({ state: 'started' as const, lines: [], totals, jobs: [] })),
  cancel: vi.fn(() => true),
}

const catalog: MediaCatalog = {
  version: 'x',
  source: 'live',
  capabilities: [{
    id: 'v', operation: 'generate_video', model: 'video-model',
    paramSchema: { properties: {
      duration: { enum: ['5'], title: 'Duration', default: '5', type: 'string' },
      resolution: { default: '2K', type: 'string' },
      extra: {},
    } },
  }, { id: 'bare', operation: 'generate_image', model: 'image-model' }],
}

describe('media Remote namespace', () => {
  it('preserves local failure kinds and the retained output path across the Remote boundary', async () => {
    const session = Session.create(SessionId('local-remote'))
    const request = { scope: { directory: '/project', episode: brandString<EpisodeId>('e1') }, node: brandString<CanvasNodeId>('n1'), version: brandString<VersionId>('v1'), operation: 'audio_edit' as const }
    const cause = new LocalMediaEditError('attachment', 'The completed audio is retained', '/project/local.wav')
    const edit = vi.fn(async () => { throw cause })
    const service = new MediaService(new Context(), () => Promise.resolve(catalog), runtime, undefined, { edit })
    await expect(service.editMedia(session, request)).rejects.toMatchObject({ code: 'media/edit', details: { kind: 'attachment', path: '/project/local.wav' }, cause })
    expect(edit).toHaveBeenCalledExactlyOnceWith(session, request, 'none')
    const unavailable = new MediaService(new Context(), () => Promise.resolve(catalog), runtime)
    await expect(unavailable.editMedia(session, request)).rejects.toMatchObject({ code: 'media/edit', details: { kind: 'processing' } })
  })

  it('lists the models one operation offers with their parameter names', async () => {
    const service = new MediaService(new Context(), () => Promise.resolve(catalog), runtime)
    await expect(service.capabilities({} as never, 'generate_video')).resolves.toEqual([
      {
        id: 'v', model: 'video-model', operation: 'generate_video',
        params: [
          { id: 'duration', options: ['5'], title: 'Duration', default: '5', type: 'string' },
          { id: 'resolution', default: '2K', type: 'string' },
          { id: 'extra' },
        ],
      },
    ])
    await expect(service.capabilities({} as never, 'generate_image')).resolves.toEqual([
      { id: 'bare', model: 'image-model', operation: 'generate_image', params: [] },
    ])
  })

  it('returns nothing when the deployment has no catalog', async () => {
    const service = new MediaService(new Context(), () => Promise.resolve(undefined), runtime)
    await expect(service.capabilities({} as never, 'generate_image')).resolves.toEqual([])
  })
})

describe('media generation endpoints', () => {
  it('delegates planning, starting, and cancellation to the runtime', async () => {
    const service = new MediaService(new Context(), () => Promise.resolve(undefined), runtime)
    await expect(service.planNodes({} as never, ['n1'])).resolves.toMatchObject({ state: 'ready' })
    await expect(service.generateNodes({} as never, ['n1'])).resolves.toMatchObject({ state: 'started' })
    expect(service.cancelMediaJob({} as never, 'j1')).toBe(true)
    expect(runtime.plan).toHaveBeenCalledWith(expect.anything(), ['n1'], undefined)
    expect(runtime.generate).toHaveBeenCalledWith(expect.anything(), ['n1'], undefined)
    expect(runtime.cancel).toHaveBeenCalledWith(expect.anything(), 'j1')
  })
})

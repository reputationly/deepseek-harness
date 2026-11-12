import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MediaService } from '../src/remote.ts'
import type { MediaCatalog } from '../src/catalog.ts'

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
    const service = new MediaService(new Context(), () => Promise.resolve(catalog))
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
    const service = new MediaService(new Context(), () => Promise.resolve(undefined))
    await expect(service.capabilities({} as never, 'generate_image')).resolves.toEqual([])
  })
})

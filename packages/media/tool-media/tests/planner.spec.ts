import { describe, expect, it } from 'vitest'
import type { Capability, MediaCatalog } from '../src/catalog.ts'
import { imagePixelSize, planImage, planVideo } from '../src/planner.ts'

const RATIOS = ['adaptive', '1:1', '16:9', '9:16', '21:9']
const DURATIONS = ['4', '5', '6', '10', '15']
const image: Capability = {
  id: 'generate_image:img', operation: 'generate_image', model: 'img', taskTypes: ['i2i', 't2i'], default: true,
  paramSchema: { properties: {
    aspect_ratio: { enum: RATIOS, default: 'adaptive', title: '宽高比' },
    resolution: { enum: ['1K', '2K'], default: '2K', title: '分辨率' },
  } },
  limits: { maxReferenceImages: 2, maxInputBytes: 0 },
}
const videoParams = (mode: string) => ({ properties: {
  duration: { enum: DURATIONS, default: '15', title: '时长' },
  generate_audio: { enum: ['true', 'false'], default: 'true', title: '有声视频' },
  image_mode: { enum: [mode], default: mode },
  ratio: { enum: RATIOS, default: 'adaptive', title: '宽高比' },
  resolution: { enum: ['768P', '2K'], default: '2K', title: '分辨率' },
} })
const frames: Capability = {
  id: 'generate_video:frames', operation: 'generate_video', model: 'frames', taskTypes: ['auto', 't2v'], default: true,
  paramSchema: videoParams('first-last-frame'), limits: { maxReferenceImages: 2, maxInputBytes: 100 },
}
const refs: Capability = {
  id: 'generate_video:refs', operation: 'generate_video', model: 'refs', taskTypes: ['r2va'],
  paramSchema: videoParams('reference'), limits: { maxReferenceImages: 3, maxInputBytes: 100 },
}
const catalog: MediaCatalog = { version: 'v', source: 'live', capabilities: [refs, frames, image] }
const ref = (bytes = 10) => ({ dataURI: 'data:image/png;base64,AA', bytes })

describe('image planning', () => {
  it('asks for every open choice and recommends the gateway default', () => {
    const plan = planImage(catalog, { prompt: 'p', references: [] }, 'fallback')
    expect(plan).toMatchObject({ kind: 'ask', model: 'img' })
    expect(plan.kind === 'ask' && plan.choices.map(choice => [choice.id, choice.recommended])).toEqual([['aspect_ratio', 'adaptive'], ['resolution', '2K']])
  })

  it('generates directly when the user stated supported values, sizing the short edge by tier', () => {
    expect(planImage(catalog, { prompt: 'p', references: [], aspectRatio: '16:9', resolution: '2k' }, 'fallback'))
      .toEqual({ kind: 'ready', model: 'img', call: { endpoint: 'generations', size: '2560x1440' } })
    expect(planImage(catalog, { prompt: 'p', references: [], aspectRatio: 'adaptive', resolution: '1K' }, 'fallback'))
      .toEqual({ kind: 'ready', model: 'img', call: { endpoint: 'generations' } })
  })

  it('turns an unsupported value into a choice that names it', () => {
    const plan = planImage(catalog, { prompt: 'p', references: [], aspectRatio: '1:1', resolution: '4K' }, 'fallback')
    expect(plan.kind === 'ask' && plan.choices).toEqual([{ id: 'resolution', title: '分辨率', options: ['1K', '2K'], recommended: '2K', rejected: '4K' }])
  })

  it('edits references without asking for a canvas, within the reference limit', () => {
    expect(planImage(catalog, { prompt: 'p', references: [ref()] }, 'fallback'))
      .toEqual({ kind: 'ready', model: 'img', call: { endpoint: 'edits', images: ['data:image/png;base64,AA'] } })
    expect(planImage(catalog, { prompt: 'p', references: [ref(), ref(), ref()] }, 'fallback')).toMatchObject({ kind: 'reject' })
  })

  it('keeps the configured model and passes through without a catalog', () => {
    expect(planImage(undefined, { prompt: 'p', references: [] }, 'fallback')).toEqual({ kind: 'ready', model: 'fallback', call: { endpoint: 'generations' } })
  })

  it('rounds pixel sizes to multiples of 8', () => {
    expect(imagePixelSize('9:16', '1K')).toBe('1024x1824')
    expect(imagePixelSize('adaptive', '1K')).toBeUndefined()
  })
})

describe('video planning', () => {
  it('asks for ratio, resolution, and duration, recommending the product default length', () => {
    const plan = planVideo(catalog, { prompt: 'p', references: [] }, 'fallback', 5)
    expect(plan).toMatchObject({ kind: 'ask', model: 'frames' })
    expect(plan.kind === 'ask' && plan.choices.map(choice => [choice.id, choice.recommended])).toEqual([
      ['duration', '5'], ['ratio', 'adaptive'], ['resolution', '2K'],
    ])
  })

  it('submits directly when everything is stated, sending the tier word as the final size', () => {
    expect(planVideo(catalog, { prompt: 'p', references: [], aspectRatio: '9:16', resolution: '768p', duration: '5秒', audio: false }, 'fallback', 5))
      .toEqual({ kind: 'ready', model: 'frames', body: {
        prompt: 'p', duration: 5, size: '768P', aspect_ratio: '9:16',
        metadata: { task_type: 't2v', generate_audio: false, resolution: '768P' },
      } })
  })

  it('rejects 1K video as a choice naming the unsupported value', () => {
    const plan = planVideo(catalog, { prompt: 'p', references: [], aspectRatio: '16:9', resolution: '1K', duration: '20' }, 'fallback', 5)
    expect(plan.kind === 'ask' && plan.choices.map(choice => [choice.id, choice.rejected])).toEqual([['duration', '20'], ['resolution', '1K']])
  })

  it('lets frames fix the canvas and never sends a ratio with them', () => {
    const plan = planVideo(catalog, {
      prompt: 'p', references: [], firstFrame: ref(), lastFrame: ref(), aspectRatio: '21:9', resolution: '2K', duration: '6',
    }, 'fallback', 5)
    expect(plan).toMatchObject({ kind: 'ready', model: 'frames', body: { images: ['data:image/png;base64,AA', 'data:image/png;base64,AA'], metadata: { task_type: 'flf2v' } } })
    expect(plan.kind === 'ready' && 'aspect_ratio' in plan.body).toBe(false)
  })

  it('routes reference images to the reference capability within its limits', () => {
    const plan = planVideo(catalog, { prompt: 'p', references: [ref(), ref()], aspectRatio: 'adaptive', resolution: '2K', duration: '5' }, 'fallback', 5)
    expect(plan).toMatchObject({ kind: 'ready', model: 'refs', body: { metadata: { task_type: 'r2va', src_ref_images: ['data:image/png;base64,AA', 'data:image/png;base64,AA'] } } })
    expect(planVideo(catalog, { prompt: 'p', references: [ref(500)] }, 'fallback', 5)).toMatchObject({ kind: 'reject' })
    expect(planVideo(catalog, { prompt: 'p', references: [ref()], firstFrame: ref() }, 'fallback', 5)).toMatchObject({ kind: 'reject' })
  })
})

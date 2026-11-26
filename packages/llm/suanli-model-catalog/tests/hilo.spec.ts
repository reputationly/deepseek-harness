/** Hilo catalog decoding: sections become generation entries and chat models, interface types route audio. */
import { describe, expect, it } from 'vitest'
import { decodeHiloCatalog } from '../src/hilo.ts'
import { hilo, IMAGE, MUSIC, VIDEO } from './hilo-fixture.ts'

describe('decodeHiloCatalog', () => {
  it('maps an image entry to the generation entry the workbench renders', () => {
    const decoded = decodeHiloCatalog(hilo())
    expect(decoded?.entries[0]).toEqual({
      id: 'generate_image:minimax-h3-image',
      operation: 'generate_image',
      model: 'minimax-h3-image',
      displayName: { zh: 'MiniMax H3 Image', en: 'MiniMax H3 Image' },
      description: { zh: 'Text and reference images to image', en: 'Text and reference images to image' },
      transport: { kind: 'images' },
      taskTypes: ['t2i', 'i2i'],
      paramSchema: {
        type: 'object',
        properties: {
          aspect_ratio: { type: 'string', title: '宽高比', enum: ['adaptive', '1:1', '16:9', '9:16'], default: 'adaptive' },
          resolution: { type: 'string', title: '分辨率', enum: ['1K', '2K'], default: '2K' },
        },
      },
      limits: { maxReferenceImages: 4, maxDurationSeconds: 0, maxInputBytes: 0 },
      default: true,
    })
  })

  it('derives the plays of a video entry from its image modes and the longest duration', () => {
    const video = decodeHiloCatalog(hilo())?.entries.find(entry => entry.operation === 'generate_video')
    expect(video?.transport).toEqual({ kind: 'videos_task' })
    expect(video?.modes?.map(mode => mode.id)).toEqual(['first-last-frame', 'text-to-video', 'video-extension'])
    expect(video?.taskTypes).toEqual(['flf2v', 't2v', 'continuation'])
    expect(video?.limits).toEqual({ maxReferenceImages: 2, maxDurationSeconds: 20, maxInputBytes: 0 })
  })

  it('routes audio by interface type, defaulting to music', () => {
    const decoded = decodeHiloCatalog(hilo({
      audio: [MUSIC, { ...MUSIC, id: 'speech', platformModel: 'minimax-speech', interfaceType: 'maas-speech' }],
    }))
    expect(decoded?.entries.filter(entry => entry.operation === 'generate_music').map(entry => entry.model)).toEqual(['minimax-music3'])
    expect(decoded?.entries.filter(entry => entry.operation === 'generate_speech').map(entry => entry.model)).toEqual(['minimax-speech'])
    expect(decoded?.unknownInterfaces).toEqual([])
  })

  it('falls back to the section default for an unknown interface type and lists it once', () => {
    const decoded = decodeHiloCatalog(hilo({
      image: [{ ...IMAGE, interfaceType: 'maas-image-v9' }, { ...IMAGE, platformModel: 'other', interfaceType: 'maas-image-v9' }],
    }))
    expect(decoded?.entries.filter(entry => entry.operation === 'generate_image')).toHaveLength(2)
    expect(decoded?.unknownInterfaces).toEqual(['maas-image-v9'])
  })

  it('marks only the first entry of each operation as its default', () => {
    const decoded = decodeHiloCatalog(hilo({ video: [VIDEO, { ...VIDEO, platformModel: 'minimax-h3-ref-2k' }] }))
    expect(decoded?.entries.map(entry => [entry.model, entry.default])).toEqual([
      ['minimax-h3-image', true], ['minimax-h3-2k', true], ['minimax-h3-ref-2k', false], ['minimax-music3', true],
    ])
  })

  it('reads chat models, their input kinds, and the role defaults', () => {
    const decoded = decodeHiloCatalog(hilo())
    expect(decoded?.text).toEqual([
      { model: 'deepseek-v4-1-flash', label: 'DeepSeek V4.1 Flash', supportsImage: true, supportsVideo: false, supportsAudio: false },
      { model: 'qwen3.8-flash-fp8', label: 'Qwen 3.8 Flash', supportsImage: true, supportsVideo: true, supportsAudio: false },
    ])
    expect(decoded?.defaults).toEqual({ chat: 'deepseek-v4-1-flash', multimodal: 'qwen3.8-flash-fp8' })
    expect(decoded?.version).toBe('v1')
  })

  it('drops rows without an id or platform model and reports how many', () => {
    const decoded = decodeHiloCatalog(hilo({ image: [IMAGE, { id: 'x' }, 'junk'], text: [{ displayName: 'none' }] }))
    expect(decoded?.entries.filter(entry => entry.operation === 'generate_image')).toHaveLength(1)
    expect(decoded?.dropped).toBe(3)
  })

  it('reports no catalog when the payload carries none of the sections', () => {
    expect(decodeHiloCatalog({ capabilities: [] })).toBeUndefined()
    expect(decodeHiloCatalog('nope')).toBeUndefined()
  })
})

describe('decodeHiloCatalog edges', () => {
  it('keeps only usable parameters and fills what an item omits', () => {
    const decoded = decodeHiloCatalog({
      image: [{ id: 'bare', platformModel: 'bare', maxRefs: -1, params: {
        skipped: 'not a spec',
        empty: { type: 'select', options: 'none' },
        noDefault: { type: 'select', default: '9K', options: ['1K'] },
        prompt: { type: 'textarea' },
        slider: { type: 'range' },
      } }],
      video: [{ id: 'v', platformModel: 'v', params: { duration: { type: 'select', options: ['long'] }, image_mode: { type: 'select', options: ['unknown-play'] } } }],
      audio: [{ id: 's', platformModel: 's', interfaceType: 'maas-speech', params: 'none' }],
      text: [{ id: 'only-id' }, 'junk'],
    })
    const [image, video, speech] = decoded?.entries ?? []
    expect(image).toMatchObject({ taskTypes: ['t2i'], description: { zh: '', en: '' }, limits: { maxReferenceImages: 0, maxDurationSeconds: 0 } })
    expect(image?.paramSchema?.properties).toEqual({ noDefault: { type: 'string', enum: ['1K'] }, prompt: { type: 'string' } })
    expect(video).toMatchObject({ limits: { maxDurationSeconds: 0 } })
    expect(video?.modes).toBeUndefined()
    expect(video?.taskTypes).toBeUndefined()
    expect(speech).toMatchObject({ operation: 'generate_speech' })
    expect(speech?.paramSchema).toBeUndefined()
    expect(decoded?.text.map(model => model.model)).toEqual(['only-id'])
    expect(decoded).toMatchObject({ version: null, dropped: 1 })
  })
})

describe('decodeHiloCatalog sections', () => {
  it('reads a catalog that carries only some sections and lists a repeated chat model once', () => {
    expect(decodeHiloCatalog({ text: [{ id: 'a' }, { id: 'a' }] })).toMatchObject({ entries: [], text: [{ model: 'a' }] })
    const video = decodeHiloCatalog({ video: [{ id: 'v', platformModel: 'v', params: { duration: { type: 'select', options: ['5'] } } }] })
    expect(video).toMatchObject({ text: [], entries: [{ limits: { maxDurationSeconds: 5 } }] })
    expect(video?.entries[0]?.modes).toBeUndefined()
  })
})

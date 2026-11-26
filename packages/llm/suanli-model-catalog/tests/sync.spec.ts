/** Chat catalog merge and capability classes. */
import { describe, expect, it } from 'vitest'
import { classMembers, classify } from '../src/capabilities.ts'
import { mergeCatalog } from '../src/sync.ts'

describe('mergeCatalog', () => {
  it('follows listing order and keeps the facts of entries it already knew', () => {
    expect(mergeCatalog(['b', 'a'], [{ id: 'a', contextWindow: 1 }])).toEqual([
      { id: 'b' },
      { id: 'a', contextWindow: 1 },
    ])
  })
})

describe('capability classes', () => {
  const entry = (operation: string, model: string, taskTypes: string[] = []) => ({ operation, model, taskTypes, maxReferenceImages: 0 })

  it('names the product classes from operation and task type', () => {
    expect(classify(entry('chat', 'deepseek-v4-1-flash'))).toEqual(['chat'])
    expect(classify(entry('generate_image', 'minimax-h3-image', ['t2i']))).toEqual(['image.generate'])
    expect(classify(entry('generate_image', 'minimax-h3-image', ['i2i']))).toEqual(['image.edit'])
    // One entry covering both plays belongs to both classes.
    expect(classify(entry('generate_image', 'minimax-h3-image', ['i2i', 't2i']))).toEqual(['image.generate', 'image.edit'])
    expect(classify(entry('generate_video', 'h3', ['t2v']))).toEqual(['video.generate'])
    expect(classify(entry('generate_video', 'h3', ['flf2v', 'i2v']))).toEqual(['video.first-last-frame'])
    expect(classify(entry('generate_video', 'h3', ['r2va']))).toEqual(['video.reference'])
    expect(classify(entry('generate_music', 'ace-step', ['cover', 'repaint', 't2m']))).toEqual(['music.generate'])
    expect(classify(entry('generate_speech', 'tts2'))).toEqual(['speech.generate'])
    expect(classify(entry('upscale', 'relayvsr'))).toEqual(['other'])
  })

  it('groups entries in class order without repeating a model', () => {
    expect(classMembers([
      entry('generate_video', 'h3', ['t2v']),
      entry('chat', 'a'),
      entry('generate_video', 'h3', ['t2v']),
      entry('generate_music', 'ace-step', ['t2m']),
    ])).toEqual([
      { capability: 'chat', models: ['a'] },
      { capability: 'video.generate', models: ['h3'] },
      { capability: 'music.generate', models: ['ace-step'] },
    ])
  })

})

describe('capability class fallbacks', () => {
  const entry = (operation: string, taskTypes: string[] = []) => ({ operation, model: 'm', taskTypes, maxReferenceImages: 0 })
  it('puts an entry whose plays name no class in other', () => {
    expect(classify(entry('generate_image'))).toEqual(['other'])
    expect(classify(entry('generate_image', ['x2y']))).toEqual(['other'])
    expect(classify(entry('unknown_operation', ['t2i']))).toEqual(['other'])
  })
})

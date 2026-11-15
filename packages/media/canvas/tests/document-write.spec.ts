import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_BIBLE, parseBible } from '../src/bible.ts'
import { CanvasStore } from '../src/store.ts'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-document-write-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('project document write validation', () => {
  const character = { id: 'c1', kind: 'character', name: '林夏', aliases: [], description: '夜班店员', imageNodes: [] }

  it.each([
    { logline: null },
    { style: { ...EMPTY_BIBLE.style, aspect: 'wide' } },
    { entries: [{ ...character, aliases: ['林夏'] }] },
    { entries: [character, { ...character }] },
    { entries: [{ ...character, voice: { model: 7 } }] },
    { entries: [{ ...character, imageNodes: [null] }] },
    { narrator: { sampleNode: 7 } },
  ])('rejects unreadable first writes and preserves existing bytes and revision: %j', async (patch) => {
    const store = new CanvasStore()
    const file = join(directory, '.canvas', 'bible.json')
    const attempt = (): Promise<unknown> => store.updateDocument<undefined, { readonly revision: number }>(
      directory, 'bible.json', parseBible, () => EMPTY_BIBLE,
      current => ({ document: { ...EMPTY_BIBLE, ...patch, revision: current.revision }, value: undefined }),
    )
    await expect(attempt()).rejects.toThrow('bible.json:')
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    await store.updateDocument(directory, 'bible.json', parseBible, () => EMPTY_BIBLE,
      current => ({ document: { ...current, logline: 'valid' }, value: undefined }))
    const original = await readFile(file, 'utf8')
    await expect(attempt()).rejects.toThrow('bible.json:')
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(parseBible(original)).toMatchObject({ revision: 1, logline: 'valid' })

    await store.updateDocument(directory, 'bible.json', parseBible, () => EMPTY_BIBLE,
      current => ({ document: { ...current, logline: 'recovered' }, value: undefined }))
    expect(parseBible(await readFile(file, 'utf8'))).toMatchObject({ revision: 2, logline: 'recovered' })
  })
})

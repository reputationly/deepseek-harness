import { describe, expect, it } from 'vitest'
import { bibleFile, EMPTY_BIBLE, entryNamed, expandMentions, parseBible, serializeBible, type Bible } from '../src/bible.ts'

const bible: Bible = {
  version: 1,
  revision: 3,
  logline: 'a rainy night',
  style: { visual: 'cinematic', aspect: '9:16' },
  entries: [
    {
      id: 'c1' as never, kind: 'character', name: 'Lin', aliases: ['小林'],
      description: 'Lin in a raincoat', imageNodes: ['n1' as never, 'n2' as never],
    },
    { id: 'l1' as never, kind: 'location', name: 'Shop', aliases: [], description: 'a convenience store', imageNodes: [] },
  ],
  narrator: { voice: 'narrator-1' },
}

describe('bible', () => {
  it('reports its file name', () => {
    expect(bibleFile()).toBe('bible.json')
  })

  it('parses and serializes the bible', () => {
    const parsed = parseBible(serializeBible(bible))
    expect(parsed).toEqual(bible)
    expect(parsed.narrator).toEqual({ voice: 'narrator-1' })
  })

  it('migrates a bible without a narrator or aliases', () => {
    const parsed = parseBible(JSON.stringify({
      version: 1, revision: 0, logline: '', style: { visual: '', aspect: '16:9' },
      entries: [{ id: 'c1', kind: 'character', name: 'Lin', description: 'x' }],
    }))
    expect(parsed.entries[0]?.aliases).toEqual([])
    expect(parsed.entries[0]?.imageNodes).toEqual([])
    expect(parsed.narrator).toBeUndefined()
  })

  it('rejects malformed files', () => {
    const bad = [
      'not json',
      '[]',
      '{"version":2}',
      '{"version":1,"revision":-1,"logline":"","style":{"visual":"","aspect":"16:9"},"entries":[]}',
      '{"version":1,"revision":0,"logline":"","style":{"visual":"","aspect":"wide"},"entries":[]}',
      '{"version":1,"revision":0,"logline":"","style":{"visual":"","aspect":"16:9"}}',
      '{"version":1,"revision":0,"logline":"","style":{"visual":"","aspect":"16:9"},"entries":[{"id":"c1","kind":"animal","name":"a","description":"x"}]}',
      '{"version":1,"revision":0,"logline":"","style":{"visual":"","aspect":"16:9"},"entries":[{"id":"c1","kind":"character","name":"Lin","description":"x"},{"id":"c2","kind":"character","name":"lin","description":"y"}]}',
      '{"version":1,"revision":0,"logline":"","style":{"visual":"","aspect":"16:9"},"entries":[{"id":"c1","kind":"character","name":"Lin","description":"x","aliases":"小林"}]}',
      '{"version":1,"revision":0,"logline":"","style":{"visual":"","aspect":"16:9"},"entries":[{"id":"c1","kind":"character","name":"Lin","description":"x","voice":{"model":7}}]}',
    ]
    for (const source of bad) expect(() => parseBible(source)).toThrow()
  })

  it('expands mentions, their main images, and reports unknown names', () => {
    expect(expandMentions('@Lin walks into @Shop and @小林 waves at @Nobody', bible)).toEqual({
      prompt: 'Lin in a raincoat walks into a convenience store and Lin in a raincoat waves at @Nobody',
      imageNodes: ['n1'],
      unknown: ['@Nobody'],
    })
  })

  it('resolves a name or alias to its entry', () => {
    expect(entryNamed(bible, '小林')?.id).toBe('c1')
    expect(entryNamed(bible, 'shop')?.id).toBe('l1')
    expect(entryNamed(bible, 'nobody')).toBeUndefined()
  })

  it('rejects two entries with the same id', () => {
    expect(() => parseBible(JSON.stringify({
      version: 1, revision: 0, logline: '', style: { visual: '', aspect: '16:9' },
      entries: [
        { id: 'c1', kind: 'character', name: 'Lin', aliases: [], description: 'a' },
        { id: 'c1', kind: 'character', name: 'Chen', aliases: [], description: 'b' },
      ],
    }))).toThrow('duplicate entry id c1')
  })

  it('starts from an empty bible', () => {
    expect(EMPTY_BIBLE).toMatchObject({ revision: 0, entries: [], style: { aspect: '16:9' } })
  })
})

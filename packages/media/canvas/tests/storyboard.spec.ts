import { describe, expect, it } from 'vitest'
import { EMPTY_BIBLE, type Bible } from '../src/bible.ts'
import { bibleEntriesOf, parseScenes, validateShots } from '../src/storyboard.ts'
import type { Shot } from '../src/types.ts'

const shot = (id: string, overrides: Partial<Shot> = {}): Shot => ({
  id: id as Shot['id'],
  title: id,
  shotSize: 'medium',
  visual: 'a street',
  motion: 'walking',
  camera: 'static',
  durationSec: 3,
  characters: [],
  props: [],
  dialogue: [],
  sfx: '',
  negative: '',
  ...overrides,
})

const bible: Bible = {
  ...EMPTY_BIBLE,
  entries: [
    { id: 'c1' as never, kind: 'character', name: 'Lin', aliases: ['小林'], description: 'Lin in a raincoat', imageNodes: [] },
    { id: 'l1' as never, kind: 'location', name: 'Shop', aliases: [], description: 'a convenience store', imageNodes: [] },
  ],
}

describe('parseScenes', () => {
  it('recognizes every heading form and keeps the bodies', () => {
    const scenes = parseScenes('【场1】雨夜\n第一场正文\n\n## 场2 便利店\n第二场正文\n第3场\n第三场正文')
    expect(scenes.map(scene => [scene.number, scene.title, scene.body])).toEqual([
      [1, '雨夜', '第一场正文'],
      [2, '便利店', '第二场正文'],
      [3, '', '第三场正文'],
    ])
  })

  it('normalizes full-width digits', () => {
    expect(parseScenes('【场１】开始')[0]).toMatchObject({ number: 1, title: '开始' })
    expect(parseScenes('场 ２：中间')[0]).toMatchObject({ number: 2, title: '中间' })
  })

  it('treats a body without a heading as one scene', () => {
    expect(parseScenes('just prose')).toEqual([{ number: 1, title: '', body: 'just prose' }])
    expect(parseScenes('')).toEqual([{ number: 1, title: '', body: '' }])
  })

  it('ignores text before the first heading', () => {
    expect(parseScenes('preamble\n【场1】body').map(scene => scene.number)).toEqual([1])
  })
})

describe('validateShots', () => {
  it('accepts a table that names existing entries', () => {
    expect(validateShots([shot('s1', { characters: ['c1' as never], scene: 'l1' as never })], bible)).toEqual([])
  })

  it('reports every problem a table has', () => {
    const problems = validateShots([
      shot('s1', { title: 'x'.repeat(25), durationSec: 0, characters: ['c9' as never] }),
      shot('s1', { dialogue: [{ id: 'd1' as never, speaker: { kind: 'character', entry: 'c8' as never }, line: 'hi' }] }),
    ], bible)
    expect(problems).toEqual([
      'shot s1 title is longer than 24 characters',
      'shot s1 is shorter than 1 second',
      'shot s1 names bible entry c9 that does not exist',
      'shot s1 appears twice',
      'shot s1 line d1 names bible entry c8 that does not exist',
    ])
  })
})

describe('bibleEntriesOf', () => {
  it('lists each entry once in first-use order', () => {
    expect(bibleEntriesOf([
      shot('s1', { characters: ['c1' as never], scene: 'l1' as never }),
      shot('s2', { props: ['p1' as never], characters: ['c1' as never] }),
      shot('s3', { dialogue: [{ id: 'd1' as never, speaker: { kind: 'character', entry: 'c1' as never }, line: 'hi' }] }),
    ])).toEqual(['c1', 'l1', 'p1'])
  })
})

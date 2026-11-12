import { describe, expect, it } from 'vitest'
import { planDialogue } from '../src/voice.ts'
import type { Bible } from '@deepseek-ai/dsh-canvas'
import type { CanvasNode, DialogueLine, Shot } from '@deepseek-ai/dsh-canvas'

const bible: Bible = {
  version: 1,
  revision: 0,
  logline: '',
  style: { visual: '', aspect: '9:16' },
  entries: [
    { id: 'linxia' as never, kind: 'character', name: '林夏', aliases: [], description: '店员', imageNodes: [], voice: { voice: 'voice-lin' } },
    { id: 'chenmo' as never, kind: 'character', name: '陈默', aliases: [], description: '客人', imageNodes: [] },
  ],
  narrator: { voice: 'voice-narr' },
}

const line = (id: string, speaker: DialogueLine['speaker'], text: string): DialogueLine => ({ id: id as never, speaker, line: text })

const shot = (id: string, dialogue: readonly DialogueLine[]): Shot => ({
  id: id as never, title: id, shotSize: 'medium', visual: '', motion: '', camera: '', durationSec: 3,
  characters: [], props: [], dialogue, sfx: '', negative: '',
})

const storyboard: CanvasNode = {
  id: 'board' as never, type: 'storyboard', title: '场1', x: 0, y: 0, width: 1, height: 1,
  activeVersion: 'v1' as never,
  versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [
    shot('s1', [line('d1', { kind: 'character', entry: 'linxia' as never }, '欢迎光临。'), line('d2', { kind: 'narrator' }, '雨还在下。')]),
    shot('s2', [line('d1', { kind: 'character', entry: 'chenmo' as never }, '三点零七分，我等了三年。')]),
  ] }],
}

describe('planDialogue', () => {
  it('creates one audio node per line with its speaker voice', () => {
    const planned = planDialogue(storyboard, bible, [], 'indextts')
    expect(planned.create).toHaveLength(3)
    expect(planned.nodes.map(node => [node.kind, node.model, node.lines])).toEqual([
      ['speech', 'indextts', 1], ['speech', 'indextts', 1], ['speech', 'indextts', 1],
    ])
    const first = planned.create[0]
    expect(first).toMatchObject({
      op: 'add', type: 'audio', title: '林夏 · 欢迎光临。',
      gen: { kind: 'speech', prompt: '欢迎光临。', model: 'indextts', params: { voice: 'voice-lin' }, dialogue: { storyboard: 'board', shot: 's1', line: 'd1' } },
    })
    expect(planned.create[1]).toMatchObject({ title: '旁白 · 雨还在下。', gen: { params: { voice: 'voice-narr' } } })
    expect(planned.create[2]).toMatchObject({ title: '陈默 · 三点零七分，我等了三年。', gen: { params: {} } })
  })

  it('reuses the node that already voices a line', () => {
    const existing: CanvasNode = {
      id: 'n9' as never, type: 'audio', title: '林夏 · 欢迎光临。', x: 0, y: 0, width: 1, height: 1,
      activeVersion: 'v1' as never,
      versions: [{ id: 'v1' as never, path: '/a.mp3', createdAt: 'now', origin: 'user' }],
      gen: { kind: 'speech', prompt: '欢迎光临。', params: {}, dialogue: { storyboard: 'board' as never, shot: 's1' as never, line: 'd1' as never } },
    }
    const planned = planDialogue(storyboard, bible, [existing], 'indextts')
    expect(planned.create).toHaveLength(2)
    expect(planned.nodes.map(node => node.node)).toEqual(['n9', 'board:s1:d2', 'board:s2:d1'])
  })

  it('falls back to a generic speaker and shortens a long line', () => {
    const long = '这是一句非常长的台词，需要被标题截断，好让卡片上放得下。'
    const board: CanvasNode = {
      ...storyboard,
      versions: [{ id: 'v1' as never, createdAt: 'now', origin: 'user', shots: [shot('s1', [
        line('d1', { kind: 'character', entry: 'ghost' as never }, long),
      ])] }],
    }
    const planned = planDialogue(board, bible, [], 'm')
    expect(planned.create[0]).toMatchObject({ title: `角色 · ${long.slice(0, 12)}…` })
  })

  it('plans nothing for a storyboard without a version', () => {
    const empty: CanvasNode = { ...storyboard, versions: [], activeVersion: undefined }
    expect(planDialogue(empty, bible, [], 'm')).toEqual({ create: [], nodes: [] })
  })

  it('refuses a node that is not a storyboard', () => {
    expect(() => planDialogue({ ...storyboard, type: 'text' }, bible, [], 'm')).toThrow('is not a storyboard')
  })
})

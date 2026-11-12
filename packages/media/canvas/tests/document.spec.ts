import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import {
  activeVersionOf, assertWithinLimits, CanvasCorruptError, CanvasUnsupportedVersionError, EMPTY_CANVAS, migrateCanvas,
  parseCanvas, serializeCanvas,
} from '../src/document.ts'
import { inferRole, edgeId } from '../src/roles.ts'
import type { CanvasNode } from '../src/types.ts'

const v1 = {
  version: 1,
  nextId: 3,
  nodes: [
    { id: 'n1', type: 'image', title: 'ref', x: 0, y: 0, width: 10, height: 10, path: '/a.png', prompt: 'a cat', model: 'm1' },
    { id: 'n2', type: 'video', title: 'clip', x: 20, y: 0, width: 10, height: 10, path: '/v.mp4' },
    { id: 'n3', type: 'text', title: 'brief', x: 0, y: 20, width: 10, height: 10, text: 'hello', placed: true },
    { id: 'n4', type: 'group', title: 'group', x: 0, y: 0, width: 30, height: 30 },
  ],
  edges: [
    { id: 'n1->n2', source: 'n1', target: 'n2', kind: 'reference' },
    { id: 'n3->n2', source: 'n3', target: 'n2', kind: 'derivation' },
    { id: 'n2->n1', source: 'n2', target: 'n1', kind: 'reference' },
  ],
}

describe('roles', () => {
  it('infers the role from the node kinds', () => {
    expect(inferRole('text', 'image')).toBe('prompt')
    expect(inferRole('script', 'video')).toBe('prompt')
    expect(inferRole('storyboard', 'video')).toBe('prompt')
    expect(inferRole('image', 'image')).toBe('ref')
    expect(inferRole('image', 'video')).toBe('ref')
    expect(inferRole('image', 'timeline')).toBe('source')
    expect(inferRole('audio', 'video')).toBe('audio')
    expect(inferRole('audio', 'timeline')).toBe('source')
    expect(inferRole('video', 'timeline')).toBe('source')
    expect(inferRole('text', 'text')).toBeUndefined()
    expect(inferRole('video', 'video')).toBeUndefined()
    expect(inferRole('group', 'video')).toBeUndefined()
    expect(inferRole('text', 'group')).toBeUndefined()
  })

  it('keys derivation and reference edges apart', () => {
    expect(edgeId('n1', 'n2')).toBe('n1->n2')
    expect(edgeId('n1', 'n2', 'ref')).toBe('n1->n2:ref')
  })
})

describe('parseCanvas', () => {
  it('migrates a version-1 canvas into versions and named reference edges', () => {
    const document = parseCanvas(JSON.stringify(v1))
    expect(document.version).toBe(2)
    expect(document.revision).toBe(0)
    expect(document.nextId).toBe(3)
    const [image, , , group] = document.nodes
    expect(image?.versions).toEqual([{
      id: 'v1', path: '/a.png', prompt: 'a cat', model: 'm1', createdAt: '1970-01-01T00:00:00.000Z', origin: 'import',
    }])
    expect(image?.activeVersion).toBe('v1')
    expect(document.nodes[2]).toMatchObject({ placed: true, versions: [{ text: 'hello' }] })
    expect(group?.versions).toEqual([{ id: 'v1', createdAt: '1970-01-01T00:00:00.000Z', origin: 'import' }])
    expect(document.edges.map(edge => [edge.id, edge.kind, edge.role])).toEqual([
      ['n1->n2:ref', 'reference', 'ref'],
      ['n3->n2', 'derivation', undefined],
      // video to image has no input meaning, so the edge keeps its id and carries no role.
      ['n2->n1', 'reference', undefined],
    ])
  })

  it('round-trips a version-2 document through serialization', () => {
    const document = parseCanvas(JSON.stringify(v1))
    const again = parseCanvas(serializeCanvas(document))
    expect(again).toEqual(document)
    expect(serializeCanvas(document).endsWith('\n')).toBe(true)
  })

  it('keeps optional node fields', () => {
    const document = parseCanvas(JSON.stringify({
      version: 2,
      revision: 2,
      nextId: 2,
      nodes: [{
        id: 'n1', type: 'video', title: 'clip', x: 0, y: 0, width: 10, height: 10,
        group: 'g1', placed: true, activeVersion: 'v1', stale: true, inputChanged: true,
        bible: 'c1',
        tailOf: { node: 'n0', version: 'v3' },
        timeline: { file: 'timelines/n1.json', durationMs: 1000, exports: [{ node: 'n2', preset: 'vertical_1080', timelineRevision: 4, at: 'now' }] },
        versions: [{
          id: 'v1', path: '/v.mp4', prompt: 'p', model: 'm', params: { ratio: '9:16', audio: true, count: 2 },
          inputs: [{ node: 'n0', version: 'v2', role: 'ref', path: '/a.png' }],
          durationMs: 1000, width: 1080, height: 1920,
          beats: { bpm: 120, beatsMs: [0, 500], sections: [{ fromMs: 0, toMs: 500 }] },
          createdAt: 'now', origin: 'agent',
        }],
        gen: {
          kind: 'video', prompt: 'p', model: 'm', params: {},
          shot: { storyboard: 'n5', shots: ['s1'] },
          dialogue: { storyboard: 'n5', shot: 's1', line: 'd1' },
          tailChain: false,
        },
        status: { state: 'running', jobId: 'media-1', at: 'now', progress: 0.5 },
      }, { id: 'g1', type: 'group', title: 'g', x: 0, y: 0, width: 1, height: 1 }],
      edges: [],
    }))
    expect(document.nodes[0]).toMatchObject({
      group: 'g1', placed: true, stale: true, inputChanged: true, bible: 'c1',
      tailOf: { node: 'n0', version: 'v3' },
    })
    expect(document.nodes[0]?.versions?.[0]?.beats).toEqual({ bpm: 120, beatsMs: [0, 500], sections: [{ fromMs: 0, toMs: 500 }] })
    expect(document.nodes[0]?.gen?.tailChain).toBe(false)
    expect(document.nodes[0]?.status).toEqual({ state: 'running', jobId: 'media-1', at: 'now', progress: 0.5 })
  })

  it('parses queued and failed statuses', () => {
    const base = { version: 2, revision: 0, nextId: 2, edges: [], nodes: [] }
    const queued = parseCanvas(JSON.stringify({
      ...base,
      nodes: [{ id: 'n1', type: 'image', title: 'a', x: 0, y: 0, width: 1, height: 1, status: { state: 'queued', jobId: 'media-1', at: 'now' } }],
    }))
    expect(queued.nodes[0]?.status).toEqual({ state: 'queued', jobId: 'media-1', at: 'now' })
    const failed = parseCanvas(JSON.stringify({
      ...base,
      nodes: [{ id: 'n1', type: 'image', title: 'a', x: 0, y: 0, width: 1, height: 1, status: { state: 'failed', at: 'now', error: 'boom', retryable: true } }],
    }))
    expect(failed.nodes[0]?.status).toEqual({ state: 'failed', at: 'now', error: 'boom', retryable: true })
  })

  it('rejects a newer format without touching the file contract', () => {
    expect(() => parseCanvas('{"version":3,"revision":0,"nextId":1,"nodes":[],"edges":[]}'))
      .toThrow(CanvasUnsupportedVersionError)
    expect(() => parseCanvas('{"version":0,"nextId":1,"nodes":[],"edges":[]}')).toThrow(CanvasCorruptError)
  })

  it('rejects invalid documents', () => {
    const bad = [
      'not json',
      '[]',
      '{"version":1,"nextId":0,"nodes":[],"edges":[]}',
      '{"version":1,"nextId":1,"nodes":{},"edges":[]}',
      '{"version":1,"nextId":1,"nodes":[],"edges":{}}',
      '{"version":1,"nextId":1,"nodes":[{"id":"n1"}],"edges":[]}',
      '{"version":1,"nextId":1,"nodes":[{"id":"n1","type":"nope","title":"t","x":0,"y":0,"width":1,"height":1}],"edges":[]}',
      '{"version":1,"nextId":1,"nodes":[{"id":"n1","type":"image","title":"t","x":0,"y":0,"width":1,"height":1},{"id":"n1","type":"image","title":"t","x":0,"y":0,"width":1,"height":1}],"edges":[]}',
      '{"version":1,"nextId":1,"nodes":[],"edges":[{"source":"n1","target":"n2","kind":"reference"}]}',
      '{"version":1,"nextId":1,"nodes":[{"id":"g1","type":"group","title":"g","x":0,"y":0,"width":1,"height":1,"group":"g1"}],"edges":[]}',
      '{"version":1,"nextId":1,"nodes":[{"id":"n1","type":"text","title":"t","x":0,"y":0,"width":1,"height":1,"group":"g9"}],"edges":[]}',
      '{"version":1,"nextId":1,"nodes":[{"id":"n1","type":"image","title":"t","x":"0","y":0,"width":1,"height":1}],"edges":[]}',
      '{"version":1,"nextId":1,"nodes":[{"id":"n1","type":"image","title":"t","x":0,"y":0,"width":1,"height":1,"path":7}],"edges":[]}',
    ]
    for (const source of bad) expect(() => parseCanvas(source)).toThrow(CanvasCorruptError)
  })

  it('rejects a role on a derivation edge and a malformed reference id', () => {
    const node = (id: string, type: string): Record<string, unknown> => ({ id, type, title: id, x: 0, y: 0, width: 1, height: 1 })
    const document = (edges: readonly Record<string, unknown>[]): string => JSON.stringify({
      version: 2, revision: 0, nextId: 3, nodes: [node('n1', 'image'), node('n2', 'image')], edges,
    })
    expect(() => parseCanvas(document([{ id: 'n1->n2', source: 'n1', target: 'n2', kind: 'derivation', role: 'ref' }])))
      .toThrow('carries a role')
    expect(() => parseCanvas(document([{ id: 'n1->n2', source: 'n1', target: 'n2', kind: 'reference', role: 'ref' }])))
      .toThrow('does not match its endpoints')
    expect(() => parseCanvas(document([{ id: 'n1->n2:ref', source: 'n1', target: 'n2', kind: 'reference', role: 'ref', order: 0 }, { id: 'n1->n2:ref', source: 'n1', target: 'n2', kind: 'reference', role: 'ref' }])))
      .toThrow('duplicate edge')
    expect(() => parseCanvas(document([{ id: 'n1->n2', source: 'n1', target: 'n2', kind: 'derivation', order: 1 }])))
      .toThrow('carries an order')
  })

  it('rejects unknown roles, kinds, and shot fields', () => {
    const node = (extra: Record<string, unknown>): string => JSON.stringify({
      version: 2, revision: 0, nextId: 2,
      nodes: [{ id: 'n1', type: 'video', title: 'v', x: 0, y: 0, width: 1, height: 1, versions: [{ id: 'v1', createdAt: 'now', origin: 'user', ...extra }] }],
      edges: [],
    })
    expect(() => parseCanvas(node({ params: { a: {} } }))).toThrow('is not a string, number, or boolean')
    expect(() => parseCanvas(node({ origin: 'robot' }))).toThrow('unknown value')
    expect(() => parseCanvas(JSON.stringify({
      version: 2, revision: 0, nextId: 2,
      nodes: [{ id: 'n1', type: 'video', title: 'v', x: 0, y: 0, width: 1, height: 1, gen: { kind: 'hologram', prompt: 'p' } }],
      edges: [],
    }))).toThrow('unknown value')
    expect(() => parseCanvas(JSON.stringify({
      version: 2, revision: 0, nextId: 2,
      nodes: [{ id: 'n1', type: 'storyboard', title: 's', x: 0, y: 0, width: 1, height: 1, versions: [{ id: 'v1', createdAt: 'now', origin: 'user', shots: [{ id: 's1', title: 't', shotSize: 'huge', visual: '', motion: '', camera: '', durationSec: 1, characters: [], props: [], dialogue: [], sfx: '', negative: '' }] }] }],
      edges: [],
    }))).toThrow('unknown value')
    expect(() => parseCanvas(JSON.stringify({
      version: 2, revision: 0, nextId: 2,
      nodes: [{ id: 'n1', type: 'storyboard', title: 's', x: 0, y: 0, width: 1, height: 1, versions: [{ id: 'v1', createdAt: 'now', origin: 'user', shots: [{ id: 's1', title: 't', shotSize: 'close', visual: '', motion: '', camera: '', durationSec: 1, characters: ['c1'], props: [], dialogue: [{ id: 'd1', speaker: { kind: 'character' }, line: 'x' }], sfx: '', negative: '' }] }] }],
      edges: [],
    }))).toThrow('speaker.entry is not a string')
  })

  it('rejects documents that exceed the deployment bounds', () => {
    const limits = resolveConfig({ maxNodes: 1, maxEdges: 1, maxPromptLength: 2, maxShotsPerStoryboard: 1 })
    const document = parseCanvas(JSON.stringify(v1))
    expect(() => assertWithinLimits(document, limits)).toThrow('nodes')
    expect(() => assertWithinLimits(EMPTY_CANVAS, limits)).not.toThrow()
    const manyEdges = parseCanvas(JSON.stringify({
      version: 2, revision: 0, nextId: 3,
      nodes: [
        { id: 'n1', type: 'image', title: 'a', x: 0, y: 0, width: 1, height: 1 },
        { id: 'n2', type: 'image', title: 'b', x: 0, y: 0, width: 1, height: 1 },
      ],
      edges: [
        { id: 'n1->n2', source: 'n1', target: 'n2', kind: 'derivation' },
        { id: 'n2->n1', source: 'n2', target: 'n1', kind: 'derivation' },
      ],
    }))
    expect(() => assertWithinLimits(manyEdges, resolveConfig({ maxEdges: 1 }))).toThrow('edges')
    const longPrompt = parseCanvas(JSON.stringify({
      version: 2, revision: 0, nextId: 2,
      nodes: [{ id: 'n1', type: 'image', title: 'a', x: 0, y: 0, width: 1, height: 1, gen: { kind: 'image', prompt: 'long', params: {} } }],
      edges: [],
    }))
    expect(() => assertWithinLimits(longPrompt, limits)).toThrow('prompt exceeds')
  })

  it('parses through the limits when the caller passes them', () => {
    const limits = resolveConfig({ maxNodes: 1 })
    expect(() => parseCanvas(JSON.stringify(v1), limits)).toThrow('nodes')
  })

  it('migrates through migrateCanvas directly and rejects dangling edges', () => {
    expect(migrateCanvas(v1).version).toBe(2)
    expect(() => migrateCanvas({ ...v1, edges: [{ source: 'n9', target: 'n1', kind: 'reference' }] })).toThrow('missing node')
    expect(() => migrateCanvas({ ...v1, edges: [{ source: 'n1', target: 'n2', kind: 'weird' }] })).toThrow('unknown kind')
  })

  it('reports the active version and falls back to the last stored one', () => {
    const node: CanvasNode = {
      id: 'n1' as CanvasNode['id'], type: 'text', title: 't', x: 0, y: 0, width: 1, height: 1,
      versions: [
        { id: 'v1' as never, text: 'one', createdAt: 'now', origin: 'user' },
        { id: 'v2' as never, text: 'two', createdAt: 'now', origin: 'user' },
      ],
      activeVersion: 'v1' as never,
    }
    expect(activeVersionOf(node)?.text).toBe('one')
    const { activeVersion: _active, ...withoutActive } = node
    expect(activeVersionOf(withoutActive)?.text).toBe('two')
    expect(activeVersionOf({ ...node, versions: [] })).toBeUndefined()
    const { versions: _versions, ...withoutVersions } = node
    expect(activeVersionOf(withoutVersions)).toBeUndefined()
  })
})

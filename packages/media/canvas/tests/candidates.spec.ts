/** Adoption is an explicit edit; candidates preserve existing choices and referenced versions. */
import { expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { resolveConfig } from '../src/config.ts'
import { EMPTY_CANVAS, parseCanvas, serializeCanvas } from '../src/document.ts'
import { applyOperations } from '../src/operations.ts'
import { activeVersionOf, previewVersionOf } from '../src/versions.ts'
import type { CanvasDocument, CanvasNodeId, CanvasOperation, VersionId } from '../src/types.ts'

const limits = resolveConfig({ versionLimit: 1 })
const now = () => '2026-11-14T00:00:00.000Z'
const edit = (document: CanvasDocument, operations: readonly CanvasOperation[]) =>
  applyOperations(document, operations, { limits, now }).document

it.each(['image', 'video', 'audio'] as const)('keeps the first generated %s as an unadopted preview', (type) => {
  const document = edit(EMPTY_CANVAS, [
    {
      op: 'add',
      ref: 'draft',
      type,
      gen: { kind: type === 'audio' ? 'music' : type, prompt: 'a new draft', params: {} },
    },
    {
      op: 'append_version',
      node: 'draft',
      version: { id: 'result', path: '/result', createdAt: now(), origin: 'agent' },
    },
  ])
  const node = document.nodes[0]!
  expect(node.activeVersion).toBeUndefined()
  expect(activeVersionOf(node)).toBeUndefined()
  expect(previewVersionOf(node)?.id).toBe('result')
  expect(parseCanvas(serializeCanvas(document))).toEqual(document)
  const adopted = edit(document, [{ op: 'set_version', node: node.id, version: 'result' }])
  expect(activeVersionOf(adopted.nodes[0]!)?.path).toBe('/result')
  expect(edit(adopted, [{ op: 'set_version', node: node.id, version: null }]).nodes[0]?.activeVersion).toBeUndefined()
})

it('retains the adopted choice and newest candidate with a one-version recent-history limit', () => {
  const initial = edit(EMPTY_CANVAS, [{ op: 'add', type: 'audio', path: '/import.wav' }])
  const document = edit(initial, [
    {
      op: 'append_version',
      node: 'n1',
      version: { id: 'candidate-1', path: '/one.wav', createdAt: now(), origin: 'agent' },
    },
    {
      op: 'append_version',
      node: 'n1',
      version: { id: 'candidate-2', path: '/two.wav', createdAt: now(), origin: 'agent' },
    },
  ])
  expect(document.nodes[0]?.versions?.map(version => version.id)).toEqual(['v1', 'candidate-2'])
  expect(activeVersionOf(document.nodes[0]!)?.path).toBe('/import.wav')
})

it('pins a source version consumed by another candidate after a different source is adopted', () => {
  const initial = edit(EMPTY_CANVAS, [
    { op: 'add', type: 'audio', path: '/original.wav' },
    {
      op: 'add',
      type: 'audio',
      path: '/derived.wav',
      candidate: true,
      inputs: [
        {
          node: brandString<CanvasNodeId>('n1'),
          version: brandString<VersionId>('v1'),
          path: '/original.wav',
          role: 'source',
        },
      ],
    },
  ])
  const document = edit(initial, [
    {
      op: 'append_version',
      node: 'n1',
      version: { id: 'other', path: '/other.wav', createdAt: now(), origin: 'agent' },
    },
    { op: 'set_version', node: 'n1', version: 'other' },
    {
      op: 'append_version',
      node: 'n1',
      version: { id: 'latest', path: '/latest.wav', createdAt: now(), origin: 'agent' },
    },
  ])
  expect(document.nodes[0]?.versions?.map(version => version.id)).toEqual(['v1', 'other', 'latest'])
  expect(document.nodes[1]?.activeVersion).toBeUndefined()
})

it('changes downstream review state on adoption, while appending a candidate leaves it unchanged', () => {
  const initial = edit(EMPTY_CANVAS, [
    { op: 'add', ref: 'source', type: 'image', path: '/import.png' },
    { op: 'add', ref: 'video', type: 'video', gen: { kind: 'video', prompt: 'a scene', params: {} } },
    { op: 'connect', from: 'source', to: 'video', kind: 'reference', role: 'first_frame' },
    {
      op: 'append_version',
      node: 'source',
      version: { id: 'candidate', path: '/candidate.png', createdAt: now(), origin: 'agent' },
    },
  ])
  expect(initial.nodes[1]?.inputChanged).toBeUndefined()
  expect(edit(initial, [{ op: 'set_version', node: 'n1', version: 'candidate' }]).nodes[1]?.inputChanged).toBe(true)
})

it('does not guess which legacy video version produced a cached tail frame', () => {
  const initial = edit(EMPTY_CANVAS, [
    { op: 'add', type: 'video', path: '/old.mp4' },
    {
      op: 'append_version',
      node: 'n1',
      version: { id: 'newer', path: '/newer.mp4', createdAt: now(), origin: 'agent' },
    },
    { op: 'add', type: 'image', path: '/tail.png' },
  ])
  const legacy = {
    ...initial,
    version: 2,
    nodes: initial.nodes.map(node => (node.id === 'n1' ? { ...node, tailOf: { node: 'n2', version: 'v1' } } : node)),
  }
  const restored = parseCanvas(JSON.stringify(legacy)).nodes[0]!
  expect(restored.activeVersion).toBe('v1')
  expect(restored.tailOf?.sourceVersion).toBeUndefined()
})

it('migrates legacy selections while preserving unadopted format-3 candidates', () => {
  const initial = edit(EMPTY_CANVAS, [
    { op: 'add', type: 'video', path: '/first.mp4' },
    {
      op: 'append_version',
      node: 'n1',
      version: { id: 'second', path: '/second.mp4', createdAt: now(), origin: 'agent' },
    },
  ])
  expect(parseCanvas(JSON.stringify({ ...initial, version: 2 })).nodes[0]?.activeVersion).toBe('v1')
  const cleared = edit(initial, [{ op: 'set_version', node: 'n1', version: null }])
  expect(parseCanvas(JSON.stringify({ ...cleared, version: 2 })).nodes[0]?.activeVersion).toBe('second')
  expect(parseCanvas(serializeCanvas(cleared)).nodes[0]?.activeVersion).toBeUndefined()
})

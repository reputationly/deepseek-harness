// @vitest-environment jsdom
/** The inspector renders catalog controls, reorders references, and turns edits into canvas operations. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasDocument, CanvasNode } from '@deepseek-ai/dsh-canvas/client'
import { Inspector, type InspectorProps } from '../src/client/Inspector.tsx'
import { useGenerationControls } from '../src/client/GenerationControls.tsx'

afterEach(() => { cleanup() })

const t = (key: string, params?: Record<string, unknown>) => params === undefined ? key : `${key}:${JSON.stringify(params)}`

const video: CanvasNode = {
  id: 'v1' as never, type: 'video', title: '场1 段1', x: 0, y: 0, width: 320, height: 220,
  activeVersion: 'v2' as never,
  versions: [
    { id: 'v1' as never, createdAt: 'now', origin: 'user', path: '/a.mp4', model: 'old' },
    { id: 'v2' as never, createdAt: 'now', origin: 'agent', path: '/b.mp4', model: 'new' },
  ],
  gen: { kind: 'video', prompt: '雨夜', model: 'video-model', params: { duration: 6 } },
}

const document: CanvasDocument = {
  version: 2, revision: 1, nextId: 5, edges: [
    { id: 'a->v1:ref', source: 'a' as never, target: 'v1' as never, kind: 'reference', role: 'ref', order: 0 },
    { id: 'b->v1:ref', source: 'b' as never, target: 'v1' as never, kind: 'reference', role: 'ref', order: 1 },
    { id: 'f->v1:first_frame', source: 'f' as never, target: 'v1' as never, kind: 'reference', role: 'first_frame' },
  ],
  nodes: [
    video,
    { id: 'a' as never, type: 'image', title: '林夏', x: 0, y: 0, width: 100, height: 100 },
    { id: 'b' as never, type: 'image', title: '场景', x: 0, y: 0, width: 100, height: 100 },
    { id: 'f' as never, type: 'image', title: '首帧图', x: 0, y: 0, width: 100, height: 100 },
  ],
}

const capabilities = vi.fn(async () => [{
  id: 'cap', model: 'video-model', operation: 'generate_video',
  params: [
    { id: 'duration', options: ['5', '10'], default: '5' },
    { id: 'resolution', options: ['2K'], default: '2K' },
  ],
}])

type GenerationProps = Parameters<typeof useGenerationControls>[0]
type TestProps = Partial<InspectorProps> & Pick<GenerationProps, 'planNodes' | 'generateNodes'>

function mount(overrides: TestProps = {}) {
  const edit = vi.fn(async () => {})
  const close = vi.fn()
  const { planNodes, generateNodes, ...inspectorProps } = overrides
  const Harness = () => {
    const { generate: overrideGenerate, ...baseProps } = inspectorProps
    const generation = useGenerationControls({
      document: baseProps.document ?? document,
      ...planNodes === undefined ? {} : { planNodes },
      ...generateNodes === undefined ? {} : { generateNodes },
      t: baseProps.t ?? t,
    })
    const generate = overrideGenerate ?? (planNodes === undefined || generateNodes === undefined
      ? undefined
      : (nodeId: string) => { generation.generate([nodeId]) })
    return <>
      <Inspector document={document} node={video} placement="sidebar" capabilities={capabilities}
        edit={edit} close={close} t={t} {...baseProps}
        {...generate === undefined ? {} : { generate }} />
      {generation.feedback}
    </>
  }
  render(<Harness />)
  return { edit, close }
}

function GenerationProbe({ document, planNodes, generateNodes, t }: GenerationProps) {
  const generation = useGenerationControls({
    document,
    ...planNodes === undefined ? {} : { planNodes },
    ...generateNodes === undefined ? {} : { generateNodes },
    t,
  })
  return <>
    <button onClick={() => { generation.generate(['missing']) }}>Generate</button>
    {generation.feedback}
  </>
}

it('lists the model, its catalog parameters, and the node prompt', async () => {
  mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalledWith('generate_video') })
  expect((screen.getByLabelText('inspector.model') as HTMLSelectElement).value).toBe('video-model')
  const duration = screen.getByLabelText('duration') as HTMLSelectElement
  expect(duration.value).toBe('6')
  expect((screen.getByLabelText('resolution') as HTMLSelectElement).value).toBe('2K')
  expect((screen.getByLabelText('inspector.prompt') as HTMLTextAreaElement).value).toBe('雨夜')
})

it('applies model, prompt, and numeric parameters as one generation update', async () => {
  const h = mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.change(screen.getByLabelText('duration'), { target: { value: '10' } })
  fireEvent.change(screen.getByLabelText('inspector.prompt'), { target: { value: '新提示' } })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.apply' }))
  expect(h.edit).toHaveBeenCalledWith([{
    op: 'set_gen', node: 'v1', gen: { model: 'video-model', prompt: '新提示', params: { duration: 10 } },
  }])
})

it('reorders references by drag and removes one', async () => {
  const h = mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  const rows = screen.getAllByRole('listitem').filter(row => row.textContent?.includes('林夏') || row.textContent?.includes('场景'))
  fireEvent.dragStart(rows[0] as HTMLElement)
  fireEvent.dragOver(rows[1] as HTMLElement)
  fireEvent.drop(rows[1] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'reorder_refs', node: 'v1', sources: ['b', 'a'] }])
  fireEvent.click(screen.getAllByRole('button', { name: 'inspector.removeReference' })[0] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'disconnect', from: 'a', to: 'v1', role: 'ref' }])
})

it('clears a frame slot and switches the shown version', async () => {
  const h = mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.clearFrame' }))
  expect(h.edit).toHaveBeenCalledWith([{ op: 'disconnect', from: 'f', to: 'v1', role: 'first_frame' }])
  fireEvent.click(screen.getAllByRole('button', { name: 'inspector.useVersion' })[0] as HTMLElement)
  expect(h.edit).toHaveBeenCalledWith([{ op: 'set_version', node: 'v1', version: 'v1' }])
})

it('closes through its header button and opens the table editor for a storyboard', async () => {
  const openTable = vi.fn()
  const { gen: _gen, ...rest } = video
  void _gen
  const h = mount({ node: { ...rest, type: 'storyboard' }, openTable })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'inspector.close' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.close' }))
  expect(h.close).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'inspector.openTable' }))
  expect(openTable).toHaveBeenCalledWith('v1')
})

it('asks for the budget and starts generation once the user confirms', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'needs_confirmation' as const, token: 'tok', lines: [{ node: 'v1', kind: 'video', model: 'video-model', calls: 2, seconds: 12 }],
    totals: { videoCalls: 2, videoSeconds: 12, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => ({
    state: 'started' as const, lines: [], totals: { videoCalls: 2, videoSeconds: 12, imageCalls: 0, speechLines: 0, musicCalls: 0 },
    jobs: [{ node: 'v1', jobId: 'j1' }],
  }))
  mount({ planNodes, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('dialog', { name: 'budget.title' })).toBeTruthy() })
  expect(screen.getByText(/budget.totals/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'budget.confirm' }))
  await waitFor(() => { expect(generateNodes).toHaveBeenCalledWith(['v1'], 'tok') })
  expect(screen.getByRole('status').textContent).toContain('inspector.started')
})

it('does not plan when either generation endpoint is unavailable', () => {
  const planNodes = vi.fn(async () => undefined)
  const generateNodes = vi.fn(async () => undefined)
  const { rerender } = render(<GenerationProbe document={document} planNodes={planNodes} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  expect(planNodes).not.toHaveBeenCalled()
  rerender(<GenerationProbe document={document} generateNodes={generateNodes} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  expect(generateNodes).not.toHaveBeenCalled()
})

it('falls back to the node id when a budget line has no document title', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'needs_confirmation' as const, token: 'tok',
    lines: [{ node: 'missing', kind: 'video', model: 'video-model', calls: 1, seconds: 3 }],
    totals: { videoCalls: 1, videoSeconds: 3, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => undefined)
  const emptyDocument: CanvasDocument = { ...document, nodes: [] }
  for (const current of [undefined, emptyDocument]) {
    const rendered = render(<GenerationProbe document={current} planNodes={planNodes} generateNodes={generateNodes} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => { expect(screen.getByRole('dialog', { name: 'budget.title' })).toBeTruthy() })
    expect(screen.getByText(/"node":"missing"/)).toBeTruthy()
    rendered.unmount()
  }
})

it('does not start from a confirmation after the generation endpoint disappears', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'needs_confirmation' as const, token: 'tok',
    lines: [{ node: 'missing', kind: 'video', model: 'video-model', calls: 1, seconds: 3 }],
    totals: { videoCalls: 1, videoSeconds: 3, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => undefined)
  const { rerender } = render(<GenerationProbe document={document} planNodes={planNodes} generateNodes={generateNodes} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
  await waitFor(() => { expect(screen.getByRole('dialog', { name: 'budget.title' })).toBeTruthy() })
  rerender(<GenerationProbe document={document} planNodes={planNodes} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: 'budget.confirm' }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(generateNodes).not.toHaveBeenCalled()
})

it('reopens confirmation with the revised budget when the confirmed plan is stale', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'needs_confirmation' as const, token: 'tok-old',
    lines: [{ node: 'v1', kind: 'video', model: 'video-model', calls: 1, seconds: 5 }],
    totals: { videoCalls: 1, videoSeconds: 5, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn()
    .mockResolvedValueOnce({
      state: 'needs_confirmation' as const, token: 'tok-new',
      lines: [{ node: 'v1', kind: 'video', model: 'video-model', calls: 3, seconds: 18 }],
      totals: { videoCalls: 3, videoSeconds: 18, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
    })
    .mockResolvedValueOnce({
      state: 'started' as const, lines: [], totals: { videoCalls: 3, videoSeconds: 18, imageCalls: 0, speechLines: 0, musicCalls: 0 },
      jobs: [{ node: 'v1', jobId: 'j1' }],
    })
  mount({ planNodes, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('dialog', { name: 'budget.title' })).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'budget.confirm' }))
  await waitFor(() => { expect(screen.getByText('budget.changed')).toBeTruthy() })
  expect(screen.getByRole('dialog', { name: 'budget.title' })).toBeTruthy()
  expect(screen.getByText(/"calls":3/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'budget.confirm' }))
  await waitFor(() => { expect(generateNodes).toHaveBeenNthCalledWith(2, ['v1'], 'tok-new') })
  expect(screen.getByRole('status').textContent).toContain('inspector.started')
})

it('starts a plan that needs no confirmation directly', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'ready' as const, lines: [], totals: { videoCalls: 1, videoSeconds: 5, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => ({
    state: 'started' as const, lines: [], totals: { videoCalls: 1, videoSeconds: 5, imageCalls: 0, speechLines: 0, musicCalls: 0 },
    jobs: [{ node: 'v1', jobId: 'j1' }],
  }))
  mount({ planNodes, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(generateNodes).toHaveBeenCalledWith(['v1'], undefined) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('reports a blocked or running plan without starting work', async () => {
  const blocked = vi.fn(async () => ({
    state: 'blocked' as const, message: 'G1_stage_order: 先完成设定集',
    lines: [], totals: { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn()
  mount({ planNodes: blocked, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('G1_stage_order') })
  expect(generateNodes).not.toHaveBeenCalled()
})

it('surfaces a planning failure in the inspector', async () => {
  const planNodes = vi.fn(async () => { throw new Error('canvas node missing') })
  mount({ planNodes, generateNodes: vi.fn() })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('canvas node missing') })
})

it('keeps the generate button away when the deployment has no media namespace', async () => {
  mount()
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  expect(screen.queryByRole('button', { name: 'inspector.generateNow' })).toBeNull()
})

it('edits a free-text parameter and switches the model choice', async () => {
  const edit = vi.fn(async () => {})
  const capabilities = vi.fn(async () => [{
    id: 'cap', model: 'video-model', operation: 'generate_video',
    params: [{ id: 'note', type: 'string' }, { id: 'other', options: ['a', 'b'] }],
  }, { id: 'cap2', model: 'second-model', operation: 'generate_video', params: [] }])
  mount({ capabilities, edit })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.change(screen.getByLabelText('note'), { target: { value: '自由文本' } })
  fireEvent.change(screen.getByLabelText('inspector.model'), { target: { value: 'second-model' } })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.apply' }))
  expect(edit).toHaveBeenCalledWith([{
    op: 'set_gen', node: 'v1', gen: { model: 'second-model', prompt: '雨夜', params: { duration: 6, note: '自由文本' } },
  }])
})

it('cancels the budget dialog and reports a failure to start generation', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'needs_confirmation' as const, token: 'tok',
    lines: [{ node: 'v1', kind: 'video', model: 'video-model', calls: 1, seconds: 5 }],
    totals: { videoCalls: 1, videoSeconds: 5, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => { throw new Error('gateway down') })
  mount({ planNodes, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'budget.cancel' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'budget.confirm' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('gateway down') })
})

it('does nothing when the deployment declines to plan, and ignores a drop without a drag', async () => {
  const planNodes = vi.fn(async () => undefined)
  mount({ planNodes, generateNodes: vi.fn() })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(planNodes).toHaveBeenCalledWith(['v1']) })
  const first = screen.getAllByRole('listitem').find(row => row.textContent?.includes('林夏')) as HTMLElement
  fireEvent.drop(first)
  fireEvent.dragStart(first)
  fireEvent.drop(first)
})

it('applies the default model and reports plain-string failures', async () => {
  const planNodes = vi.fn(async () => { throw 'raw failure' })
  const generateNodes = vi.fn(async () => undefined)
  mount({ planNodes, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.apply' }))
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('raw failure') })
})

it('reports a non-Error rejection after confirming the budget', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'needs_confirmation' as const, token: 't', lines: [],
    totals: { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  const generateNodes = vi.fn(async () => { throw 'plain' })
  mount({ planNodes, generateNodes })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('dialog')).toBeTruthy() })
  fireEvent.click(screen.getByRole('button', { name: 'budget.confirm' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('plain') })
})

it('shows a numeric parameter control and a missing reference name', async () => {
  const capabilities = vi.fn(async () => [{
    id: 'c', model: 'video-model', operation: 'generate_video', params: [{ id: 'seed', type: 'number', default: '1' }],
  }])
  mount({ capabilities })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  expect((screen.getByLabelText('seed') as HTMLInputElement).type).toBe('number')
})

it('applies the deployment default model when none was chosen', async () => {
  const edit = vi.fn(async () => {})
  mount({ edit })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.change(screen.getByLabelText('inspector.model'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.apply' }))
  expect(edit).toHaveBeenCalledWith([{ op: 'set_gen', node: 'v1', gen: { prompt: '雨夜', params: { duration: 6 } } }])
})

it('shows the reference source id when the document lost that node', async () => {
  mount({
    document: {
      ...document,
      nodes: document.nodes.filter(node => node.id !== 'a'),
    } as never,
    capabilities,
  })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  expect(screen.getByText('a')).toBeTruthy()
})

it('reports an already-running plan without a message', async () => {
  const planNodes = vi.fn(async () => ({
    state: 'already_running' as const, lines: [],
    totals: { videoCalls: 0, videoSeconds: 0, imageCalls: 0, speechLines: 0, musicCalls: 0 }, jobs: [],
  }))
  mount({ planNodes, generateNodes: vi.fn() })
  await waitFor(() => { expect(capabilities).toHaveBeenCalled() })
  fireEvent.click(screen.getByRole('button', { name: 'inspector.generateNow' }))
  await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('already_running') })
})

it('stops loading models when the inspector unmounts first', async () => {
  let resolveModels: (value: readonly unknown[]) => void = () => {}
  const capabilities = vi.fn(() => new Promise<readonly never[]>((resolve) => { resolveModels = resolve as never }))
  mount({ capabilities })
  cleanup()
  resolveModels([])
  await new Promise(resolve => setTimeout(resolve, 10))
})

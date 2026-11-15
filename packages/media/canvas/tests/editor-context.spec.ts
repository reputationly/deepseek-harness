/** Editor hints are materialized by the production loop as logged runtime context. */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor, type Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderContextSections } from '@deepseek-ai/dsh-system-prompt'
import CanvasService from '../src/index.ts'
import type { CanvasEditorContext, CanvasNodeId, EpisodeId, VersionId } from '../src/types.ts'

class EditorAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  onRequest?: () => void
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onRequest?.()
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let ctx: Context, directory: string
afterEach(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
async function fixture(includeRuntimeContext = true) {
  directory = await mkdtemp(join(tmpdir(), 'dsh-editor-context-'))
  ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { includeRuntimeContext } })
  provideWorkingDirectoryFixture(ctx, directory)
  await ctx.plugin(CanvasService)
  const adapter = new EditorAdapter()
  ctx.llm.registerAdapter(['editor-fixture'], adapter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('editor'), { provider: 'editor-fixture', model: 'fixture' })
  const context: CanvasEditorContext = { scope: { directory, episode: brandString<EpisodeId>('e1') }, application: 'music', revision: 7,
    available: true, dirty: true, node: brandString<CanvasNodeId>('n1'), version: brandString<VersionId>('candidate') }
  return { agent, adapter, context, harness }
}
async function send(agent: Agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Review this selection.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

it('logs exact candidate selection and draft state before the model request without saving project files', async () => {
  const { agent, adapter, context } = await fixture()
  let loggedBeforeRequest = false
  adapter.onRequest = () => { loggedBeforeRequest = agent.session.snapshotEvents().some(event =>
    event.type === 'user/message' && event.data.source.kind === 'runtime-context' && JSON.stringify(event.data).includes('canvas:editor')) }
  ctx.canvas.editorContext(agent.session, context)
  await send(agent)
  const events = agent.session.snapshotEvents()
  const snapshot = events.find(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
  expect(snapshot?.type).toBe('user/message')
  if (snapshot?.type !== 'user/message' || snapshot.data.source.kind !== 'runtime-context' || snapshot.data.source.form !== 'snapshot') throw new Error('No logged runtime context')
  const section = snapshot.data.source.sections.find(section => section.name === 'canvas:editor')
  expect(section?.text).toContain(JSON.stringify(context))
  expect(JSON.stringify(adapter.requests[0])).toContain('candidate')
  expect(loggedBeforeRequest).toBe(true)
  expect(await readdir(directory)).toEqual([])

  ctx.canvas.editorContext(agent.session)
  await send(agent)
  const updated = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')
  expect(updated).toHaveLength(2)
  expect(JSON.stringify(updated.at(-1))).not.toContain('canvas:editor')
})

it('does not share hints across Sessions and clears a rejected project-switch hint', async () => {
  const { agent, context, harness } = await fixture()
  ctx.canvas.editorContext(agent.session, context)
  const other = await harness.create(SessionId('other'), { provider: 'editor-fixture', model: 'fixture' })
  expect(renderContextSections(await ctx.systemPrompt.assemble(assembleContextFor(other)))).toEqual([])
  expect(() => { ctx.canvas.editorContext(agent.session, { ...context, scope: { ...context.scope, directory: `${directory}-other` } }) })
    .toThrow(expect.objectContaining({ code: 'canvas/invalid-input' }))
  expect(renderContextSections(await ctx.systemPrompt.assemble(assembleContextFor(agent)))).toEqual([])
})

it('honors disabled optional runtime context even when an editor publishes a hint', async () => {
  const { agent, context } = await fixture(false)
  ctx.canvas.editorContext(agent.session, context)
  await send(agent)
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context')).toBe(false)
})

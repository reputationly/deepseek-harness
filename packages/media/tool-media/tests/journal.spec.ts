/** Real file checkpoints and canvas writes, with barriers at external side effects. */
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CanvasConflictError, type CanvasNodeId, type CanvasOperation } from '@deepseek-ai/dsh-canvas'
import { resolveConfig } from '@deepseek-ai/dsh-canvas/src/config.ts'
import { applyOperations } from '@deepseek-ai/dsh-canvas/src/operations.ts'
import { CanvasStore, canvasFile } from '@deepseek-ai/dsh-canvas/src/store.ts'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import { FileMediaJournal, type MediaAttemptId, type MediaCheckpoint, type MediaJournal } from '../src/journal.ts'
import { MediaGatewayError, MediaSubmissionRejectedError } from '../src/gateway.ts'
import { createRunnerState, MediaInterruptedError, recoverInterrupted, runPlan, startPlan, type GeneratedMedia, type MediaCall, type MediaGenerator, type MediaJob, type RunnerServices } from '../src/runner.ts'
import { bibleFixture } from './bible-fixture.ts'

let directory: string
let store: CanvasStore
let journal: FileMediaJournal
let pending: Promise<GeneratedMedia>[]
let controllers: Map<JobId, AbortController>
let failAppend: 'before' | 'after' | undefined
let releaseProducers: (() => void)[]
const node = brandString<CanvasNodeId>('n1')
const limits = resolveConfig({})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-media-journal-'))
  store = new CanvasStore(limits)
  journal = new FileMediaJournal(join(directory, '.canvas', 'canvas.json.media'))
  pending = []
  controllers = new Map()
  failAppend = undefined
  releaseProducers = []
})

afterEach(async () => {
  for (const release of releaseProducers) release()
  for (const controller of controllers.values()) controller.abort('test cleanup')
  await Promise.allSettled(pending)
  await rm(directory, { recursive: true, force: true })
})

function producerBarrier() {
  const barrier = Promise.withResolvers<undefined>()
  releaseProducers.push(() => { barrier.resolve(undefined) })
  return barrier
}

async function edit(operations: readonly CanvasOperation[], baseRevision?: number) {
  return store.updateCanvas(directory, 'canvas.json', (current) => {
    if (baseRevision !== undefined && current.revision !== baseRevision) throw new CanvasConflictError(baseRevision, current.revision)
    const outcome = applyOperations(current, operations, { limits })
    return { document: outcome.document, value: outcome.result }
  })
}

async function seed(type: 'image' | 'video' = 'image') {
  await edit([{ op: 'add', type, title: 'media', gen: { kind: type, prompt: 'a street', params: {} } }])
}

function fixture() {
  const image = vi.fn(async (call: MediaCall): Promise<GeneratedMedia> => {
    const media = { path: join(directory, 'image.png'), model: call.entry.model }
    await call.onArtifact?.(media)
    await writeFile(media.path, 'complete image')
    return media
  })
  const generator: MediaGenerator = { image, video: image, speech: image, music: image }
  const services: RunnerServices = {
    state: createRunnerState(),
    journal,
    canvas: {
      read: async () => {
        const document = await store.readCanvas(directory)
        return { document, revision: document.revision }
      },
      bible: async () => bibleFixture,
      edit: async (operations, revision) => {
        const fail = operations.some(operation => operation.op === 'append_version') ? failAppend : undefined
        if (fail !== undefined) failAppend = undefined
        if (fail === 'before') throw new Error('injected canvas failure before commit')
        const result = await edit(operations, revision)
        if (fail === 'after') throw new Error('injected acknowledgement loss after commit')
        return result
      },
    },
    limits: { maxVideoSeconds: 15, minVideoSeconds: 4, videoDefaultDuration: 5, videoModel: 'm', videoRefModel: 'm', imageModel: 'm', speechModel: 'm', musicModel: 'm' },
    confirmLimits: {
      confirmVideoCalls: 10, confirmVideoSeconds: 100, confirmSpeechLines: 100, confirmImageCalls: 100, confirmMusicCalls: 10,
    },
    concurrency: 1,
    generate: generator,
    jobs: {
      start: (spec) => {
        const id = brandString<JobId>(`media-${randomUUID()}`)
        const controller = new AbortController()
        controllers.set(id, controller)
        const done = spec.run(controller.signal)
        pending.push(done)
        const forget = () => { controllers.delete(id) }
        void done.then(forget, forget)
        return { id, done, signal: controller.signal }
      },
      live: () => [...controllers.keys()],
    },
    now: () => '2026-11-13T00:00:00.000Z',
    probe: async () => ({ durationMs: 3000, width: 640, height: 480 }),
    tailFrame: async () => join(directory, 'tail.png'),
  }
  return { services, generator, image }
}

function checkpoint(extra: Partial<MediaCheckpoint> = {}): MediaCheckpoint {
  return {
    version: 1, id: brandString<MediaAttemptId>(randomUUID()), node,
    jobId: brandString<JobId>('previous-process'), state: 'running',
    versionBody: { createdAt: '2026-11-13T00:00:00.000Z', origin: 'agent', prompt: 'a street', model: 'm', params: {}, inputs: [] },
    ...extra,
  }
}

it('does not suppress one owner while another owner is reconciling the same scope', async () => {
  await seed()
  const first = fixture()
  const second = fixture()
  const entered = producerBarrier()
  const release = producerBarrier()
  const readSecond = vi.fn(async () => [])
  const one = recoverInterrupted({ ...first.services, journal: {
    scope: journal.scope,
    read: async () => { entered.resolve(undefined); await release.promise; return [] },
    write: checkpoint => journal.write(checkpoint), remove: id => journal.remove(id),
  } })
  await entered.promise
  const two = recoverInterrupted({ ...second.services, journal: {
    scope: journal.scope, read: readSecond,
    write: checkpoint => journal.write(checkpoint), remove: id => journal.remove(id),
  } })
  try {
    await vi.waitFor(() => { expect(readSecond).toHaveBeenCalledTimes(1) })
    await two
  } finally {
    release.resolve(undefined)
    await Promise.allSettled([one, two])
  }
})

it('does not let another owner\'s live job hide an interrupted status', async () => {
  await seed()
  const first = fixture()
  const release = producerBarrier()
  const entered = producerBarrier()
  const image = (call: MediaCall): Promise<GeneratedMedia> => first.image(call)
  first.generator.image = async (call) => {
    entered.resolve(undefined)
    await release.promise
    return image(call)
  }
  const started = await startPlan(first.services, ['n1'], undefined)
  if (started.status !== 'started') throw new Error('expected a running first owner')
  try {
    await entered.promise
    const otherDirectory = join(directory, 'independent-owner')
    const otherStore = new CanvasStore(limits)
    const copied = await store.readCanvas(directory)
    await otherStore.updateCanvas(otherDirectory, 'canvas.json', () => ({ document: copied, value: undefined }))
    const other = fixture()
    await recoverInterrupted({
      ...other.services,
      journal: new FileMediaJournal(join(otherDirectory, '.canvas', 'canvas.json.media')),
      jobs: { ...other.services.jobs, live: () => [] },
      canvas: {
        read: async () => {
          const document = await otherStore.readCanvas(otherDirectory)
          return { document, revision: document.revision }
        },
        bible: async () => bibleFixture,
        edit: (operations, revision) => otherStore.updateCanvas(otherDirectory, 'canvas.json', (current) => {
          if (current.revision !== revision) throw new CanvasConflictError(revision, current.revision)
          const outcome = applyOperations(current, operations, { limits })
          return { document: outcome.document, value: outcome.result }
        }),
      },
    })
    expect((await otherStore.readCanvas(otherDirectory)).nodes[0]?.status).toMatchObject({ state: 'failed', retryable: true })
    expect((await store.readCanvas(directory)).nodes[0]?.status?.state).toBe('running')
  } finally {
    release.resolve(undefined)
    await started.settle
  }
})

it('recovers an already attached candidate after another version was adopted and the old status cleared', async () => {
  await seed()
  const h = fixture()
  failAppend = 'after'
  await runPlan(h.services, ['n1'], undefined)
  const manual = join(directory, 'manual.png')
  await writeFile(manual, 'manual image')
  await edit([
    { op: 'append_version', node, version: { id: 'manual', path: manual, createdAt: 'now', origin: 'user' } },
    { op: 'set_version', node, version: 'manual' },
    { op: 'set_status', node, status: null },
  ])
  const beforeRecovery = pending.length
  await recoverInterrupted({ ...h.services, state: createRunnerState() })
  await Promise.all(pending.slice(beforeRecovery))
  const restored = (await store.readCanvas(directory)).nodes[0]!
  expect(restored.activeVersion).toBe('manual')
  expect(restored.versions).toHaveLength(2)
  expect(restored.status).toBeUndefined()
  expect(h.image).toHaveBeenCalledOnce()
  expect(await journal.read()).toEqual([])
})

it('keeps a published queued attempt live across owners sharing the Host registry', async () => {
  await seed()
  const first = fixture()
  const second = fixture()
  const entered = producerBarrier()
  const release = producerBarrier()
  let firstSaved: MediaCheckpoint | undefined
  let paused = false
  const starting = startPlan({ ...first.services, journal: {
    scope: journal.scope, read: () => journal.read(), remove: id => journal.remove(id),
    write: async (saved) => {
      firstSaved ??= saved
      await journal.write(saved)
      if (!paused && saved.state === 'queued' && saved.jobId !== undefined) {
        paused = true
        entered.resolve(undefined)
        await release.promise
      }
    },
  } }, ['n1'], undefined)
  try {
    await entered.promise
    expect(firstSaved?.jobId).toBeDefined()
    expect(second.services.jobs.live?.()).toContain(firstSaved?.jobId)
    await recoverInterrupted(second.services)
    expect((await store.readCanvas(directory)).nodes[0]?.status).toBeUndefined()
    expect((await journal.read())[0]?.state).toBe('queued')
    expect(second.image).not.toHaveBeenCalled()
  } finally {
    release.resolve(undefined)
    const started = await starting
    if (started.status === 'started') await started.settle
  }
  expect(first.image).toHaveBeenCalledTimes(1)
})

it('finishes an existing produced attempt instead of billing again when recovery beats the caller read', async () => {
  await seed()
  const h = fixture()
  const media = { path: join(directory, 'already-produced.png'), model: 'm' }
  await writeFile(media.path, 'already paid image')
  const jobId = brandString<JobId>('previous-process')
  const saved = checkpoint({ state: 'produced', media, jobId })
  await journal.write(saved)
  await edit([{ op: 'set_status', node, status: { state: 'failed', at: 'then', jobId, error: 'EPERM', retryable: true } }])
  const lane = new AsyncLocalStorage<boolean>()
  let job: MediaJob | undefined
  let produced = false
  const services: RunnerServices = {
    ...h.services,
    journal: {
      scope: journal.scope, read: () => journal.read(), remove: id => journal.remove(id),
      write: async (next) => {
        if (lane.getStore() === true && next.state === 'produced') produced = true
        await journal.write(next)
      },
    },
    jobs: { ...h.services.jobs, start: (spec) => {
      const owned = h.services.jobs.start({ label: spec.label, run: signal => lane.run(true, () => spec.run(signal)) })
      job ??= owned
      return owned
    } },
    canvas: { ...h.services.canvas, read: async () => {
      // A slow foreground read must not convert a completed recovery into another paid submission.
      if (produced && lane.getStore() !== true && job !== undefined) await job.done
      return h.services.canvas.read()
    } },
  }
  try {
    const result = await runPlan(services, ['n1'], undefined)
    expect(result.status).toBe('done')
    if (result.status !== 'done') throw new Error('expected reconciled result')
    expect(result.results).toMatchObject([{ node, ok: true, path: media.path }])
    expect(result.plan.nodes).toEqual([])
    expect(h.image).not.toHaveBeenCalled()
    expect((await store.readCanvas(directory)).nodes[0]?.versions).toHaveLength(1)
    expect((await store.readCanvas(directory)).nodes[0]?.status).toBeUndefined()
    expect(await journal.read()).toEqual([])
  } finally {
    await Promise.allSettled(pending)
    lane.disable()
  }
})

it('admits one recovery job when separate file journal owners open the same checkpoint together', async () => {
  await seed()
  const media = { path: join(directory, 'already-produced.png'), model: 'm' }
  await writeFile(media.path, 'already paid image')
  await journal.write(checkpoint({ state: 'produced', media }))
  const bothRequested = producerBarrier()
  let requested = 0
  let active = 0
  let peak = 0
  const ownedJournal = (): MediaJournal => {
    const owner = new FileMediaJournal(journal.scope)
    return {
      scope: owner.scope, read: () => owner.read(), write: saved => owner.write(saved), remove: id => owner.remove(id),
      withRecoveryLock: async (operation) => {
        requested += 1
        if (requested === 2) bothRequested.resolve(undefined)
        await bothRequested.promise
        return owner.withRecoveryLock(async () => {
          active += 1
          peak = Math.max(peak, active)
          try { return await operation() } finally { active -= 1 }
        })
      },
    }
  }
  const first = fixture()
  const second = fixture()
  const recovered = await Promise.all([
    recoverInterrupted({ ...first.services, journal: ownedJournal() }),
    recoverInterrupted({ ...second.services, journal: ownedJournal() }),
  ])
  expect(requested).toBe(2)
  expect(peak).toBe(1)
  expect(recovered.flat()).toHaveLength(1)
  await Promise.all(pending)
  expect(pending).toHaveLength(1)
  expect(first.image).not.toHaveBeenCalled()
  expect(second.image).not.toHaveBeenCalled()
  expect((await store.readCanvas(directory)).nodes[0]?.versions).toHaveLength(1)
  expect((await store.readCanvas(directory)).nodes[0]?.status).toBeUndefined()
  expect(await journal.read()).toEqual([])
})

it('reconciles a retained result before admitting the remaining requested batch', async () => {
  await seed()
  await edit([{ op: 'add', type: 'image', gen: { kind: 'image', prompt: 'another image', params: {} } }])
  const media = { path: join(directory, 'already-produced.png'), model: 'm' }
  await writeFile(media.path, 'already paid image')
  await journal.write(checkpoint({ state: 'produced', media }))
  const h = fixture()
  const result = await startPlan(h.services, ['n1', 'n2'], undefined)
  expect(result).toMatchObject({ status: 'already_running', nodes: [node] })
  if (result.status !== 'already_running') throw new Error('expected recovery before remaining generation')
  expect(result.jobs).toHaveLength(1)
  expect(result.jobs?.[0]?.jobId).toBeTruthy()
  await Promise.all(pending)
  expect(h.image).not.toHaveBeenCalled()
  expect((await store.readCanvas(directory)).nodes.find(candidate => candidate.id === 'n2')?.versions ?? []).toEqual([])
})

it('does not mark an artifact intent produced when publishing the file fails', async () => {
  await seed()
  const h = fixture()
  h.generator.image = async (call) => {
    await call.onSubmitting?.()
    await call.onArtifact?.({ path: join(directory, 'never-published.png'), model: 'm' })
    throw Object.assign(new Error('disk is full'), { code: 'ENOSPC' })
  }
  const result = await runPlan(h.services, ['n1'], undefined)
  expect(result.status).toBe('done')
  expect((await journal.read())[0]).toMatchObject({ state: 'running', recoveryRequired: true })
  expect((await store.readCanvas(directory)).nodes[0]?.versions ?? []).toEqual([])
})

it.each(['before', 'after'] as const)('recovers a generated file after a canvas failure %s commit without billing or appending twice', async (failure) => {
  await seed()
  const h = fixture()
  failAppend = failure
  const outcome = await runPlan(h.services, ['n1'], undefined)
  expect(outcome.status).toBe('done')
  if (outcome.status !== 'done') throw new Error('expected completed run')
  expect(outcome.results[0]?.ok).toBe(false)
  expect(h.image).toHaveBeenCalledTimes(1)
  expect(await readFile(join(directory, 'image.png'), 'utf8')).toBe('complete image')
  expect(await journal.read()).toHaveLength(1)
  expect((await store.readCanvas(directory)).nodes[0]?.status).toMatchObject({
    state: 'failed', retryable: false, recoveryRequired: true,
  })

  await recoverInterrupted({ ...h.services, journal: new FileMediaJournal(journal.scope) })
  await Promise.all(pending.slice(1))
  await recoverInterrupted(h.services)
  const document = await store.readCanvas(directory)
  expect(document.nodes[0]?.versions).toHaveLength(1)
  expect(document.nodes[0]?.versions?.[0]?.path).toBe(join(directory, 'image.png'))
  expect(document.nodes[0]?.status).toBeUndefined()
  expect(h.image).toHaveBeenCalledTimes(1)
  expect(await journal.read()).toEqual([])
})

it('resumes a saved remote id instead of issuing a second video submission', async () => {
  await seed('video')
  const h = fixture()
  const saved = checkpoint({ remote: { id: 'paid-remote-task', kind: 'video', model: 'm', endpoint: 'a'.repeat(64) } })
  await journal.write(saved)
  await edit([{ op: 'set_status', node, status: { state: 'running', jobId: brandString<JobId>('previous-process'), at: 'then' } }])
  const resume = vi.fn<NonNullable<MediaGenerator['resume']>>(async (_task, _signal, onArtifact) => {
    const media = { path: join(directory, 'restored.mp4'), model: 'm' }
    await onArtifact?.(media)
    await writeFile(media.path, 'complete video')
    return media
  })
  h.generator.resume = resume
  await recoverInterrupted(h.services)
  await Promise.all(pending)
  expect(resume).toHaveBeenCalledTimes(1)
  expect(resume.mock.calls[0]?.[0]).toEqual(saved.remote)
  expect(h.image).not.toHaveBeenCalled()
  expect((await store.readCanvas(directory)).nodes[0]?.versions).toHaveLength(1)
  expect((await store.readCanvas(directory)).nodes[0]?.status).toBeUndefined()
})

it('blocks automatic retry when a crash left the remote submission outcome unknown', async () => {
  await seed()
  const h = fixture()
  const saved = checkpoint()
  await journal.write(saved)
  await edit([{ op: 'set_status', node, status: { state: 'running', jobId: brandString<JobId>('previous-process'), at: 'then' } }])
  await recoverInterrupted(h.services)
  const failed = (await store.readCanvas(directory)).nodes[0]?.status
  expect(failed).toMatchObject({ state: 'failed', retryable: false })
  if (failed?.state !== 'failed') throw new Error('expected failure status')
  expect(failed.error).toContain('outcome is unknown')
  expect(h.image).not.toHaveBeenCalled()
  expect(pending).toHaveLength(0)
})

it('does not mistake a live task for a restart or start the same node twice', async () => {
  await seed()
  const h = fixture()
  const begun = Promise.withResolvers<undefined>()
  const release = producerBarrier()
  h.generator.image = async (call) => {
    begun.resolve(undefined)
    await release.promise
    return h.image(call)
  }
  const first = await startPlan(h.services, ['n1'], undefined)
  await begun.promise
  const second = await startPlan(h.services, ['n1'], undefined)
  expect(second).toMatchObject({ status: 'already_running', nodes: ['n1'] })
  expect((await store.readCanvas(directory)).nodes[0]?.status?.state).toBe('running')
  release.resolve(undefined)
  if (first.status !== 'started') throw new Error('expected started job')
  await first.settle
  expect(h.image).toHaveBeenCalledTimes(1)
})

it.each([false, true])('distinguishes preparation failures from uncertain paid submissions (%s)', async (submitted) => {
  await seed('video')
  const h = fixture()
  h.generator.video = async (call) => {
    if (submitted) await call.onSubmitting?.()
    throw new Error('connection interrupted')
  }
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected started job')
  await outcome.settle
  const status = (await store.readCanvas(directory)).nodes[0]?.status
  expect(status).toMatchObject({ state: 'failed', retryable: !submitted })
  expect(status?.state === 'failed' ? status.recoveryRequired : undefined).toBe(submitted ? true : undefined)
  if (submitted) {
    expect(status?.state === 'failed' ? status.error : undefined)
      .toBe('Remote submission outcome is unknown (connection interrupted); verify provider history before starting another generation')
  }
  expect((await journal.read())[0]?.submissionStarted).toBe(submitted)
  if (submitted) expect((await startPlan(h.services, ['n1'], undefined)).status).toBe('blocked')
})

it.each([500, 503])('retries a submission the gateway answered with HTTP %s', async (status) => {
  await seed('video')
  const h = fixture()
  h.generator.video = async (call) => {
    await call.onSubmitting?.()
    throw new MediaSubmissionRejectedError('upstream failed', status)
  }
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected started job')
  await outcome.settle
  const nodeStatus = (await store.readCanvas(directory)).nodes[0]?.status
  expect(nodeStatus).toMatchObject({ state: 'failed', error: 'upstream failed', retryable: true })
  expect(nodeStatus?.state === 'failed' ? nodeStatus.recoveryRequired : undefined).toBeUndefined()
  const retry = await startPlan(h.services, ['n1'], undefined)
  expect(retry.status).toBe('started')
  if (retry.status === 'started') await retry.settle
})

it('does not mark a 4xx submission refusal as recoverable or retryable', async () => {
  await seed('video')
  const h = fixture()
  h.generator.video = async (call) => {
    await call.onSubmitting?.()
    throw new MediaSubmissionRejectedError('bad request', 400)
  }
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected started job')
  await outcome.settle
  const nodeStatus = (await store.readCanvas(directory)).nodes[0]?.status
  expect(nodeStatus).toMatchObject({ state: 'failed', error: 'bad request', retryable: false })
  expect(nodeStatus?.state === 'failed' ? nodeStatus.recoveryRequired : undefined).toBeUndefined()
  const retry = await startPlan(h.services, ['n1'], undefined)
  expect(retry.status).toBe('started')
  if (retry.status === 'started') await retry.settle
})

it('keeps a post-acceptance gateway failure uncertain and blocked', async () => {
  await seed('video')
  const h = fixture()
  h.generator.video = async (call) => {
    await call.onSubmitting?.()
    throw new MediaGatewayError('download failed', 500)
  }
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected started job')
  await outcome.settle
  const nodeStatus = (await store.readCanvas(directory)).nodes[0]?.status
  expect(nodeStatus).toMatchObject({ state: 'failed', retryable: false, recoveryRequired: true })
  expect(nodeStatus?.state === 'failed' ? nodeStatus.error : undefined)
    .toBe('Remote submission outcome is unknown (download failed); verify provider history before starting another generation')
  expect((await startPlan(h.services, ['n1'], undefined)).status).toBe('blocked')
})

it('keeps a non-Error submission reason in the unknown-outcome message', async () => {
  await seed('video')
  const h = fixture()
  h.generator.video = async (call) => {
    await call.onSubmitting?.()
    throw 'connection reset'
  }
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected started job')
  await outcome.settle
  const status = (await store.readCanvas(directory)).nodes[0]?.status
  expect(status?.state === 'failed' ? status.error : undefined)
    .toBe('Remote submission outcome is unknown (connection reset); verify provider history before starting another generation')
})

it('reports a remote cancellation as local and prevents an accidental second paid request', async () => {
  await seed('video')
  const h = fixture()
  const begun = Promise.withResolvers<undefined>()
  const release = producerBarrier()
  h.generator.video = async (call) => {
    await call.onSubmitting?.()
    await call.onSubmitted?.({ id: 'remote-video', model: call.entry.model, kind: 'video', endpoint: 'a'.repeat(64) })
    begun.resolve(undefined)
    await release.promise
    throw new Error('aborted')
  }
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected started job')
  await begun.promise
  for (const controller of controllers.values()) controller.abort('user cancelled')
  release.resolve(undefined)
  expect(await outcome.settle).toMatchObject([{ ok: false, retryable: false, recoveryRequired: true }])
  expect((await store.readCanvas(directory)).nodes[0]?.status).toMatchObject({ state: 'failed', recoveryRequired: true })
  expect((await startPlan(h.services, ['n1'], undefined)).status).toBe('blocked')
})

it.each(['kill', 'teardown'] as const)('reconciles known remote tasks according to their %s cancellation source', async (cause) => {
  await seed('video')
  const h = fixture()
  const begun = producerBarrier()
  const release = producerBarrier()
  const submit = vi.fn(async (call: MediaCall) => {
    await call.onSubmitting?.()
    await call.onSubmitted?.({ id: 'known-remote-task', model: call.entry.model, kind: 'video', endpoint: 'a'.repeat(64) })
    begun.resolve(undefined)
    await release.promise
    call.signal.throwIfAborted()
    throw new Error('expected a cancellation')
  })
  h.generator.video = submit
  const resume = vi.fn<NonNullable<MediaGenerator['resume']>>(async (_task, _signal, onArtifact) => {
    const media = { path: join(directory, 'recovered.mp4'), model: 'm' }
    await onArtifact?.(media)
    await writeFile(media.path, 'complete recovered media')
    return media
  })
  h.generator.resume = resume
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected a started job')
  await begun.promise
  for (const controller of controllers.values()) {
    controller.abort(cause === 'teardown' ? new MediaInterruptedError('owner disposed') : 'owner disposed')
  }
  release.resolve(undefined)
  await outcome.settle
  expect((await journal.read())[0]).toMatchObject({
    state: cause === 'teardown' ? 'running' : 'cancelled', remote: { id: 'known-remote-task' },
    retryable: false, recoveryRequired: true,
  })
  const beforeRecovery = pending.length
  await recoverInterrupted({ ...h.services, state: createRunnerState() })
  await Promise.all(pending.slice(beforeRecovery))
  expect(submit).toHaveBeenCalledOnce()
  expect(resume).toHaveBeenCalledTimes(cause === 'teardown' ? 1 : 0)
  const restored = (await store.readCanvas(directory)).nodes[0]
  expect(restored?.versions ?? []).toHaveLength(cause === 'teardown' ? 1 : 0)
  if (cause === 'teardown') {
    expect(restored?.status).toBeUndefined()
    expect(await journal.read()).toEqual([])
  } else expect((await journal.read())[0]?.state).toBe('cancelled')
})

it.each([false, true])('keeps shutdown retry policy safe when submission intent was recorded: %s', async (submitted) => {
  await seed()
  const h = fixture()
  const begun = producerBarrier()
  const release = producerBarrier()
  const generate = vi.fn(async (call: MediaCall) => {
    if (submitted) await call.onSubmitting?.()
    begun.resolve(undefined)
    await release.promise
    call.signal.throwIfAborted()
    throw new Error('expected shutdown')
  })
  h.generator.image = generate
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected a started job')
  await begun.promise
  for (const controller of controllers.values()) controller.abort(new MediaInterruptedError('service disposed'))
  release.resolve(undefined)
  await outcome.settle
  expect((await journal.read())[0]).toMatchObject({ state: submitted ? 'failed' : 'queued', retryable: !submitted })
  expect((await store.readCanvas(directory)).nodes[0]?.status).toMatchObject({ state: 'failed', retryable: !submitted })
  await recoverInterrupted({ ...h.services, state: createRunnerState() })
  expect(generate).toHaveBeenCalledOnce()
  if (submitted) expect((await journal.read())[0]?.recoveryRequired).toBe(true)
})

it.each(['artifact', 'produced'] as const)('recovers an image after shutdown at the %s checkpoint', async (phase) => {
  await seed()
  const h = fixture()
  if (phase === 'artifact') h.generator.image = async (call) => {
    const media = await h.image(call)
    for (const controller of controllers.values()) controller.abort(new MediaInterruptedError('service disposed'))
    call.signal.throwIfAborted()
    return media
  }
  let stopped = false
  const canvas: RunnerServices['canvas'] = {
    ...h.services.canvas,
    edit: async (operations, revision) => {
      if (phase === 'produced' && !stopped && operations.some(operation => operation.op === 'append_version')) {
        stopped = true
        for (const controller of controllers.values()) controller.abort(new MediaInterruptedError('service disposed'))
        throw new Error('canvas owner stopped')
      }
      return h.services.canvas.edit(operations, revision)
    },
  }
  const services = { ...h.services, canvas }
  const outcome = await runPlan(services, ['n1'], undefined)
  expect(outcome.status).toBe('done')
  expect((await journal.read())[0]).toMatchObject({ state: phase === 'produced' ? 'produced' : 'running', retryable: false, recoveryRequired: true })
  const beforeRecovery = pending.length
  await recoverInterrupted({ ...services, state: createRunnerState() })
  await Promise.all(pending.slice(beforeRecovery))
  expect(h.image).toHaveBeenCalledOnce()
  const restored = (await store.readCanvas(directory)).nodes[0]
  expect(restored?.versions).toHaveLength(1)
  expect(restored?.status).toBeUndefined()
  expect(await journal.read()).toEqual([])
})

it('keeps cancellation terminal even when a producer returns a late media result', async () => {
  await seed()
  const h = fixture()
  const begun = Promise.withResolvers<undefined>()
  const release = producerBarrier()
  h.generator.image = async (call) => {
    begun.resolve(undefined)
    await release.promise
    return h.image(call)
  }
  const outcome = await startPlan(h.services, ['n1'], undefined)
  await begun.promise
  for (const controller of controllers.values()) controller.abort('user cancelled')
  release.resolve(undefined)
  if (outcome.status !== 'started') throw new Error('expected started job')
  await outcome.settle
  await recoverInterrupted(h.services)
  const document = await store.readCanvas(directory)
  expect(document.nodes[0]?.versions).toEqual([])
  expect(document.nodes[0]?.status).toMatchObject({ state: 'failed', error: 'cancelled', retryable: true })
  expect((await journal.read())[0]?.state).toBe('cancelled')
  expect(h.image).toHaveBeenCalledTimes(1)
})

it('retains an old result without clearing a newer task status', async () => {
  await seed()
  const h = fixture()
  const begun = Promise.withResolvers<undefined>()
  const release = producerBarrier()
  h.generator.image = async (call) => {
    begun.resolve(undefined)
    await release.promise
    return h.image(call)
  }
  const outcome = await startPlan(h.services, ['n1'], undefined)
  await begun.promise
  const newer = brandString<JobId>('newer-task')
  await edit([{ op: 'set_status', node, status: { state: 'running', jobId: newer, at: 'later' } }])
  release.resolve(undefined)
  if (outcome.status !== 'started') throw new Error('expected started job')
  await outcome.settle
  expect((await store.readCanvas(directory)).nodes[0]?.status).toMatchObject({ state: 'running', jobId: newer })
  expect((await store.readCanvas(directory)).nodes[0]?.versions).toEqual([])
  expect((await journal.read())[0]?.media?.path).toBe(join(directory, 'image.png'))
})

it('refuses a malformed checkpoint and leaves canvas bytes intact before any generation', async () => {
  await seed()
  const saved = checkpoint()
  await journal.write(saved)
  const file = join(journal.scope, `${saved.id}.json`)
  await writeFile(file, '{broken')
  const before = await readFile(canvasFile(directory), 'utf8')
  const h = fixture()
  await expect(startPlan(h.services, ['n1'], undefined)).rejects.toThrow('Cannot recover media checkpoint')
  expect(await readFile(file, 'utf8')).toBe('{broken')
  expect(await readFile(canvasFile(directory), 'utf8')).toBe(before)
  expect(h.image).not.toHaveBeenCalled()
})

it.each(['music', 'speech'] as const)('recovers %s through its durable task id with prepared settings intact', async (kind) => {
  const score = 'X:1\nK:C\nCDEF | G4 |\n'
  await edit([{ op: 'add', type: 'audio', title: 'audio', gen: {
    kind, model: kind === 'music' ? 'yue2' : 'breeze-tts-2', prompt: '原始描述', params: { seed: 0, lyrics: '原始歌词' },
  } }])
  const h = fixture()
  const begun = producerBarrier()
  const release = producerBarrier()
  const submit = vi.fn(async (call: MediaCall): Promise<GeneratedMedia> => {
    await call.onSubmitting?.({ prompt: '实际提交文字', params: { ...call.node.gen?.params, cot: 'full' } })
    await call.onSubmitted?.({ id: 'existing-audio', model: call.entry.model, kind, endpoint: 'a'.repeat(64) })
    begun.resolve(undefined)
    await release.promise
    call.signal.throwIfAborted()
    throw new Error('expected owner teardown')
  })
  h.generator[kind] = submit
  const resume = vi.fn<NonNullable<MediaGenerator['resume']>>(async (task, _signal, onArtifact) => {
    expect(task).toMatchObject({ id: 'existing-audio', kind })
    const media = { path: join(directory, 'recovered.wav'), model: task.model, ...kind === 'music' ? { params: { abc: score } } : {} }
    await onArtifact?.(media)
    await writeFile(media.path, 'complete audio')
    return media
  })
  h.generator.resume = resume
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected started audio job')
  await begun.promise
  expect((await journal.read())[0]?.versionBody).toMatchObject({ prompt: '实际提交文字', params: { seed: 0, lyrics: '原始歌词', cot: 'full' } })
  for (const controller of controllers.values()) controller.abort(new MediaInterruptedError('owner disposed'))
  release.resolve(undefined)
  await outcome.settle
  const before = pending.length
  await recoverInterrupted({ ...h.services, state: createRunnerState() })
  await Promise.all(pending.slice(before))
  expect(submit).toHaveBeenCalledOnce()
  expect(resume).toHaveBeenCalledOnce()
  const restored = (await store.readCanvas(directory)).nodes[0]
  expect(restored?.versions?.[0]).toMatchObject({ prompt: '实际提交文字', params: { seed: 0, lyrics: '原始歌词', cot: 'full',
    ...kind === 'music' ? { abc: score } : {} } })
  expect(restored?.status).toBeUndefined()
  expect(await journal.read()).toEqual([])
})

it('retains a rendered score through a crash after the artifact checkpoint', async () => {
  await edit([{ op: 'add', type: 'audio', title: 'song', gen: { kind: 'music', prompt: '曲风', params: { lyrics: '歌词', seed: 0 } } }])
  const h = fixture()
  const score = 'X:1\nK:C\nG4 |\n'
  const generate = vi.fn(async (call: MediaCall) => {
    await call.onSubmitting?.({ params: { ...call.node.gen?.params, cot: 'full' } })
    const media = { path: join(directory, 'song.wav'), model: call.entry.model, params: { abc: score } }
    await call.onArtifact?.(media)
    await writeFile(media.path, 'complete song')
    for (const controller of controllers.values()) controller.abort(new MediaInterruptedError('owner disposed'))
    call.signal.throwIfAborted()
    return media
  })
  h.generator.music = generate
  const outcome = await startPlan(h.services, ['n1'], undefined)
  if (outcome.status !== 'started') throw new Error('expected a song job')
  await outcome.settle
  expect((await journal.read())[0]?.media?.params?.abc).toBe(score)
  const before = pending.length
  await recoverInterrupted({ ...h.services, state: createRunnerState() })
  await Promise.all(pending.slice(before))
  expect(generate).toHaveBeenCalledOnce()
  expect((await store.readCanvas(directory)).nodes[0]?.versions?.[0]?.params).toMatchObject({ lyrics: '歌词', seed: 0, cot: 'full', abc: score })
  expect(await journal.read()).toEqual([])
})

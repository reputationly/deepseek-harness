/** Windows executable wrappers must not leave their real process behind on cancellation. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { FfmpegRunner } from '../src/ffmpeg.ts'

const fixtures: { directory: string; ctx: Context; runner: FfmpegRunner; results: Promise<unknown>; descendant: number }[] = []

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

afterEach(async () => {
  for (const fixture of fixtures) {
    await fixture.runner.dispose()
    await fixture.results
    await fixture.ctx.fiber.dispose()
    // The descendant belongs only to this private fixture, never exits on its own,
    // and creates no further children. This also cleans the intentionally failing control.
    if (fixture.descendant !== 0 && alive(fixture.descendant)) process.kill(fixture.descendant, 'SIGKILL')
    if (fixture.descendant !== 0) await expect.poll(() => alive(fixture.descendant)).toBe(false)
    await rm(fixture.directory, { recursive: true, force: true })
  }
  fixtures.length = 0
})

it.runIf(process.platform === 'win32').each(['abort', 'dispose'] as const)('joins a wrapper and its live descendant on %s', async (stop) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ffmpeg-tree-'))
  const readyFile = join(directory, 'ready.json')
  const ctx = new Context()
  const runner = new FfmpegRunner(new LocalSubprocessRuntime(ctx), process.execPath, process.execPath, 60_000)
  const controller = new AbortController()
  const fixture = { directory, ctx, runner, results: Promise.resolve<unknown>(undefined), descendant: 0 }
  fixtures.push(fixture)
  // A separate Windows console survives killing its wrapper but still inherits its Job Object.
  const call = runner.exec(['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify("setInterval(() => {}, 60000); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid }))")}, process.argv[1]], {
      stdio: 'ignore', detached: process.platform === 'win32',
    });
  `, readyFile], { signal: controller.signal })
  fixture.results = Promise.allSettled([call])
  await expect.poll(async () => {
    const value: unknown = JSON.parse(await readFile(readyFile, 'utf8'))
    if (typeof value !== 'object' || value === null || !('pid' in value) || typeof value.pid !== 'number') {
      throw new Error('Wrapper did not publish a descendant PID')
    }
    fixture.descendant = value.pid
    return alive(value.pid)
  }).toBe(true)
  if (stop === 'abort') controller.abort('stop fixture')
  else await runner.dispose()
  await expect(call).rejects.toMatchObject({ code: stop === 'abort' ? 'aborted' : 'disposed' })
  // Assert OS state after the runner itself reports settlement, before fallback cleanup.
  expect(alive(fixture.descendant)).toBe(false)
})

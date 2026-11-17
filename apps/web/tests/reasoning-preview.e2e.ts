/** Streaming reasoning previews through the assembled Chat and a paused model adapter. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { connectFreshWorkspace, expandOwningTurnProcess, newEnglishPage, writeComposerDraft } from './support.ts'

const SUMMARY = `Next paragraph: ${'inspect the loaded context and pending tools '.repeat(8).trim()}`
const DELTAS = ['First paragraph', `\nDetails\n\n\n${SUMMARY}`, '\nMore detail', '\n\nExpanded update']
const UI_EXPECTED = fileURLToPath(new URL('./expected/reasoning-preview/running.expected.md', import.meta.url))

class PausedReasoningAdapter extends LlmAdapter {
  constructor(private readonly prefix: string) { super() }
  override async listModels(provider: string) { return [{ provider, id: 'paused', name: `${provider}/paused` }] }
  readonly stages = DELTAS.map(text => ({
    text,
    arrived: Promise.withResolvers<undefined>(),
    proceed: Promise.withResolvers<undefined>(),
  }))

  release(): void {
    for (const stage of this.stages) stage.proceed.resolve(undefined)
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' }
    if (this.prefix !== '') yield { type: 'reasoning-delta', index: 0, text: this.prefix }
    for (const stage of this.stages) {
      yield { type: 'reasoning-delta', index: 0, text: stage.text }
      stage.arrived.resolve(undefined)
      await stage.proceed.promise
      options.signal?.throwIfAborted()
    }
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: this.prefix + DELTAS.join('') } }
    yield { type: 'block-start', index: 1, blockType: 'text' }
    yield { type: 'text-delta', index: 1, text: 'Done' }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: 'Done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it.each(['plain', 'signature'])('shows completed paragraph first lines with a right-edge fade (%s)', async (format) => {
  const scaffold = await launchWebScaffold()
  const adapter = new PausedReasoningAdapter(format === 'signature' ? '<signature>metadata.payload</signature>\n\n' : '')
  try {
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['reasoning-preview-test'], adapter))
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'reasoning-preview-test', model: 'paused' })
    const browser = await chromium.launch()
    try {
      const page = await newEnglishPage(browser)
      const console = watchConsole(page)
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      await page.setViewportSize({ width: 480, height: 1000 })
      const input = page.locator('[data-composer-input]').first()
      const settled = scaffold.whenTurnSettled()
      await writeComposerDraft(page, input, 'Show a streamed reasoning preview.')
      await input.press('Enter')

      const [first, second, third, fourth] = adapter.stages
      if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
        throw new Error('preview stages are incomplete')
      }
      await first.arrived.promise
      const reasoning = page.locator('[data-variant="think"][data-state="running"]')
      await expandOwningTurnProcess(page, reasoning)
      await reasoning.waitFor()
      const glass = page.locator('[data-chat-running] span[aria-hidden="true"] svg')
      /** The sweep runs on the stylesheet; reduced motion and forced colors settle it in place. */
      const expectStaticGlass = async () => {
        expect(await glass.count()).toBe(1)
        await expect.poll(() => glass.isVisible()).toBe(true)
        expect(await glass.evaluate(element => getComputedStyle(element).animationName)).toBe('none')
        const colors = await glass.locator('circle').evaluate((circle) => {
          const probe = document.createElement('span')
          probe.style.cssText = 'color: Canvas; forced-color-adjust: none'
          document.body.append(probe)
          try {
            const style = getComputedStyle(circle)
            return {
              stroke: style.stroke.toLowerCase() === 'currentcolor' ? style.color : style.stroke,
              canvas: getComputedStyle(probe).color,
            }
          } finally { probe.remove() }
        })
        expect(colors.stroke).not.toBe('none')
        expect(colors.stroke).not.toBe('transparent')
        expect(colors.stroke).not.toBe(colors.canvas)
      }
      expect(await glass.locator('animate').count()).toBe(0)
      try {
        await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'none' })
        expect(await glass.evaluate(element => getComputedStyle(element).animationName)).toBe('dsh-running-glass')
        const firstFrame = await glass.screenshot({ animations: 'allow' })
        await expect.poll(async () => !(await glass.screenshot({ animations: 'allow' })).equals(firstFrame), {
          timeout: 5000,
        }).toBe(true)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await expectStaticGlass()
        await page.emulateMedia({ reducedMotion: 'no-preference', forcedColors: 'active' })
        expect(await glass.evaluate(element => getComputedStyle(element).animationName)).not.toBe('')
      } finally {
        await page.emulateMedia({ reducedMotion: null, forcedColors: null })
      }
      expect(await reasoning.getAttribute('data-preview')).toBeNull()
      expect(await reasoning.textContent()).not.toContain('metadata.payload')

      first.proceed.resolve(undefined)
      await second.arrived.promise
      const preview = reasoning.locator('[data-streaming]:not([inert] *)')
      await expect.poll(() => preview.textContent()).toBe('First paragraph')
      expect(await preview.isVisible()).toBe(true)
      await preview.evaluate((element) => { element.setAttribute('data-retained-preview', 'true') })

      second.proceed.resolve(undefined)
      await third.arrived.promise
      await expect.poll(() => preview.textContent()).toBe(SUMMARY)
      expect(await preview.getAttribute('data-retained-preview')).toBe('true')
      expect(await preview.evaluate(element => getComputedStyle(element).maskImage)).toContain('linear-gradient')
      expect(await preview.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
      expect(await reasoning.getByRole('button').getAttribute('aria-expanded')).toBe('false')
      await compareOrRefreshGolden(UI_EXPECTED,
        await captureStableAria(page, '[data-variant="think"]', scaffold.workspaceCwd), webSnapshotMode())

      await reasoning.getByRole('button').click()
      await reasoning.getByText('More detail', { exact: false }).waitFor()
      expect(await reasoning.textContent()).not.toContain('metadata.payload')
      third.proceed.resolve(undefined)
      await fourth.arrived.promise
      await reasoning.getByText('Expanded update', { exact: true }).waitFor()
      expect(await reasoning.textContent()).not.toContain('metadata.payload')
      fourth.proceed.resolve(undefined)
      await settled
      await page.getByText('Done', { exact: true }).waitFor()
      await glass.waitFor({ state: 'detached' })
      expect(console.pageErrors).toEqual([])
      expect(console.warnings).toEqual([])
    } finally {
      adapter.release()
      await browser.close()
    }
  } finally {
    adapter.release()
    await scaffold.close()
  }
})

/**
 * REAL-composition tier (packages/AGENTS.md): boot the chat-generation Loader fixture as a
 * subprocess through the deployment boot path, with the real catalog and task services talking to
 * a canned loopback gateway, and assert what the model reads, the card metadata, and the saved file.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface Report {
  schemaProperties: string[]
  isError: boolean
  text: string
  meta: { status: string; model: string; images: { path: string }[] }
  generated: string[]
  asked: { id: string; options: string[] }[][]
  restart: { submittedBeforeRestart: number; submittedAfterRestart: number; isError: boolean; meta: { status: string } }
  video: {
    isError: boolean
    asked: number
    meta: { status: string; model: string; parameters: Record<string, string>; media: { path: string; mediaType: string }[] }
  }
}

describe('suanli-media-tools through a real Loader composition', () => {
  it('asks for the catalog parameter, generates an image and a video, resumes a video across a restart, and saves into generated/', async () => {
    let report: Report | undefined
    const { stderr } = await runLoaderSmoke({
      label: 'suanli-media-tools loader smoke',
      tempDirPrefix: 'suanli-media-tools-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        report = JSON.parse(await readFile(join(cwd, 'media-tools-report.json'), 'utf8')) as Report
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(report?.schemaProperties).toEqual(['prompt', 'aspect_ratio', 'resolution', 'reference_images', 'count'])
    expect(report?.isError).toBe(false)
    expect(report?.asked).toEqual([[{ id: 'size', options: ['1024x1024'] }]])
    expect(report?.meta).toMatchObject({ status: 'generated', model: 'fake-image', parameters: { size: '1024x1024' } })
    expect(report?.generated.filter(name => name.endsWith('.png'))).toHaveLength(1)
    expect(JSON.parse(report?.text ?? '{}')).toMatchObject({ status: 'generated', model: 'fake-image' })
    expect(report?.video).toMatchObject({
      isError: false, asked: 0,
      meta: { status: 'generated', model: 'fake-video', parameters: { ratio: '9:16', resolution: '768P', duration: '5', image_mode: 'text-to-video' } },
    })
    expect(report?.video.meta.media[0]?.mediaType).toBe('video/mp4')
    expect(report?.restart).toMatchObject({ submittedBeforeRestart: 1, submittedAfterRestart: 0, isError: false, meta: { status: 'generated' } })
    expect(report?.generated.filter(name => name.endsWith('.mp4'))).toHaveLength(2)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolMedia from '../src/index.ts'

let ctx: Context

afterEach(async () => {
  await ctx.fiber.dispose()
})

describe('bundled media-editing skill', () => {
  it('is discoverable and loadable when the optional skills service is present', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ToolMedia, { baseURL: 'https://gateway.example/v1', catalog: false })

    const skill = await ctx.skills.get('media-editing')

    expect(skill).toMatchObject({
      name: 'media-editing',
      provider: 'dsh-tool-media',
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    expect(skill?.content).toContain('调用 `media_probe`')
    expect(skill?.content).toContain('`merge_videos`')
    expect(skill?.resourceBase?.kind).toBe('directory')
  })

  it('resolves SKILL.md and registers the provider from the bundled lib', async () => {
    const builtIndex = '../lib/index.js'
    const bundled = await import(builtIndex) as typeof ToolMedia
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(bundled, { baseURL: 'https://gateway.example/v1', catalog: false })

    const skill = await ctx.skills.get('media-editing')

    expect(skill).toMatchObject({
      name: 'media-editing',
      provider: 'dsh-tool-media',
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    })
    expect(skill?.content).toContain('调用 `media_probe`')
    expect(skill?.content).toContain('`merge_videos`')
  })

  it('rejects a provider candidate whose opaque locator is not a file path', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const registration = vi.spyOn(ctx.skills, 'registerProvider')
    await ctx.plugin(ToolMedia, { baseURL: 'https://gateway.example/v1', catalog: false })
    const create = registration.mock.calls.at(-1)?.[0]
    if (create === undefined) throw new Error('media skill provider was not registered')
    const provider = create({ signal: new AbortController().signal, invalidate: () => {} })
    const listed = await provider.list({ cwd: process.cwd() })
    const candidate = ('candidates' in listed ? listed.candidates : listed)[0]
    if (candidate === undefined) throw new Error('media skill provider returned no candidate')
    await expect(provider.get({ ...candidate, locator: 42 }, { cwd: process.cwd() }))
      .rejects.toThrow('invalid media-editing skill locator')
  })

  it('loads skill content from the configured absolute asset root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-media-skill-'))
    try {
      await cp(join(process.cwd(), 'packages/media/tool-media/assets/media-editing'), root, { recursive: true })
      ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(ToolMedia, {
        baseURL: 'https://gateway.example/v1',
        catalog: false,
        skillAssetRoot: root,
      })
      const skill = await ctx.skills.get('media-editing')
      expect(skill?.resourceBase).toEqual({
        kind: 'directory',
        path: root,
      })
      expect(skill?.content).toContain('## 替换音轨')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['plain Markdown', '# Missing frontmatter\n', 'has no YAML frontmatter'],
    ['frontmatter without a description', '---\nname: media-editing\n---\n# Empty metadata\n', 'has no description'],
  ])('rejects %s when the skills service is present', async (_label, content, message) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-invalid-media-skill-'))
    try {
      await writeFile(join(root, 'SKILL.md'), content)
      ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(ToolMedia, {
        baseURL: 'https://gateway.example/v1',
        catalog: false,
        skillAssetRoot: root,
      })).rejects.toThrow(message)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['fontFile', { fontFile: 'fonts/cjk.ttf' }, 'fontFile must be an absolute path'],
    ['skillAssetRoot', { skillAssetRoot: 'media-editing' }, 'skillAssetRoot must be an absolute directory'],
  ])('requires an absolute %s path', async (_label, config, message) => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1',
      catalog: false,
      ...config,
    })).rejects.toThrow(message)
  })
})

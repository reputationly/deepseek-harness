import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
      .rejects.toThrow('invalid skill locator')
  })

  it('loads skill content from the configured skill root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-media-skill-'))
    try {
      await cp(join(process.cwd(), 'packages/media/tool-media/assets'), root, { recursive: true })
      ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SkillRegistry)
      await ctx.plugin(ToolMedia, {
        baseURL: 'https://gateway.example/v1',
        catalog: false,
        skillsRoot: root,
      })
      const skill = await ctx.skills.get('media-editing')
      expect(skill?.resourceBase).toEqual({
        kind: 'directory',
        path: `${join(root, 'media-editing')}/`,
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
      await mkdir(join(root, 'media-editing'), { recursive: true })
      await writeFile(join(root, 'media-editing', 'SKILL.md'), content)
      ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(ToolMedia, {
        baseURL: 'https://gateway.example/v1',
        catalog: false,
        skillsRoot: root,
      })).rejects.toThrow(message)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['fontFile', { fontFile: 'fonts/cjk.ttf' }, 'fontFile must be an absolute path'],
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

describe('bundled skill set', () => {
  it('lists every skill directory under the root', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ToolMedia, { baseURL: 'https://gateway.example/v1', catalog: false })
    const names = ['media-editing', 'studio-craft', 'studio-layout', 'studio-pipeline']
    for (const name of names) {
      expect(await ctx.skills.get(name)).toMatchObject({ name, provider: 'dsh-tool-media', source: 'bundled' })
    }
    expect((await ctx.skills.get('studio-pipeline'))?.content).toContain('设定集先行')
  })

  it('rejects a skill whose frontmatter names another directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mismatched-skill-'))
    try {
      await mkdir(join(root, 'studio-craft'), { recursive: true })
      await writeFile(join(root, 'studio-craft', 'SKILL.md'), '---\nname: media-editing\ndescription: x\n---\n# Body\n')
      ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(ToolMedia, {
        baseURL: 'https://gateway.example/v1', catalog: false, skillsRoot: root,
      })).rejects.toThrow('names skill media-editing but lives in studio-craft')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a relative root without a trailing slash', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(ToolMedia, { baseURL: 'https://gateway.example/v1', catalog: false, skillsRoot: '../assets' })
    expect(await ctx.skills.get('media-editing')).toMatchObject({ name: 'media-editing' })
  })

  it('rejects a root that does not exist', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    await expect(ctx.plugin(ToolMedia, {
      baseURL: 'https://gateway.example/v1', catalog: false, skillsRoot: join(tmpdir(), 'dsh-no-skills-here'),
    })).rejects.toThrow('ENOENT')
  })
})

describe('skill provider guards', () => {
  it('rejects a skill without a name and refuses an unknown skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-unnamed-skill-'))
    try {
      await mkdir(join(root, 'nameless'), { recursive: true })
      await writeFile(join(root, 'nameless', 'SKILL.md'), '---\ndescription: x\n---\n# Body\n')
      ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SkillRegistry)
      await expect(ctx.plugin(ToolMedia, {
        baseURL: 'https://gateway.example/v1', catalog: false, skillsRoot: root,
      })).rejects.toThrow('has no name')
      await ctx.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SkillRegistry)
    const registration = vi.spyOn(ctx.skills, 'registerProvider')
    await ctx.plugin(ToolMedia, { baseURL: 'https://gateway.example/v1', catalog: false })
    const create = registration.mock.calls.at(-1)?.[0]
    if (create === undefined) throw new Error('skills provider was not registered')
    const provider = create({ signal: new AbortController().signal, invalidate: () => {} })
    const listed = await provider.list({ cwd: process.cwd() })
    const candidate = ('candidates' in listed ? listed.candidates : listed)[0]
    if (candidate === undefined) throw new Error('no candidate')
    await expect(provider.get({ ...candidate, name: 'ghost' }, { cwd: process.cwd() }))
      .rejects.toThrow('unknown skill ghost')
  })
})

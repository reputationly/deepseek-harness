import { describe, expect, it } from 'vitest'
import { pinnedPlugins, stalePlugins } from './plugin-freshness.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const manifest = JSON.stringify({
  dependencies: {
    '@deepseek-ai/dsh-base': 'workspace:*',
    '@michengai/dsh-im-connect': '1.0.46',
    '@q253595422/dsh-imagegen-video': `https://raw.githubusercontent.com/reputationly/dsh-imagegen-video/${SHA_A}/q253595422-dsh-imagegen-video-1.35.0-suanli.2.tgz`,
    '@michengai/dsh-codex-pet': 'https://raw.githubusercontent.com/reputationly/dsh-codex-pet/dist/pet.tgz',
  },
})

describe('plugin freshness', () => {
  it('reads only commit-pinned raw tarballs', () => {
    expect(pinnedPlugins(manifest)).toEqual([{
      name: '@q253595422/dsh-imagegen-video',
      owner: 'reputationly',
      repo: 'dsh-imagegen-video',
      sha: SHA_A,
      file: 'q253595422-dsh-imagegen-video-1.35.0-suanli.2.tgz',
    }])
  })

  it('passes when the pin is the dist head', () => {
    const pins = pinnedPlugins(manifest)
    expect(stalePlugins(pins, new Map([['reputationly/dsh-imagegen-video', SHA_A]]))).toEqual([])
  })

  it('reports a dist branch that moved past the pin', () => {
    const pins = pinnedPlugins(manifest)
    expect(stalePlugins(pins, new Map([['reputationly/dsh-imagegen-video', SHA_B]]))).toEqual([
      { name: '@q253595422/dsh-imagegen-video', pinned: SHA_A, head: SHA_B },
    ])
  })

  it('rejects a repository with no dist branch', () => {
    expect(() => stalePlugins(pinnedPlugins(manifest), new Map())).toThrow('reputationly/dsh-imagegen-video has no dist branch')
  })
})

/** The one-button release must build every shipped target in parallel and publish each one. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { expect, it } from 'vitest'

interface WorkflowStep {
  id?: string
  if?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}

const workflow = yaml.load(readFileSync(resolve(import.meta.dirname,
  '../.github/workflows/suanli-assistant-release.yml'), 'utf8')) as {
  on: Record<string, unknown>
  jobs: Record<string, {
    needs?: string | string[]
    steps: WorkflowStep[]
    strategy?: { 'fail-fast'?: boolean; matrix: { include: Array<{ os: string; script: string; target: string; artifact: string }> } }
  }>
}

it('builds the shipped targets in one parallel matrix', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
  const strategy = workflow.jobs.build!.strategy!
  expect(strategy['fail-fast']).toBe(false)
  expect(strategy.matrix.include).toEqual([
    { os: 'macos-latest', script: 'package:mac:arm64:unsigned', target: 'mac-arm64', artifact: 'mac-arm64' },
    { os: 'macos-latest', script: 'package:mac:x64:unsigned', target: 'mac-x64', artifact: 'mac-x64' },
    { os: 'windows-latest', script: 'package:win:x64:unsigned', target: 'win-x64', artifact: 'win-x64' },
  ])
})

it('synthesizes an update payload for every macOS target', () => {
  const step = workflow.jobs.build!.steps.find(candidate => candidate.run?.includes('aurora-publish.mjs')
    && candidate.run.includes('--feed-only'))
  expect(step?.if).toBe("startsWith(matrix.target, 'mac')")
  // Only a macOS runner can zip an application bundle the updater accepts.
  expect(workflow.jobs.build!.strategy!.matrix.include
    .filter(entry => entry.target.startsWith('mac'))
    .every(entry => entry.os.startsWith('macos'))).toBe(true)
})

it('publishes one directory per target so same-named macOS feeds cannot cross', () => {
  const publish = workflow.jobs.publish!
  expect(publish.needs).toEqual(['prepare', 'build'])
  const download = publish.steps.find(step => step.uses?.startsWith('actions/download-artifact'))
  expect(download?.with).toMatchObject({ pattern: 'installer-*', path: 'artifacts' })
  expect(download?.with).not.toHaveProperty('merge-multiple')
  const publishStep = publish.steps.find(step => step.run?.includes('aurora-publish.mjs'))
  expect(publishStep?.run).toContain('for directory in artifacts/installer-*')
  expect(publishStep?.run).toContain('--artifacts "$directory"')
})

it('verifies the pointer of every published target', () => {
  const verify = workflow.jobs.publish!.steps.find(step => step.run?.includes('does not name'))
  for (const target of ['darwin-arm64:nightly-mac.yml', 'darwin-x64:nightly-mac.yml', 'win32-x64:nightly.yml']) {
    expect(verify?.run).toContain(target)
  }
  const cache = workflow.jobs.publish!.steps.find(step => step.run?.includes('eo-cache.mjs'))
  for (const index of ['installer-mac-arm64/darwin-arm64-latest.json', 'installer-mac-x64/darwin-x64-latest.json',
    'installer-win-x64/win32-x64-latest.json']) {
    expect(cache?.run).toContain(index)
  }
})

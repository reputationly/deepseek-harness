/**
 * 发版前确认外部插件都是最新发行包。
 *
 * `apps/cli/package.json` 用 raw 地址按 `dist` 分支的提交号固定外部插件的发行包。
 * 插件仓库每打一个包就在 `dist` 上追加一个提交，所以固定的提交号不是 `dist` 的最新提交，
 * 就说明有新发行包还没合进宿主（通常是插件 CI 开的升级 PR 还没合并）。这时发版会打进旧插件，脚本以非零码退出。
 *
 *     node scripts/release/plugin-freshness.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PINNED = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/([^/]+\.tgz)$/u

/**
 * @param {string} manifestText
 * @returns {{ name: string, owner: string, repo: string, sha: string, file: string }[]}
 */
export function pinnedPlugins(manifestText) {
  const manifest = JSON.parse(manifestText)
  const specs = { ...manifest.dependencies, ...manifest.optionalDependencies }
  return Object.entries(specs).flatMap(([name, spec]) => {
    const match = PINNED.exec(String(spec))
    return match === null ? [] : [{ name, owner: match[1], repo: match[2], sha: match[3], file: match[4] }]
  })
}

/**
 * @param {ReturnType<typeof pinnedPlugins>} pins
 * @param {ReadonlyMap<string, string>} heads - `dist` head commit per `owner/repo`.
 * @returns {{ name: string, pinned: string, head: string }[]}
 */
export function stalePlugins(pins, heads) {
  return pins.flatMap(pin => {
    const head = heads.get(`${pin.owner}/${pin.repo}`)
    if (head === undefined) throw new Error(`${pin.owner}/${pin.repo} has no dist branch`)
    return head === pin.sha ? [] : [{ name: pin.name, pinned: pin.sha, head }]
  })
}

function distHead(owner, repo) {
  const out = execFileSync('git', ['ls-remote', `https://github.com/${owner}/${repo}.git`, 'refs/heads/dist'], { encoding: 'utf8' })
  return out.split(/\s/u)[0] || undefined
}

function main() {
  const pins = pinnedPlugins(readFileSync(new URL('../../apps/cli/package.json', import.meta.url), 'utf8'))
  const heads = new Map()
  for (const pin of pins) {
    const key = `${pin.owner}/${pin.repo}`
    const head = distHead(pin.owner, pin.repo)
    if (head !== undefined) heads.set(key, head)
  }
  const stale = stalePlugins(pins, heads)
  for (const pin of pins) console.log(`${pin.name}: ${pin.file} @ ${pin.sha.slice(0, 10)}`)
  if (stale.length === 0) return
  for (const entry of stale) {
    console.error(`::error::${entry.name} 有新发行包还没合进宿主：固定在 dist@${entry.pinned.slice(0, 10)}，dist 最新是 ${entry.head.slice(0, 10)}。先合并插件升级 PR 再发版。`)
  }
  process.exitCode = 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()

/**
 * 让 EdgeOne 立刻认识刚发布的那一版。
 *
 * 发布脚本把字节传进 R2 之后就结束了，CDN 那边的指针还停在上一版，按自己的 `max-age` 慢慢过期。
 * 这里补上后半程：刷新（CreatePurgeTask）指针和浮动入口，让 `latest.json` / `nightly.yml` /
 * 稳定文件名立刻翻转，不会出现"页面写着新版、下载到旧包"。
 *
 * 这里**不做预热**。EdgeOne 的[套餐选型对比]里预热那一行对免费版是 ✕（单次额度、单日额度都是 0），
 * 任何 URL 提交都会得到 `LimitExceeded.BatchQuota`，留着只会每发布一次打印三条告警。真要预热，
 * 先升到有额度的套餐再把 CreatePrefetchTask 加回来。
 *
 * 只依赖 Node 的内置 crypto 与 fetch：发布 job 不装依赖，也不能因为要调一次缓存接口去装一个 SDK。
 *
 *     EO_SECRET_ID=… EO_SECRET_KEY=… EO_ZONE_ID=zone-… \
 *     node scripts/release/eo-cache.mjs --index artifacts/win32-x64-latest.json --dry-run
 *
 * A release derives its URLs from the index; ops refreshes arbitrary ones directly:
 *
 *     node scripts/release/eo-cache.mjs --purge https://download.ovaijisuan.com/download
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

/** Tencent Cloud EdgeOne endpoint; every call below is one signed JSON POST. */
const ENDPOINT = 'https://teo.tencentcloudapi.com'
const HOST = 'teo.tencentcloudapi.com'
const SERVICE = 'teo'
const VERSION = '2022-09-01'
const CONTENT_TYPE = 'application/json; charset=utf-8'

/** Environment names, so a caller never has to know the shape of the credentials. */
const CREDENTIALS = {
  secretId: 'EO_SECRET_ID',
  secretKey: 'EO_SECRET_KEY',
  zone: 'EO_ZONE_ID',
}

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex')
const hmac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest()

/**
 * Sign one request with TC3-HMAC-SHA256.
 * @param action - API action name.
 * @param payload - request body, already serialized.
 * @param credentials - secret id, secret key, and the zone the call targets.
 * @returns the headers the request needs.
 */
function headers(action, payload, credentials) {
  const timestamp = Math.floor(Date.now() / 1000)
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const canonical = [
    'POST',
    '/',
    '',
    `content-type:${CONTENT_TYPE}`,
    `host:${HOST}`,
    '',
    'content-type;host',
    sha256(payload),
  ].join('\n')
  const scope = `${date}/${SERVICE}/tc3_request`
  const signature = hmac(
    hmac(hmac(`TC3${credentials.secretKey}`, date), SERVICE),
    'tc3_request',
  )
  const signed = createHmac('sha256', signature)
    .update([`TC3-HMAC-SHA256`, String(timestamp), scope, sha256(canonical)].join('\n'), 'utf8')
    .digest('hex')
  return {
    authorization: `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signed}`,
    'content-type': CONTENT_TYPE,
    'x-tc-action': action,
    'x-tc-timestamp': String(timestamp),
    'x-tc-version': VERSION,
  }
}

/**
 * Call one EdgeOne API action.
 * @param action - API action name.
 * @param body - request body.
 * @param credentials - secret id, secret key, and zone.
 * @returns the parsed response payload.
 */
async function call(action, body, credentials) {
  const payload = JSON.stringify(body)
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: headers(action, payload, credentials),
    body: payload,
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`${action}: response was not JSON (HTTP ${String(response.status)})`)
  }
  const failure = parsed?.Response?.Error
  if (failure !== undefined) {
    throw new Error(`${action}: ${String(failure.Code ?? 'unknown')} ${String(failure.Message ?? '')}`.trim())
  }
  return parsed.Response
}

/**
 * Read one staged index and derive the pointers it names.
 * @param file - path to a `latest.json` the publish step wrote.
 * @returns the URLs to refresh: the feed, every stable entry, and the index itself.
 */
export function planFromIndex(file) {
  const index = JSON.parse(readFileSync(file, 'utf8'))
  const refresh = [index.feed, ...(index.files ?? []).map(entry => entry.stableUrl)]
    .filter(url => typeof url === 'string')
  // The index lives beside the feed it names; rebuild its URL instead of guessing the bucket layout.
  const feed = typeof index.feed === 'string' ? index.feed.replace(/\/[^/]+$/u, '') : undefined
  if (feed !== undefined) refresh.push(`${feed}/latest.json`)
  return { refresh: [...new Set(refresh.filter(Boolean))] }
}

/**
 * Merge the URLs a release derives from its indexes with the ones ops names directly.
 * @param indexes - index files to plan from.
 * @param extraRefresh - URLs to refresh that no index mentions; trimmed, blanks dropped.
 * @returns refresh targets without duplicates, extra refreshes first.
 */
export function planTargets(indexes, extraRefresh = []) {
  const refresh = extraRefresh.map(url => url.trim()).filter(url => url !== '')
  for (const file of indexes) refresh.push(...planFromIndex(file).refresh)
  return { refresh: [...new Set(refresh)] }
}

async function run({ indexes, extraRefresh, credentials, dryRun }) {
  const targets = planTargets(indexes, extraRefresh)
  console.log(`eo cache: ${String(targets.refresh.length)} to refresh`)
  for (const url of targets.refresh) console.log(`  refresh ${url}`)
  if (dryRun) return
  if (targets.refresh.length > 0) {
    const submitted = await call(
      'CreatePurgeTask',
      { ZoneId: credentials.zone, Type: 'purge_url', Targets: targets.refresh },
      credentials,
    )
    const failed = submitted.FailedList ?? []
    console.log(`eo cache: purge task ${String(submitted.JobId ?? '?')}${failed.length === 0 ? '' : `, ${String(failed.length)} rejected`}`)
    for (const entry of failed) console.log(`  rejected ${String(entry.Url ?? '')} ${String(entry.Reason ?? '')}`.trim())
  }
}


async function main() {
  const { values } = parseArgs({
    options: {
      index: { type: 'string', multiple: true, default: [] },
      purge: { type: 'string', multiple: true, default: [] },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const indexes = values.index
  const extraRefresh = values.purge
  if (indexes.length === 0 && extraRefresh.every(url => url.trim() === '')) {
    throw new Error('eo cache: give at least one --index <latest.json> or --purge <url>')
  }
  const credentials = {
    secretId: process.env[CREDENTIALS.secretId]?.trim() ?? '',
    secretKey: process.env[CREDENTIALS.secretKey]?.trim() ?? '',
    zone: process.env[CREDENTIALS.zone]?.trim() ?? '',
  }
  if (!values['dry-run']) {
    for (const [name, value] of Object.entries(credentials)) {
      if (value === '') throw new Error(`eo cache: ${CREDENTIALS[name]} is required unless --dry-run`)
    }
  }
  await run({ indexes, extraRefresh, credentials, dryRun: values['dry-run'] })
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

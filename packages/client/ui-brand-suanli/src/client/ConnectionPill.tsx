/** Connection light beside the wordmark: one dot plus its label, with the failure reason in the tooltip. */

import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { GatewayStatus } from '@deepseek-ai/dsh-api-gateway-status/types'
import css from './ConnectionPill.module.css'

/** Poll cadence while connected: reading the cached observation, so this stays cheap. */
const CONNECTED_POLL_MS = 30_000
/** Poll cadence while disconnected: probing again, so a recovered key or network shows quickly. */
const DISCONNECTED_POLL_MS = 3_000

const CHECKING: GatewayStatus = { state: 'checking', code: 'unreachable' }

/** Operations the registration injects: the Host namespace, minus its transport envelope. */
export interface GatewayStatusFace {
  /** @returns the latest observation without probing the gateway. */
  readonly read: () => Promise<GatewayStatus>
  /** @returns a fresh observation, probing the gateway now. */
  readonly refresh: () => Promise<GatewayStatus>
}

/** Render inputs: the Host namespace and the plugin dictionary. */
export type ConnectionPillProps = PropsLocale<'gatewayStatus'> & GatewayStatusFace

/**
 * @param props - connection operations and the locale seat.
 * @returns the connection light shown beside the product name.
 */
export function ConnectionPill({ read, refresh, t }: ConnectionPillProps): ReactNode {
  const [status, setStatus] = useState<GatewayStatus>(CHECKING)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ask = async (probe: boolean): Promise<void> => {
      try {
        const next = probe ? await refresh() : await read()
        if (!alive) return
        setStatus(next)
        // A disconnected light proves the endpoint again; a connected one only re-reads the cache.
        timer = setTimeout(() => { void ask(next.state !== 'connected') },
          next.state === 'connected' ? CONNECTED_POLL_MS : DISCONNECTED_POLL_MS)
      } catch {
        if (alive) timer = setTimeout(() => { void ask(false) }, DISCONNECTED_POLL_MS)
      }
    }
    void ask(true)
    return () => {
      alive = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [read, refresh])

  const label = t(status.state === 'connected' ? 'connected' : status.state === 'disconnected' ? 'disconnected' : 'checking')
  const reason = status.state === 'disconnected'
    ? t(reasonKey(status.code), { detail: status.detail ?? '' })
    : label
  return <button type="button" className={css.pill} aria-label={reason} title={reason}
    data-state={status.state} onClick={() => { void refresh().then(setStatus, () => undefined) }}>
    <span className={clsx(css.dot, css[status.state])} aria-hidden="true" />
    <span className={css.label}>{label}</span>
  </button>
}

/**
 * @param code - the failure the Host reported.
 * @returns the dictionary key explaining it.
 */
function reasonKey(code: GatewayStatus['code']): 'reason.no-key' | 'reason.key-rejected' | 'reason.http-error' | 'reason.unreachable' {
  switch (code) {
    case 'no-key': return 'reason.no-key'
    case 'key-rejected': return 'reason.key-rejected'
    case 'http-error': return 'reason.http-error'
    case 'unreachable': return 'reason.unreachable'
    // A disconnected light never carries this code; it explains the state it would contradict.
    case 'connected': return 'reason.unreachable'
  }
}

/** Footer light: one dot plus its label, with the failure reason in the tooltip. */

import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
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

/** Render inputs: the sidebar width flag, the Host namespace, and the plugin dictionary. */
export type ConnectionPillProps =
  PropsRuntime<'sidebar.footer.action'> & PropsLocale<'gatewayStatus'> & InjectFace<GatewayStatusFace>

/**
 * @param props - sidebar width flag, connection operations, and locale seat.
 * @returns the connection light for the model gateway.
 */
export function ConnectionPill({ wide, read, refresh, t }: ConnectionPillProps): ReactNode {
  const [status, setStatus] = useState<GatewayStatus>(CHECKING)
  const [retrying, setRetrying] = useState(false)

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

  const retry = (): void => {
    setRetrying(true)
    void refresh().then((next) => { setStatus(next) }, () => undefined).finally(() => { setRetrying(false) })
  }

  return (
    <button type="button" className={clsx(css.pill, wide ? css.wide : css.rail)} aria-label={reason} title={reason}
      disabled={retrying} onClick={retry}>
      <span className={clsx(css.dot, css[status.state])} aria-hidden="true" />
      {wide ? <span className={css.label}>{label}</span> : null}
    </button>
  )
}

/**
 * @param code - failure code from the Host observation.
 * @returns the dictionary key that explains it.
 */
function reasonKey(code: GatewayStatus['code']): 'reason.no-key' | 'reason.key-rejected' | 'reason.http-error' | 'reason.unreachable' {
  if (code === 'no-key') return 'reason.no-key'
  if (code === 'key-rejected') return 'reason.key-rejected'
  if (code === 'http-error') return 'reason.http-error'
  return 'reason.unreachable'
}

/** Settings rows that pick the model each role uses and whether generated media is reviewed. */
import { useEffect, useState, type ReactNode } from 'react'
import { Menu, Switch, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { GatewayStatusKey } from './locales.ts'
import css from './ModelRolesRow.module.css'

/** One role as this row renders it. */
export interface ModelRoleView {
  readonly role: 'chat' | 'vision' | 'image' | 'video' | 'music' | 'speech'
  readonly candidates: readonly { readonly model: string; readonly label: string }[]
  readonly selected: string | null
  readonly fallback: string | null
}

/** Roles and preferences the rows render. */
export interface ModelRolesView {
  readonly roles: readonly ModelRoleView[]
  readonly autoReview: boolean
}

/** Render inputs: the Host operations and the plugin dictionary. */
export interface ModelRolesRowProps {
  /** Read the roles and preferences. */
  readonly load: () => Promise<ModelRolesView>
  /** Choose a role's model; `null` returns to the catalog default. */
  readonly select: (role: ModelRoleView['role'], model: string | null) => Promise<ModelRolesView>
  /** Turn the review of generated media on or off. */
  readonly setAutoReview: (enabled: boolean) => Promise<ModelRolesView>
  readonly t: TranslateNS<'gatewayStatus'>
}

/** Dictionary key of each role's name. */
const ROLE_COPY = {
  chat: 'roles.chat',
  vision: 'roles.vision',
  image: 'roles.image',
  video: 'roles.video',
  music: 'roles.music',
  speech: 'roles.speech',
} as const satisfies Record<ModelRoleView['role'], GatewayStatusKey>

/** Menu id of the catalog-default choice; no model id is empty. */
const DEFAULT_ID = ''

/**
 * Model role rows: one selector per role, then the review switch.
 * @param props - the Host operations and locale seat.
 * @returns the rows, or a status line while loading or after a failed read.
 */
export function ModelRolesRow({ load, select, setAutoReview, t }: ModelRolesRowProps): ReactNode {
  const [view, setView] = useState<ModelRolesView | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<ModelRoleView['role'] | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    load().then((next) => { if (alive) setView(next) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [load])

  const run = async (change: () => Promise<ModelRolesView>): Promise<void> => {
    setBusy(true)
    try {
      setView(await change())
      setFailed(false)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const labelOf = (role: ModelRoleView, model: string | null): string =>
    role.candidates.find(candidate => candidate.model === model)?.label ?? model ?? ''

  return (
    <div className={css.group} role="group" aria-label={t('roles.title')}>
      <div className={css.header}>
        <p className={css.title}>{t('roles.title')}</p>
        <p className={css.detail}>{t('roles.description')}</p>
        {failed ? <p className={css.detail} role="alert">{t('roles.failed')}</p> : null}
      </div>
      {view === undefined
        ? (failed ? null : <p className={css.detail} role="status">{t('roles.loading')}</p>)
        : <>
          {view.roles.map((role) => {
            const name = t(ROLE_COPY[role.role])
            const current = role.selected ?? role.fallback
            const value = current === null ? t('roles.unavailable') : labelOf(role, current)
            const pickable = role.role !== 'chat' && role.candidates.length > 0
            return (
              <div key={role.role} className={css.row}>
                <div className={css.copy}>
                  <p className={css.name}>{name}</p>
                  {role.role === 'chat' ? <p className={css.detail}>{t('roles.chat-hint')}</p> : null}
                </div>
                {pickable
                  ? <Menu open={open === role.role} onClose={() => { setOpen(undefined) }} portal align="end"
                    selectedId={role.selected ?? DEFAULT_ID}
                    items={[
                      { id: DEFAULT_ID, label: t('roles.default', { model: labelOf(role, role.fallback) }) },
                      ...role.candidates.map(candidate => ({ id: candidate.model, label: candidate.label })),
                    ]}
                    onSelect={(id) => {
                      setOpen(undefined)
                      void run(async () => await select(role.role, id === DEFAULT_ID ? null : id))
                    }}
                    anchor={<button type="button" className={css.selector} disabled={busy}
                      aria-label={name} aria-haspopup="menu" aria-expanded={open === role.role}
                      onClick={() => { setOpen(open === role.role ? undefined : role.role) }}>
                      <span className={css.value}>{value}</span>
                      <IconChevronDownOutlineRegular className={css.chevron} />
                    </button>} />
                  : <span className={css.fixed}>{value}</span>}
              </div>
            )
          })}
          <div className={css.row}>
            <div className={css.copy}>
              <p className={css.name}>{t('roles.review')}</p>
              <p className={css.detail}>{t('roles.review-description')}</p>
            </div>
            <Switch checked={view.autoReview} disabled={busy} label={t('roles.review')}
              onChange={(next) => { void run(async () => await setAutoReview(next)) }} />
          </div>
        </>}
    </div>
  )
}

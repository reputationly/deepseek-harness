/** Settings row choosing the model and reasoning effort new conversations start with. */
import { useEffect, useState } from 'react'
import { Menu, IconChevronDownOutlineRegular, IconLoadingOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelCatalog, ModelCatalogModel, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import css from './DefaultModelRow.module.css'

/** Host access for the default selection. */
export interface DefaultModelRowInjected {
  /** Read the routable catalog and the current default. */
  load: () => Promise<ModelCatalog>
  /** Save a default selection; resolves to the selection the Host accepted. */
  save: (selection: ModelSelection) => Promise<ModelSelection>
}

interface Choice { readonly id: string; readonly label: string; readonly provider: string; readonly model: ModelCatalogModel }

function choicesOf(catalog: ModelCatalog): Choice[] {
  const single = catalog.groups.length === 1
  return catalog.groups.flatMap(group => group.models.map(model => ({
    id: JSON.stringify([group.id, model.id]),
    label: single ? model.name : `${group.name} · ${model.name}`,
    provider: group.id,
    model,
  })))
}

/**
 * Render the default model and effort selectors.
 * @param props - slot runtime, `model` dictionary, and Host access.
 * @returns the settings row.
 */
export function DefaultModelRow({ load, save, t }:
  PropsRuntime<'settings.general.item'> & PropsLocale<'model'> & InjectFace<DefaultModelRowInjected>) {
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [current, setCurrent] = useState<ModelSelection>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<'model' | 'effort'>()
  useEffect(() => {
    let live = true
    load().then((value) => {
      if (!live) return
      setCatalog(value)
      setCurrent(value.default)
    }, (reason: unknown) => {
      if (live) setError(t('defaults.error', { message: reason instanceof Error ? reason.message : String(reason) }))
    })
    return () => { live = false }
  }, [load, t])

  const choices = catalog === undefined ? [] : choicesOf(catalog)
  const selected = choices.find(choice =>
    current !== undefined && choice.provider === current.provider && choice.model.id === current.model)
  const efforts = selected?.model.reasoning?.efforts ?? []
  const effort = current?.reasoningEffort ?? selected?.model.reasoning?.defaultEffort
  const commit = (next: ModelSelection): void => {
    setBusy(true)
    setError('')
    save(next).then((saved) => { setCurrent(saved) }, (reason: unknown) => {
      setError(t('defaults.error', { message: reason instanceof Error ? reason.message : String(reason) }))
    }).finally(() => { setBusy(false) })
  }
  const pill = (which: 'model' | 'effort', label: string, aria: string, disabled: boolean) =>
    <button type="button" className={css.selector} disabled={disabled} aria-busy={busy} aria-label={aria}
      aria-haspopup="menu" aria-expanded={open === which} onClick={() => { setOpen(open === which ? undefined : which) }}>
      {label}
      {busy ? <IconLoadingOutlineRegular className={css.spinner} /> : <IconChevronDownOutlineRegular className={css.chevron} />}
    </button>

  return <div className={css.row} role="group" aria-label={t('defaults.title')}>
    <div className={css.rowText}>
      <div className={css.title}>{t('defaults.title')}</div>
      <div className={css.description}>{t('defaults.description')}</div>
      {error === '' ? null : <div className={css.error} role="alert">{error}</div>}
    </div>
    <div className={css.controls}>
      <Menu open={open === 'model'} onClose={() => { setOpen(undefined) }} portal align="end"
        selectedId={selected?.id ?? ''}
        items={choices.map(choice => ({ id: choice.id, label: choice.label }))}
        onSelect={(id) => {
          setOpen(undefined)
          const choice = choices.find(entry => entry.id === id)
          if (choice === undefined) return
          const keep = effort !== undefined && choice.model.reasoning?.efforts.some(entry => entry.id === effort) === true
          const nextEffort = keep ? effort : choice.model.reasoning?.defaultEffort
          commit({ provider: choice.provider, model: choice.model.id, ...nextEffort === undefined ? {} : { reasoningEffort: nextEffort } })
        }}
        anchor={pill('model', selected?.label ?? t(catalog === undefined ? 'trigger.loading' : 'trigger.fallback'), t('menu.model'),
          busy || choices.length === 0)} />
      {efforts.length === 0 ? null : <Menu open={open === 'effort'} onClose={() => { setOpen(undefined) }} portal align="end"
        selectedId={effort ?? ''}
        items={efforts.map(entry => ({ id: entry.id, label: entry.name }))}
        onSelect={(id) => {
          setOpen(undefined)
          if (selected === undefined) return
          commit({ provider: selected.provider, model: selected.model.id, reasoningEffort: id })
        }}
        anchor={pill('effort', efforts.find(entry => entry.id === effort)?.name ?? t('effort.providerDefault'), t('defaults.effort'), busy)} />}
    </div>
  </div>
}

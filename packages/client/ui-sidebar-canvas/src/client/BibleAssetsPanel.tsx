/** Bible and asset panels: the shared cast and the media already on the canvas. */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Bible, CanvasDocument, CanvasNode } from '@deepseek-ai/dsh-canvas/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './BibleAssetsPanel.module.css'
import type { CanvasSource } from './canvas-source.ts'

/** Inputs of the shared panel. */
export interface BibleAssetsPanelProps {
  readonly document: CanvasDocument
  readonly bible: Bible | undefined
  readonly edit: CanvasSource['edit']
  readonly generate?: (nodeId: string) => void
  readonly select: (nodeId: string) => void
  readonly close: () => void
  readonly t: PropsLocale<typeof NS>['t']
}

const ASSET_TYPES = ['image', 'video', 'audio', 'timeline'] as const
type AssetType = typeof ASSET_TYPES[number]

/**
 * Bible and asset browser.
 * @param props - document, bible, edit call, and copy.
 * @returns the panel with its two tabs.
 */
export function BibleAssetsPanel({ document, bible, edit, generate, select, close, t }: BibleAssetsPanelProps): ReactNode {
  const [tab, setTab] = useState<'bible' | 'assets'>('bible')
  const [filter, setFilter] = useState<AssetType | 'all'>('all')
  const [creating, setCreating] = useState<string>()
  const [failed, setFailed] = useState(false)
  const entries = bible?.entries ?? []
  const assets = document.nodes.filter(node => (ASSET_TYPES as readonly string[]).includes(node.type)
    && (filter === 'all' || node.type === filter))
  const threeView = async (entry: NonNullable<typeof bible>['entries'][number]): Promise<void> => {
    if (generate === undefined) return
    setCreating(entry.id)
    setFailed(false)
    let created: string | undefined
    try {
      await edit([{
        op: 'add', ref: 'three-view', type: 'image', title: `${entry.name} ${t('bible.threeView')}`, bible: entry.id,
        gen: {
          kind: 'image',
          prompt: t('bible.threeViewPrompt', { name: entry.name, description: entry.description }),
          params: {},
        },
      }], { onApplied: (_before, _operations, result) => { created = result.refs['three-view'] } })
      if (created === undefined) {
        setFailed(true)
        return
      }
      select(created)
      generate(created)
    } catch (_error: unknown) {
      setFailed(true)
    } finally {
      setCreating(undefined)
    }
  }
  return <aside className={css.root} aria-label={t('bible.title')}>
    <header className={css.header}>
      <div className={css.tabs} role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'bible'} className={clsx(css.tab, tab === 'bible' && css.tabActive)}
          onClick={() => { setTab('bible') }}>{t('bible.tab')}</button>
        <button type="button" role="tab" aria-selected={tab === 'assets'} className={clsx(css.tab, tab === 'assets' && css.tabActive)}
          onClick={() => { setTab('assets') }}>{t('assets.tab')}</button>
      </div>
      <Button size="sm" aria-label={t('bible.close')} onClick={close}>×</Button>
    </header>
    {tab === 'bible' && <div className={css.body}>
      {failed ? <p className={css.empty} role="alert">{t('bible.threeViewFailed')}</p> : undefined}
      {(['character', 'location', 'prop'] as const).map(kind => <section key={kind} className={css.group}>
        <span className={css.groupTitle}>{t(`bible.kind.${kind}`)}</span>
        {entries.filter(entry => entry.kind === kind).map(entry => <div key={entry.id} className={css.entry}>
          <span className={css.entryName} title={entry.description}>{entry.name}</span>
          <Button size="sm" disabled={generate === undefined || creating !== undefined} onClick={() => { void threeView(entry) }}>{t('bible.threeView')}</Button>
        </div>)}
        {entries.every(entry => entry.kind !== kind) ? <p className={css.empty}>{t('bible.empty')}</p> : undefined}
      </section>)}
    </div>}
    {tab === 'assets' && <div className={css.body}>
      <div className={css.filters} role="group" aria-label={t('assets.filter')}>
        {(['all', ...ASSET_TYPES] as const).map(type => <button key={type} type="button"
          className={clsx(css.filter, filter === type && css.filterActive)}
          onClick={() => { setFilter(type) }}>{type === 'all' ? t('assets.all') : t(`assets.kind.${type}`)}</button>)}
      </div>
      <ul className={css.assets}>
        {assets.map((node: CanvasNode) => <li key={node.id}>
          <button type="button" className={css.asset} onClick={() => { select(node.id) }}>{node.title}</button>
        </li>)}
      </ul>
      {assets.length === 0 ? <p className={css.empty}>{t('assets.empty')}</p> : undefined}
    </div>}
  </aside>
}

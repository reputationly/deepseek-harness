/** Full-width storyboard editor: every shot field, the dialogue lines, and the live segmentation. */
import { useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CanvasNode, CanvasOperation, DialogueLine, Shot, ShotId } from '@deepseek-ai/dsh-canvas/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  appendShotOperation, blankShot, cellOperation, moveShotOperation, removeShotOperation, rowsOf, segmentTone, summaryOf,
  type TableField,
} from './model/table.ts'
import type { NS } from './locales.ts'
import css from './StoryboardTable.module.css'

/** Inputs of the table editor. */
export interface StoryboardTableProps {
  readonly node: CanvasNode
  readonly edit: (operations: readonly CanvasOperation[]) => Promise<void>
  readonly close: () => void
  readonly t: PropsLocale<typeof NS>['t']
}

const SHOT_SIZES = ['extreme_wide', 'wide', 'full', 'medium', 'medium_close', 'close', 'extreme_close', 'insert'] as const

/**
 * Editor of one storyboard's shots.
 * @param props - storyboard node, edit call, and copy.
 * @returns the table with its summary and row actions.
 */
export function StoryboardTable({ node, edit, close, t }: StoryboardTableProps): ReactNode {
  const rows = rowsOf(node)
  const summary = summaryOf(node)
  const [dragging, setDragging] = useState<number>()
  const change = (shot: Shot, field: TableField, value: string | number | readonly string[]): void => {
    void edit([cellOperation(node, shot.id, field, value)])
  }
  const dialogueText = (shot: Shot): string => shot.dialogue.map(line => line.line).join('\n')
  const setDialogue = (shot: Shot, text: string): void => {
    const lines = text.split('\n').filter(line => line.trim() !== '')
    const dialogue: DialogueLine[] = lines.map((line, index) => ({
      id: shot.dialogue[index]?.id ?? (`d${String(index + 1)}` as DialogueLine['id']),
      speaker: shot.dialogue[index]?.speaker ?? { kind: 'narrator' },
      line,
    }))
    void edit([{ op: 'update_shot', node: node.id, shot: shot.id, patch: { dialogue } }])
  }
  return <section className={css.root} aria-label={t('table.title')}>
    <header className={css.header}>
      <span className={css.title} title={node.title}>{node.title}</span>
      <Button size="sm" aria-label={t('table.close')} onClick={close}>×</Button>
    </header>
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            <th>{t('table.index')}</th>
            <th>{t('table.shotSize')}</th>
            <th className={css.wide}>{t('table.visual')}</th>
            <th>{t('table.motion')}</th>
            <th>{t('table.camera')}</th>
            <th>{t('table.duration')}</th>
            <th className={css.wide}>{t('table.dialogue')}</th>
            <th>{t('table.sfx')}</th>
            <th>{t('table.negative')}</th>
            <th aria-label={t('table.actions')} />
          </tr>
        </thead>
        <tbody>
          {rows.map((shot, index) => <tr
            key={shot.id}
            className={clsx(css.row, css[`tone${String(segmentTone(summary.segments, shot.id))}`])}
            draggable
            onDragStart={() => { setDragging(index) }}
            onDragOver={(event) => { event.preventDefault() }}
            onDrop={() => {
              if (dragging === undefined || dragging === index) return
              const after = index === 0 ? undefined : rows[index - 1]?.id
              setDragging(undefined)
              void edit([moveShotOperation(node, rows[dragging]?.id as ShotId, after)])
            }}
          >
            <td className={css.index}>{index + 1}</td>
            <td>
              <select className={css.cell} value={shot.shotSize} onChange={(event) => { change(shot, 'shotSize', event.target.value) }}>
                {SHOT_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
              </select>
            </td>
            <td><textarea className={css.cell} rows={2} defaultValue={shot.visual}
              onBlur={(event) => { change(shot, 'visual', event.target.value) }} /></td>
            <td><input className={css.cell} defaultValue={shot.motion}
              onBlur={(event) => { change(shot, 'motion', event.target.value) }} /></td>
            <td><input className={css.cell} defaultValue={shot.camera}
              onBlur={(event) => { change(shot, 'camera', event.target.value) }} /></td>
            <td><input className={css.cell} type="number" min={1} step={0.1} defaultValue={shot.durationSec}
              onChange={(event) => { change(shot, 'durationSec', Number(event.target.value)) }} /></td>
            <td><textarea className={css.cell} rows={2} defaultValue={dialogueText(shot)} placeholder={t('table.noDialogue')}
              onBlur={(event) => { setDialogue(shot, event.target.value) }} /></td>
            <td><input className={css.cell} defaultValue={shot.sfx}
              onBlur={(event) => { change(shot, 'sfx', event.target.value) }} /></td>
            <td><input className={css.cell} defaultValue={shot.negative}
              onBlur={(event) => { change(shot, 'negative', event.target.value) }} /></td>
            <td><Button size="sm" aria-label={t('table.removeRow')}
              onClick={() => { void edit([removeShotOperation(node, shot.id)]) }}>×</Button></td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <footer className={css.footer}>
      <Button variant="outline" size="sm" onClick={() => { void edit([appendShotOperation(node, blankShot())]) }}>
        {t('table.addRow')}
      </Button>
      <span className={css.summary}>
        {t('storyboard.summary', {
          shots: summary.shots, seconds: summary.seconds, segments: summary.segments.length, calls: summary.videoCalls,
        })}
      </span>
    </footer>
  </section>
}

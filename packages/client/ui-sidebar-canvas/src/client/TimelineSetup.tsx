/** Output settings and pinned source insertion for the editing application. */
import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  CanvasDocument,
  Timeline,
  TimelineClipId,
  TimelineOperation,
  TimelineTrackId,
} from '@deepseek-ai/dsh-canvas/client'
import { clipId, milliseconds, OUTPUT_SPECS, seconds } from './timeline-model.ts'
import { trackLabels } from './TimelineTracks.tsx'
import type { NS } from './locales.ts'
import css from './TimelineEditor.module.css'

type Apply = (operations: readonly TimelineOperation[], revision: number, spec?: Timeline['spec']) => Promise<boolean>
type FormProps = PropsLocale<typeof NS> & {
  readonly document: Timeline | undefined
  readonly disabled: boolean
  readonly apply: Apply
  readonly draftChanged: (dirty: boolean) => void
  readonly discard: () => void
}

/** The first edit supplies a full output spec; subsequent edits use the same set_spec command. */
export function TimelineSpecForm({ document, disabled, apply, draftChanged, discard, t }: FormProps) {
  const [draft, setDraft] = useState<{
    revision: number
    values: Partial<Record<'width' | 'height' | 'fps', string>>
  }>()
  const form = useRef<HTMLFormElement>(null)
  const spec = document?.spec ?? OUTPUT_SPECS[0]
  const values = { width: String(spec.width), height: String(spec.height), fps: String(spec.fps), ...draft?.values }
  const change = (updates: Partial<typeof values>): void => {
    setDraft(current => ({
      revision: current?.revision ?? document?.revision ?? 0,
      values: { ...current?.values, ...updates },
    }))
    draftChanged(true)
  }
  const save = async (latest: boolean): Promise<void> => {
    if (disabled || !form.current?.reportValidity()) return
    const fps = ([24, 25, 30] as const).find(value => String(value) === values.fps)
    if (fps === undefined) return
    const next = { width: Number(values.width), height: Number(values.height), fps }
    const revision = latest ? (document?.revision ?? 0) : (draft?.revision ?? document?.revision ?? 0)
    if (await apply([{ op: 'set_spec', spec: next }], revision, next)) {
      setDraft(undefined)
      draftChanged(false)
    }
  }
  return (
    <form
      ref={form}
      className={css.parameterForm}
      onSubmit={(event) => {
        event.preventDefault()
        void save(false)
      }}
    >
      <fieldset className={css.fieldset} disabled={disabled}>
        <label className={css.field}>
          <span>{t('editor.output')}</span>
          <select
            className={css.input}
            value={OUTPUT_SPECS.findIndex(
              spec =>
                spec.width === Number(values.width) &&
                spec.height === Number(values.height) &&
                spec.fps === Number(values.fps),
            )}
            onChange={(event) => {
              const choice = OUTPUT_SPECS[Number(event.target.value)]
              if (choice !== undefined)
                change({ width: String(choice.width), height: String(choice.height), fps: String(choice.fps) })
            }}
          >
            <option value={-1}>{t('editor.custom')}</option>
            {OUTPUT_SPECS.map((spec, index) => (
              <option key={`${String(spec.width)}x${String(spec.height)}`} value={index}>
                {t('editor.spec', spec)}
              </option>
            ))}
          </select>
        </label>
        <div className={css.fields}>
          {(['width', 'height'] as const).map(field => (
            <label className={css.field} key={field}>
              <span>{t(field === 'width' ? 'editor.width' : 'editor.height')}</span>
              <input
                className={css.input}
                type="number"
                min={2}
                step={2}
                required
                value={values[field]}
                onChange={(event) => {
                  change({ [field]: event.target.value })
                }}
              />
            </label>
          ))}
          <label className={css.field}>
            <span>{t('editor.fps')}</span>
            <select
              className={css.input}
              value={values.fps}
              onChange={(event) => {
                change({ fps: event.target.value })
              }}
            >
              {[24, 25, 30].map(fps => (
                <option key={fps} value={fps}>
                  {fps}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={css.actions}>
          <Button size="sm" type="submit" variant="outline" disabled={document !== undefined && draft === undefined}>
            {t(document === undefined ? 'editor.initialize' : 'editor.apply')}
          </Button>
          {draft !== undefined && draft.revision !== (document?.revision ?? 0) && (
            <Button
              size="sm"
              onClick={() => {
                void save(true)
              }}
            >
              {t('editor.applyLatest')}
            </Button>
          )}
        </div>
      </fieldset>
      {draft !== undefined && (
        <Button
          size="sm"
          onClick={() => {
            setDraft(undefined)
            draftChanged(false)
            discard()
          }}
        >
          {t('editor.discard')}
        </Button>
      )}
    </form>
  )
}

type LibraryProps = Omit<FormProps, 'document'> & {
  readonly document: Timeline
  readonly canvas: CanvasDocument
  readonly selectedTrack: TimelineTrackId | undefined
  readonly playhead: number
}
interface Insertion {
  readonly revision: number
  readonly id: TimelineClipId
  readonly track: string
  readonly source: string
  readonly start: string
  readonly duration: string
  readonly in: string
  readonly content: string
}

/** A draft allocates its id once: retrying an unconfirmed insertion cannot create a second copy. */
export function TimelineLibrary({
  document,
  canvas,
  selectedTrack,
  playhead,
  disabled,
  apply,
  draftChanged,
  discard,
  t,
}: LibraryProps) {
  const [draft, setDraft] = useState<Insertion>()
  const form = useRef<HTMLFormElement>(null)
  const values = draft ?? {
    revision: document.revision,
    id: undefined,
    track: selectedTrack ?? '',
    source: '',
    start: seconds(playhead),
    duration: '',
    in: '0',
    content: '',
  }
  const track = document.tracks.find(track => track.id === values.track)
  const choices = canvas.nodes.flatMap((node) => {
    const compatible =
      track?.kind === 'audio'
        ? node.type === 'audio' || node.type === 'video'
        : track?.kind === 'video' && (node.type === 'image' || node.type === 'video')
    return !compatible
      ? []
      : (node.versions ?? [])
        .filter(version => version.path !== undefined)
        .map(version => ({ node, version, key: `${node.id}/${version.id}` }))
  })
  const source = choices.find(source => source.key === values.source)
  const duration =
    values.duration ||
    (source?.version.durationMs === undefined
      ? ''
      : seconds(Math.max(0, source.version.durationMs - milliseconds(values.in))))
  const change = (changes: Partial<Omit<Insertion, 'id' | 'revision'>>): void => {
    setDraft(current => ({
      ...values,
      ...current,
      ...changes,
      id: current?.id ?? clipId(),
      revision: current?.revision ?? document.revision,
    }))
    draftChanged(true)
  }
  const saved = draft !== undefined && document.tracks.some(track => track.clips.some(clip => clip.id === draft.id))
  const save = async (latest: boolean): Promise<void> => {
    if (disabled || saved || track === undefined || draft === undefined || !form.current?.reportValidity()) return
    if (track.kind !== 'text' && source === undefined) return
    const clip = {
      id: draft.id,
      startMs: milliseconds(values.start),
      durationMs: milliseconds(duration),
      ...(track.kind === 'text'
        ? {
          text: {
            content: values.content,
            position: 'bottom' as const,
            size: Math.max(1, Math.round(document.spec.width / 18)),
          },
        }
        : source === undefined
          ? {}
          : { source: { node: source.node.id, version: source.version.id, inMs: milliseconds(values.in) } }),
    }
    if (await apply([{ op: 'add_clip', track: track.id, clip }], latest ? document.revision : draft.revision)) {
      setDraft(undefined)
      draftChanged(false)
    }
  }
  return (
    <form
      ref={form}
      className={css.parameterForm}
      onSubmit={(event) => {
        event.preventDefault()
        void save(false)
      }}
    >
      <h3 className={css.sectionTitle}>{t('editor.addClip')}</h3>
      {saved && <p className={css.hint}>{t('editor.insertionSaved')}</p>}
      <fieldset className={css.fieldset} disabled={disabled || saved}>
        <div className={css.fields}>
          <label className={`${css.field} ${css.wide}`}>
            <span>{t('editor.track')}</span>
            <select
              className={css.input}
              required
              value={values.track}
              onChange={(event) => {
                change({ track: event.target.value, source: '', duration: '' })
              }}
            >
              <option value="">{t('editor.none')}</option>
              {document.tracks.map(track => (
                <option key={track.id} value={track.id}>
                  {t(trackLabels[track.kind])} · {track.id}
                </option>
              ))}
            </select>
          </label>
          {track?.kind === 'text' ? (
            <label className={`${css.field} ${css.wide}`}>
              <span>{t('editor.subtitle')}</span>
              <textarea
                className={css.input}
                rows={3}
                required
                value={values.content}
                onChange={(event) => {
                  change({ content: event.target.value })
                }}
              />
            </label>
          ) : (
            <label className={`${css.field} ${css.wide}`}>
              <span>{t('editor.source')}</span>
              <select
                className={css.input}
                required
                value={values.source}
                onChange={(event) => {
                  change({ source: event.target.value, duration: '', in: '0' })
                }}
              >
                <option value="">{t('editor.chooseSource')}</option>
                {choices.map(source => (
                  <option key={source.key} value={source.key}>
                    {t('editor.version', { title: source.node.title, version: source.version.id })}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className={css.field}>
            <span>{t('editor.start')}</span>
            <input
              className={css.input}
              type="number"
              required
              min={0}
              step="0.001"
              value={values.start}
              onChange={(event) => {
                change({ start: event.target.value })
              }}
            />
          </label>
          <label className={css.field}>
            <span>{t('editor.duration')}</span>
            <input
              className={css.input}
              type="number"
              required
              min={0.001}
              step="0.001"
              value={duration}
              onChange={(event) => {
                change({ duration: event.target.value })
              }}
            />
          </label>
          {track?.kind !== 'text' && (
            <label className={css.field}>
              <span>{t('editor.in')}</span>
              <input
                className={css.input}
                type="number"
                required
                min={0}
                step="0.001"
                value={values.in}
                onChange={(event) => {
                  change({ in: event.target.value })
                }}
              />
            </label>
          )}
        </div>
        <div className={css.actions}>
          <Button size="sm" type="submit" variant="outline" disabled={draft === undefined || track === undefined}>
            {t('editor.addClip')}
          </Button>
          {draft !== undefined && draft.revision !== document.revision && (
            <Button
              size="sm"
              onClick={() => {
                void save(true)
              }}
            >
              {t('editor.applyLatest')}
            </Button>
          )}
        </div>
      </fieldset>
      {draft !== undefined && (
        <Button
          size="sm"
          onClick={() => {
            setDraft(undefined)
            draftChanged(false)
            discard()
          }}
        >
          {t('editor.discard')}
        </Button>
      )}
    </form>
  )
}

/** Track gain changes also retain their baseline until an explicit apply-to-current gesture. */
export function TimelineTrackGain({
  document,
  selectedTrack,
  disabled,
  apply,
  draftChanged,
  discard,
  t,
}: Omit<LibraryProps, 'canvas' | 'playhead'>) {
  const [draft, setDraft] = useState<{ revision: number; volume: string }>()
  const form = useRef<HTMLFormElement>(null)
  const track = document.tracks.find(track => track.id === selectedTrack)
  const save = async (latest: boolean): Promise<void> => {
    if (disabled || track === undefined || draft === undefined || !form.current?.reportValidity()) return
    if (
      await apply(
        [{ op: 'set_track', track: track.id, volume: Number(draft.volume) / 100 }],
        latest ? document.revision : draft.revision,
      )
    ) {
      setDraft(undefined)
      draftChanged(false)
    }
  }
  return (
    <form
      className={css.parameterForm}
      ref={form}
      onSubmit={(event) => {
        event.preventDefault()
        void save(false)
      }}
    >
      <fieldset disabled={disabled || track === undefined} className={css.fieldset}>
        <label className={css.field}>
          <span>{t('editor.volume')}</span>
          <input
            className={css.input}
            type="number"
            min={0}
            step="0.1"
            required
            value={draft?.volume ?? String((track?.volume ?? 1) * 100)}
            onChange={(event) => {
              setDraft({ revision: draft?.revision ?? document.revision, volume: event.target.value })
              draftChanged(true)
            }}
          />
        </label>
        <div className={css.actions}>
          <Button size="sm" type="submit" disabled={draft === undefined}>
            {t('editor.apply')}
          </Button>
          {draft !== undefined && draft.revision !== document.revision && (
            <Button
              size="sm"
              onClick={() => {
                void save(true)
              }}
            >
              {t('editor.applyLatest')}
            </Button>
          )}
        </div>
      </fieldset>
      {draft !== undefined && (
        <Button
          size="sm"
          onClick={() => {
            setDraft(undefined)
            draftChanged(false)
            discard()
          }}
        >
          {t('editor.discard')}
        </Button>
      )}
    </form>
  )
}

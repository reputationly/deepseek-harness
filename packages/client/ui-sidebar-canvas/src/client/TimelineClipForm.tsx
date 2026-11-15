/** Clip parameters keep only user-changed fields; rereads never replace an active draft. */
import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Timeline, TimelineClip, TimelineOperation } from '@deepseek-ai/dsh-canvas/client'
import type { NS } from './locales.ts'
import { milliseconds, seconds } from './timeline-model.ts'
import css from './TimelineEditor.module.css'

const positions = ['top', 'center', 'bottom'] as const
const transitions = ['cut', 'dissolve', 'fade_black'] as const
const motions = ['static', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down'] as const
function fields(clip: TimelineClip, spec: Timeline['spec']) {
  return {
    start: seconds(clip.startMs),
    duration: seconds(clip.durationMs),
    in: seconds(clip.source?.inMs ?? 0),
    volume: String((clip.volume ?? 1) * 100),
    fadeIn: seconds(clip.fadeInMs ?? 0),
    fadeOut: seconds(clip.fadeOutMs ?? 0),
    opacity: String((clip.opacity ?? 1) * 100),
    fit: clip.fit ?? 'contain',
    transition: clip.transitionIn?.type ?? 'cut',
    transitionDuration: seconds(clip.transitionIn?.durationMs || 500),
    content: clip.text?.content ?? '',
    position: clip.text?.position ?? 'bottom',
    size: String(clip.text?.size ?? 48),
    color: clip.text?.color ?? '',
    stroke: clip.text?.strokeColor ?? '',
    strokeWidth: clip.text?.strokeWidth === undefined ? '' : String(clip.text.strokeWidth),
    font: clip.text?.fontFamily ?? '',
    lineHeight: clip.text?.lineHeight === undefined ? '' : String(clip.text.lineHeight),
    x: String(clip.transform?.x ?? 0),
    y: String(clip.transform?.y ?? 0),
    width: String(clip.transform?.width ?? spec.width),
    height: String(clip.transform?.height ?? spec.height),
    rotation: String(clip.transform?.rotation ?? 0),
    motion: clip.still?.type ?? 'static',
    strength: String((clip.still?.strength ?? 0.1) * 100),
  }
}
type Fields = ReturnType<typeof fields>
type Field = keyof Fields
type Copy = PropsLocale<typeof NS>['t']
const labels = {
  start: 'editor.start',
  duration: 'editor.duration',
  in: 'editor.in',
  volume: 'editor.volume',
  fadeIn: 'editor.fadeIn',
  fadeOut: 'editor.fadeOut',
  opacity: 'editor.opacity',
  fit: 'editor.fit',
  transition: 'editor.transition',
  transitionDuration: 'editor.transitionDuration',
  content: 'editor.subtitle',
  position: 'editor.position',
  size: 'editor.size',
  color: 'editor.color',
  stroke: 'editor.stroke',
  strokeWidth: 'editor.strokeWidth',
  font: 'editor.font',
  lineHeight: 'editor.lineHeight',
  x: 'editor.x',
  y: 'editor.y',
  width: 'editor.width',
  height: 'editor.height',
  rotation: 'editor.rotation',
  motion: 'editor.motion',
  strength: 'editor.strength',
} as const

export interface TimelineClipFormProps {
  readonly clip: TimelineClip
  readonly revision: number
  readonly spec: Timeline['spec']
  readonly image: boolean
  readonly removed: boolean
  readonly disabled: boolean
  readonly apply: (operations: readonly TimelineOperation[], revision: number) => Promise<boolean>
  readonly draftChanged: (dirty: boolean) => void
  readonly discard: () => void
  readonly t: Copy
}

/** Only explicit Apply uses a newer baseline; the ordinary submit retains the form's original revision. */
export function TimelineClipForm({
  clip,
  revision,
  spec,
  image,
  removed,
  disabled,
  apply,
  draftChanged,
  discard,
  t,
}: TimelineClipFormProps) {
  const [draft, setDraft] = useState<{ revision: number; values: Partial<Fields> }>()
  const [error, setError] = useState(false)
  const form = useRef<HTMLFormElement>(null)
  const values = { ...fields(clip, spec), ...draft?.values }
  const change = (field: Field, value: string): void => {
    setDraft(current => ({ revision: current?.revision ?? revision, values: { ...current?.values, [field]: value } }))
    setError(false)
    draftChanged(true)
  }
  const changed = (...keys: Field[]): boolean => keys.some(key => draft?.values[key] !== undefined)
  const input = (name: Field, min?: number, max?: number, step = '0.001', optional = false) => (
    <label className={css.field} key={name}>
      <span>{t(labels[name])}</span>
      <input
        className={css.input}
        type="number"
        required={!optional}
        step={step}
        min={min}
        max={max}
        placeholder={optional ? t('editor.default') : undefined}
        value={values[name]}
        onChange={(event) => {
          change(name, event.target.value)
        }}
      />
    </label>
  )
  const textInput = (name: 'color' | 'stroke' | 'font') => (
    <label className={css.field}>
      <span>{t(labels[name])}</span>
      <input
        className={css.input}
        value={values[name]}
        placeholder={t('editor.default')}
        pattern={name === 'font' ? undefined : '#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?'}
        onChange={(event) => {
          change(name, event.target.value)
        }}
      />
    </label>
  )
  const select = (name: 'position' | 'transition' | 'motion' | 'fit', options: readonly string[]) => (
    <label className={css.field}>
      <span>{t(labels[name])}</span>
      <select
        className={css.input}
        value={values[name]}
        onChange={(event) => {
          change(name, event.target.value)
        }}
      >
        {options.map(option => (
          <option key={option} value={option}>
            {t(optionLabels[option as keyof typeof optionLabels])}
          </option>
        ))}
      </select>
    </label>
  )
  const save = async (latest: boolean): Promise<void> => {
    if (draft === undefined || removed || disabled || !form.current?.reportValidity()) return
    const duration = milliseconds(values.duration),
      fadeIn = milliseconds(values.fadeIn),
      fadeOut = milliseconds(values.fadeOut)
    const position = positions.find(value => value === values.position),
      transition = transitions.find(value => value === values.transition)
    const motion = motions.find(value => value === values.motion),
      transitionMs = transition === 'cut' ? 0 : milliseconds(values.transitionDuration)
    if (
      position === undefined ||
      transition === undefined ||
      motion === undefined ||
      duration <= 0 ||
      fadeIn > duration ||
      fadeOut > duration ||
      transitionMs > duration
    ) {
      setError(true)
      return
    }
    const patch: Partial<Omit<TimelineClip, 'id'>> = {
      ...(changed('start') ? { startMs: milliseconds(values.start) } : {}),
      ...(changed('duration') ? { durationMs: duration } : {}),
      ...(changed('in') && clip.source !== undefined
        ? { source: { ...clip.source, inMs: milliseconds(values.in) } }
        : {}),
      ...(changed('volume') ? { volume: Number(values.volume) / 100 } : {}),
      ...(changed('fadeIn') ? { fadeInMs: fadeIn } : {}),
      ...(changed('fadeOut') ? { fadeOutMs: fadeOut } : {}),
      ...(changed('opacity') ? { opacity: Number(values.opacity) / 100 } : {}),
      ...(changed('fit') ? { fit: values.fit === 'cover' ? 'cover' : 'contain' } : {}),
      ...(changed('transition', 'transitionDuration')
        ? { transitionIn: { type: transition, durationMs: transitionMs } }
        : {}),
      ...(changed('x', 'y', 'width', 'height', 'rotation')
        ? {
          transform: {
            x: Number(values.x),
            y: Number(values.y),
            width: Number(values.width),
            height: Number(values.height),
            rotation: Number(values.rotation),
          },
        }
        : {}),
      ...(changed('motion', 'strength') ? { still: { type: motion, strength: Number(values.strength) / 100 } } : {}),
      ...(changed('content', 'position', 'size', 'color', 'stroke', 'strokeWidth', 'font', 'lineHeight') &&
      clip.text !== undefined
        ? {
          text: {
            content: values.content,
            position,
            size: Number(values.size),
            ...(values.color === '' ? {} : { color: values.color }),
            ...(values.stroke === '' ? {} : { strokeColor: values.stroke }),
            ...(values.strokeWidth === '' ? {} : { strokeWidth: Number(values.strokeWidth) }),
            ...(values.font === '' ? {} : { fontFamily: values.font }),
            ...(values.lineHeight === '' ? {} : { lineHeight: Number(values.lineHeight) }),
          },
        }
        : {}),
    }
    if (await apply([{ op: 'set_clip', clip: clip.id, patch }], latest ? revision : draft.revision)) {
      setDraft(undefined)
      setError(false)
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
      {removed && <p role="alert">{t('editor.removed')}</p>}
      <fieldset disabled={disabled} className={css.fieldset}>
        <div className={css.fields}>
          {input('start', 0)}
          {input('duration', 0.001)}
          {clip.source !== undefined && input('in', 0)}
          {clip.text === undefined && (
            <>
              {input('volume', 0)}
              {input('fadeIn', 0)}
              {input('fadeOut', 0)}
            </>
          )}
          {input('opacity', 0, 100)}
          {clip.text !== undefined ? (
            <>
              <label className={`${css.field} ${css.wide}`}>
                <span>{t('editor.subtitle')}</span>
                <textarea
                  className={css.input}
                  rows={4}
                  value={values.content}
                  onChange={(event) => {
                    change('content', event.target.value)
                  }}
                />
              </label>
              {select('position', positions)}
              {input('size', 1, undefined, '1')}
              {textInput('color')}
              {textInput('stroke')}
              {input('strokeWidth', 0, undefined, '0.1', true)}
              {textInput('font')}
              {input('lineHeight', 1, undefined, '0.01', true)}
            </>
          ) : (
            <>
              {select('fit', ['contain', 'cover'])}
              {select('transition', transitions)}
              {values.transition !== 'cut' && input('transitionDuration', 0.001)}
              {input('x')}
              {input('y')}
              {input('width', 1)}
              {input('height', 1)}
              {input('rotation')}
              {image && (
                <>
                  {select('motion', motions)}
                  {values.motion !== 'static' && input('strength', 0, 100)}
                </>
              )}
            </>
          )}
        </div>
        {error && (
          <p className={css.error} role="alert">
            {t('editor.invalid')}
          </p>
        )}
        <div className={css.actions}>
          <Button type="submit" size="sm" variant="outline" disabled={draft === undefined || removed}>
            {t('editor.apply')}
          </Button>
          {draft !== undefined && draft.revision !== revision && (
            <Button
              size="sm"
              variant="outline"
              disabled={removed}
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
            setError(false)
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
const optionLabels = {
  contain: 'editor.contain',
  cover: 'editor.cover',
  cut: 'editor.cut',
  dissolve: 'editor.dissolve',
  fade_black: 'editor.fade_black',
  top: 'editor.top',
  center: 'editor.center',
  bottom: 'editor.bottom',
  static: 'editor.static',
  zoom_in: 'editor.zoom_in',
  zoom_out: 'editor.zoom_out',
  pan_left: 'editor.pan_left',
  pan_right: 'editor.pan_right',
  pan_up: 'editor.pan_up',
  pan_down: 'editor.pan_down',
} as const

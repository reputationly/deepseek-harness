/** Model-specific creation controls; the Host resolves the same parameter names before submission. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MediaCapabilityView } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './Inspector.module.css'

const labels = {
  lyrics: 'audio.lyrics', instructions: 'audio.instructions', cot: 'audio.cot', abc: 'audio.abc', task_type: 'audio.task_type',
  is_instrumental: 'audio.is_instrumental', audio_duration: 'audio.audio_duration', bpm: 'audio.bpm', key_scale: 'audio.key_scale',
  vocal_language: 'audio.vocal_language', seed: 'audio.seed', audio_cover_strength: 'audio.audio_cover_strength',
  repainting_start: 'audio.repainting_start', repainting_end: 'audio.repainting_end', repaint_mode: 'audio.repaint_mode',
  repaint_strength: 'audio.repaint_strength', guidance_scale: 'audio.guidance_scale', inference_steps: 'audio.inference_steps',
  thinking: 'audio.thinking', max_new_tokens: 'audio.max_new_tokens',
} as const
type Key = keyof typeof labels
type Value = string | number | boolean
interface Field { readonly id: Key; readonly type: 'text' | 'number' | 'area' | 'boolean' | 'select'; readonly options?: readonly string[] }

/** Parameters are retained as scalar node fields, including intermediate empty number inputs. */
export interface AudioFieldsProps {
  readonly model: MediaCapabilityView
  readonly params: Readonly<Record<string, Value>>
  readonly change: (key: string, value: Value) => void
  readonly score?: string
  readonly t: PropsLocale<typeof NS>['t']
}

function fields(model: MediaCapabilityView, params: AudioFieldsProps['params']): readonly Field[] {
  if (model.operation === 'generate_speech') return /breeze-tts-2/iu.test(model.model)
    ? [{ id: 'instructions', type: 'area' }, { id: 'seed', type: 'number' }]
    : model.params.some(param => param.id === 'seed') ? [{ id: 'seed', type: 'number' }] : []
  if (/yue[-_]?2/iu.test(model.model)) return [
    { id: 'lyrics', type: 'area' }, { id: 'cot', type: 'select', options: ['full', 'melody', 'off'] }, { id: 'abc', type: 'area' }, { id: 'seed', type: 'number' },
  ]
  if (/ace[-_]?step/iu.test(model.model)) {
    const modes = ['t2m', 'cover', 'repaint'].filter(mode => (model.taskTypes ?? ['t2m']).includes(mode))
    const mode = params.task_type ?? 't2m'
    return [
      { id: 'task_type', type: 'select', options: modes }, { id: 'is_instrumental', type: 'boolean' }, { id: 'lyrics', type: 'area' },
      { id: 'audio_duration', type: 'number' }, { id: 'bpm', type: 'number' }, { id: 'key_scale', type: 'text' }, { id: 'vocal_language', type: 'text' },
      ...mode === 'cover' ? [{ id: 'audio_cover_strength', type: 'number' } as const] : [],
      ...mode === 'repaint' ? [
        { id: 'repainting_start', type: 'number' } as const, { id: 'repainting_end', type: 'number' } as const,
        { id: 'repaint_mode', type: 'select', options: ['balanced', 'conservative', 'aggressive'] } as const,
        { id: 'repaint_strength', type: 'number' } as const,
      ] : [],
      { id: 'seed', type: 'number' }, { id: 'thinking', type: 'boolean' },
    ]
  }
  return [{ id: 'lyrics', type: 'area' }, .../minimax-music3/iu.test(model.model) ? [{ id: 'max_new_tokens', type: 'number' } as const] : [], { id: 'seed', type: 'number' }]
}

/**
 * Render parameters for an offered model, retaining unavailable saved choices for review.
 * @param props - offered model, draft parameters, changes, score, and locale.
 * @returns the controls for the model's declared creation modes.
 */
export function AudioFields({ model, params, change, score, t }: AudioFieldsProps) {
  const yue = /yue[-_]?2/iu.test(model.model)
  const breeze = /breeze-tts-2/iu.test(model.model)
  const optionLabels = { full: 'audio.cot.full', melody: 'audio.cot.melody', off: 'audio.cot.off', t2m: 'audio.t2m', cover: 'audio.cover', repaint: 'audio.repaint',
    conservative: 'audio.conservative', balanced: 'audio.balanced', aggressive: 'audio.aggressive' } as const
  const optionLabel = (option: string): string => option in optionLabels ? t(optionLabels[option as keyof typeof optionLabels]) : option
  return <>
    {yue && <p className={css.empty}>{t('audio.yueHint')}</p>}
    {breeze && <p className={css.empty}>{t('audio.breezeHint')}</p>}
    {fields(model, params).map((field) => {
      const duration = field.id === 'max_new_tokens' && /minimax-music3/iu.test(model.model)
      const raw = params[field.id] ?? (field.id === 'cot' ? 'full' : field.id === 'task_type' ? 't2m' : field.id === 'is_instrumental' ? params.instrumental : undefined)
      // Music3's documented audio rate is 25 tokens per second.
      const value = duration && typeof raw === 'number' ? raw / 25 : raw
      return <label key={field.id} className={css.field}>
        <span className={css.label}>{t(duration ? 'audio.music3Duration' : labels[field.id])}</span>
        {field.type === 'area' ? <textarea className={css.textarea} rows={field.id === 'abc' ? 8 : 4} value={String(value ?? '')}
          onChange={(event) => { change(field.id, event.target.value) }} />
          : field.type === 'boolean' ? <input type="checkbox" checked={value === true || value === 'true'} onChange={(event) => { change(field.id, event.target.checked) }} />
            : field.type === 'select' ? <select className={css.input} value={String(value ?? '')} onChange={(event) => { change(field.id, event.target.value) }}>
              {!field.options?.includes(String(value ?? '')) && <option value={String(value ?? '')} disabled>{t('audio.unavailableOption', { value: optionLabel(String(value ?? '')) })}</option>}
              {field.options?.map(option => <option key={option} value={option}>{optionLabel(option)}</option>)}
            </select> : <input className={css.input} type={field.type} value={String(value ?? '')} placeholder={t('audio.automatic')}
              {...field.type === 'number' ? { step: 'any', min: 0 } : {}}
              onChange={(event) => {
                const next = event.target.value
                change(field.id, field.type === 'number' && next !== '' ? duration ? Math.round(Number(next) * 25) : Number(next) : next)
              }} />}
      </label>
    })}
    {yue && score !== undefined && <Button size="sm" onClick={() => { change('abc', score) }}>{t('audio.useScore')}</Button>}
  </>
}

/** Inline card for one generate_image call: progress, the generated images, and follow-up actions. */
import { useCallback, useState } from 'react'
import {
  Button, IconCheckOutlineRegular, IconCopyOutlineRegular, IconDownloadOutlineRegular, IconRefreshOutlineRegular,
  TextShimmer, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderFactories, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { imageResultOf, type ImageResult } from './image-result.ts'
import css from './GenerateImageCard.module.css'


/** Props the keyed toolview entry receives. */
/** Images handed to the creative workbench's gallery. */
export interface CreativeImages {
  prompt: string
  model: string
  images: Array<{ b64: string; mime: string }>
}

/** @returns false when the creative workbench is not loaded or is switched off. */
export type OpenInCreative = (input: CreativeImages) => boolean

export type GenerateImageCardProps = ToolCallViewProps & PropsRenderFactories & {
  t: TranslateNS<'gatewayStatus'>
  openInCreative: OpenInCreative
}

/**
 * Render the call while it runs, its images once it settles, or its text when it failed.
 * @param props - toolview owner props, the Factory renderer, and this plugin's copy.
 * @returns the card.
 */
export function GenerateImageCard(props: GenerateImageCardProps) {
  const { t } = props
  if (props.phase !== 'result') {
    return <div className={css.card}><TextShimmer active><span className={css.title}>{t('image.generating')}</span></TextShimmer></div>
  }
  const { block } = props
  const result = block.isError ? null : imageResultOf(block.meta)
  if (result === null) {
    const text = block.content.flatMap(item => item.type === 'text' ? [item.text] : []).join('\n')
    return <div className={css.card}>
      {block.isError && <p className={css.title}>{t('image.failed')}</p>}
      {text !== '' && <p className={css.detail}>{text}</p>}
    </div>
  }
  if (result.status === 'cancelled') return <div className={css.card}><p className={css.title}>{t('image.cancelled')}</p></div>
  return <GeneratedImages result={result} props={props} />
}

/**
 * The settled card body; separate so its hooks run only for a generated result.
 * @param root - the generated result and the card props.
 * @returns the images with their actions.
 */
function GeneratedImages({ result, props }: { result: ImageResult; props: GenerateImageCardProps }) {
  const { t, loadImage, inputActions, renderFactorySlot, openInCreative: open } = props
  const copy = useClipboardCopy(result.prompt)
  const stored = result.images.flatMap(image => (
    image.attachment === undefined ? [] : [{ attachment: image.attachment, label: baseName(image.path) }]
  ))
  const download = useCallback(() => {
    void (async () => {
      for (const image of stored) {
        const link = document.createElement('a')
        link.href = await loadImage(image.attachment)
        link.download = image.label
        link.click()
      }
    })()
  }, [stored, loadImage])
  const [creativeMissing, setCreativeMissing] = useState(false)
  const openInCreative = useCallback(() => {
    void (async () => {
      const images = await Promise.all(stored.map(async image => await dataOf(await loadImage(image.attachment))))
      setCreativeMissing(!open({ prompt: result.prompt, model: result.modelLabel, images }))
    })()
  }, [stored, loadImage, open, result.prompt, result.modelLabel])
  const facts = [result.modelLabel, ...result.parameters.map(item => item.value)].join(' · ')
  const regenerate = useCallback(() => {
    inputActions.setDraft(t('image.regenerate-request', { prompt: result.prompt, settings: facts }))
    inputActions.submit()
  }, [inputActions, t, result.prompt, facts])
  return <div className={css.card}>
    <p className={css.title}>{t('image.generated', { count: result.images.length })}</p>
    <p className={css.detail}>{facts}</p>
    {result.review !== undefined && (
      <p className={css.detail} data-verdict={result.review.verdict}>{t(`review.${result.review.verdict}`, { reason: result.review.reason })}</p>
    )}
    {stored.length > 0
      ? renderFactorySlot('conversation.images.content', { images: stored, loadImage, align: 'start' })
      : <ul className={css.paths}>{result.images.map(image => <li key={image.path} className={css.detail}>{image.path}</li>)}</ul>}
    <div className={css.actions}>
      {stored.length > 0 && <Button size="sm" icon={<IconDownloadOutlineRegular />} onClick={download}>{t('image.download')}</Button>}
      <Button size="sm" icon={copy.copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />} onClick={copy.onCopy}>
        {copy.copied ? t('image.copied') : t('image.copy-prompt')}
      </Button>
      <Button size="sm" icon={<IconRefreshOutlineRegular />} onClick={regenerate}>{t('image.regenerate')}</Button>
      {stored.length > 0 && <Button size="sm" onClick={openInCreative}>{t('image.open-in-creative')}</Button>}
    </div>
    {creativeMissing && <p className={css.detail} role="status">{t('image.creative-unavailable')}</p>}
  </div>
}

/**
 * Base64 payload of a loaded image URL.
 * @param url - data or object URL the image loader returned.
 * @returns the payload and its media type.
 */
async function dataOf(url: string): Promise<{ b64: string; mime: string }> {
  const blob = await (await fetch(url)).blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return { b64: btoa(binary), mime: blob.type === '' ? 'image/png' : blob.type }
}

/**
 * @param path - saved file path.
 * @returns its last segment.
 */
function baseName(path: string): string {
  return path.split(/[\\/]/u).pop() ?? path
}

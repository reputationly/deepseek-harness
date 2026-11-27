// @vitest-environment jsdom
/** Media Blob ownership, player kinds, media types, and failure states. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MediaBody, mediaTypeOf, type MediaBodyProps } from '../src/client/media/MediaBody.tsx'
import { en } from '../src/client/media/locales.ts'

let createDescriptor: PropertyDescriptor | undefined
let revokeDescriptor: PropertyDescriptor | undefined
const create = vi.fn<(blob: Blob) => string>()
const revoke = vi.fn<(url: string) => void>()

beforeEach(() => {
  createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
  revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
  create.mockReset().mockImplementation(() => `blob:https://preview.invalid/${create.mock.calls.length}`)
  revoke.mockReset()
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
})

afterEach(() => {
  try { cleanup() } finally {
    if (createDescriptor === undefined) Reflect.deleteProperty(URL, 'createObjectURL')
    else Object.defineProperty(URL, 'createObjectURL', createDescriptor)
    if (revokeDescriptor === undefined) Reflect.deleteProperty(URL, 'revokeObjectURL')
    else Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor)
    vi.restoreAllMocks()
  }
})

function props(path = 'asset.mp3', data: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])): MediaBodyProps {
  return {
    resourceAddress: `dsh-resource://file/session/media/${path}`,
    content: { kind: 'bytes', data },
    wrap: false,
    t: (key, params) => {
      const value = (en as Record<string, string>)[key] ?? key
      return params === undefined ? value : Object.entries(params)
        .reduce((text, [name, replacement]) => text.replace(`{${name}}`, String(replacement)), value)
    },
  } as MediaBodyProps
}

describe('MediaBody', () => {
  it.each([
    ['mp3', 'audio', 'audio/mpeg'],
    ['wav', 'audio', 'audio/wav'],
    ['m4a', 'audio', 'audio/mp4'],
    ['mp4', 'video', 'video/mp4'],
    ['webm', 'video', 'video/webm'],
  ] as const)('renders .%s as %s with the %s Blob media type', async (extension, tag, mediaType) => {
    const view = render(<MediaBody {...props(`asset.${extension}`)} />)
    const player = await screen.findByLabelText(`Media preview: asset.${extension}`)
    expect(player.tagName.toLowerCase()).toBe(tag)
    expect(player.getAttribute('controls')).not.toBeNull()
    expect(player.getAttribute('src')).toBe('blob:https://preview.invalid/1')
    expect(create.mock.calls[0]?.[0].type).toBe(mediaType)
    view.unmount()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:https://preview.invalid/1')
  })

  it('reports decode failure and revokes replaced bytes', async () => {
    const view = render(<MediaBody {...props()} />)
    const player = await screen.findByLabelText('Media preview: asset.mp3')
    fireEvent.error(player)
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
    view.rerender(<MediaBody {...props('asset.mp3', new Uint8Array([4, 5, 6]))} />)
    await screen.findByLabelText('Media preview: asset.mp3')
    expect(revoke).toHaveBeenCalledWith('blob:https://preview.invalid/1')
  })

  it('rejects text delivery and an unregistered suffix without creating a Blob', () => {
    const view = render(<MediaBody {...props()} content={{ kind: 'text', text: 'plain', pages: [], eof: true }} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    view.rerender(<MediaBody {...props('asset.unknown')} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(create).not.toHaveBeenCalled()
  })

  it('matches media types case-insensitively on decoded path suffixes', () => {
    expect(mediaTypeOf('dir/SONG.MP3')).toEqual(['audio', 'audio/mpeg'])
    expect(mediaTypeOf('C:\\work\\CLIP.WEBM')).toEqual(['video', 'video/webm'])
    expect(mediaTypeOf('file.unknown')).toBeUndefined()
    expect(mediaTypeOf('mp3')).toBeUndefined()
  })
})

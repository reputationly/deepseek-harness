// @vitest-environment jsdom
/** Media route ownership, player kinds, versioned URLs, and failure states. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MediaBody, mediaTypeOf, type MediaBodyInjected, type MediaBodyProps } from '../src/client/media/MediaBody.tsx'
import { en } from '../src/client/media/locales.ts'

afterEach(() => { cleanup() })

const statResult = (path: string, version = 'v1') => ({
  ok: true as const,
  value: { absolutePath: path, version, bytes: 3 },
})

function props(path = 'asset.mp3', revision = 1) {
  const loaded = vi.fn<(version: string) => void>()
  const failed = vi.fn<() => void>()
  const statFile = vi.fn<MediaBodyInjected['statFile']>(() => Promise.resolve(statResult(`/host/media/${path}`)))
  const value: MediaBodyProps = {
    resourceAddress: `dsh-resource://file/session/media/${path}`,
    content: { kind: 'renderer', revision, loaded, failed, reload: vi.fn() },
    wrap: false,
    statFile,
    t: (key, params) => {
      const text = (en as Record<string, string>)[key] ?? key
      return params === undefined ? text : Object.entries(params)
        .reduce((result, [name, replacement]) => result.replace(`{${name}}`, String(replacement)), text)
    },
  } as MediaBodyProps
  return { props: value, loaded, failed, statFile }
}


describe('MediaBody', () => {
  it.each([
    ['mp3', 'audio'],
    ['wav', 'audio'],
    ['m4a', 'audio'],
    ['mp4', 'video'],
    ['webm', 'video'],
  ] as const)('renders .%s through the versioned file route as %s', async (extension, tag) => {
    const fixture = props(`asset.${extension}`)
    render(<MediaBody {...fixture.props} />)
    const player = await screen.findByLabelText(`Media preview: asset.${extension}`)
    expect(player.tagName.toLowerCase()).toBe(tag)
    expect(player.getAttribute('controls')).not.toBeNull()
    const url = new URL(player.getAttribute('src') ?? '')
    expect(url.pathname).toBe('/api/file')
    expect(url.searchParams.get('path')).toBe(`/host/media/asset.${extension}`)
    expect(url.searchParams.get('v')).toBe('v1')
    expect(fixture.loaded).toHaveBeenCalledExactlyOnceWith('v1')
  })

  it('reports playback failure without revoking anything', async () => {
    render(<MediaBody {...props().props} />)
    const player = await screen.findByLabelText('Media preview: asset.mp3')
    fireEvent.error(player)
    expect(screen.getByRole('alert').textContent).toBe(en.failed)
  })

  it('reports metadata failure through the renderer request', async () => {
    const fixture = props()
    fixture.statFile.mockResolvedValue({ ok: false, error: { code: 'workspace-file/not-found', message: 'missing', details: {} } } as never)
    render(<MediaBody {...fixture.props} />)
    expect((await screen.findByRole('alert')).textContent).toBe(en.failed)
    expect(fixture.failed).toHaveBeenCalledOnce()
    expect(fixture.loaded).not.toHaveBeenCalled()
  })

  it('loads a replacement revision with its own versioned URL', async () => {
    const fixture = props('asset.mp4')
    const view = render(<MediaBody {...fixture.props} />)
    await screen.findByLabelText('Media preview: asset.mp4')
    fixture.statFile.mockResolvedValue(statResult('/host/media/asset.mp4', 'v2'))
    view.rerender(<MediaBody {...props('asset.mp4', 2).props} statFile={fixture.statFile} />)
    const player = await screen.findByLabelText('Media preview: asset.mp4')
    expect(new URL(player.getAttribute('src') ?? '').searchParams.get('v')).toBe('v2')
    expect(fixture.statFile).toHaveBeenCalledTimes(2)
    expect(fixture.statFile.mock.calls[0]?.[0].path).toBe('asset.mp4')
  })

  it('rejects byte delivery and an unregistered suffix without reading metadata', () => {
    const fixture = props()
    const byteProps = { ...fixture.props, content: { kind: 'bytes', data: new Uint8Array([1]) } as never }
    const view = render(<MediaBody {...byteProps} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    view.rerender(<MediaBody {...props('asset.unknown').props} />)
    expect(screen.getByRole('alert').textContent).toBe(en.unsupported)
    expect(fixture.statFile).not.toHaveBeenCalled()
  })

  it('matches media types case-insensitively on decoded path suffixes', () => {
    expect(mediaTypeOf('dir/SONG.MP3')).toEqual(['audio', 'audio/mpeg'])
    expect(mediaTypeOf('C:\\work\\CLIP.WEBM')).toEqual(['video', 'video/webm'])
    expect(mediaTypeOf('file.unknown')).toBeUndefined()
    expect(mediaTypeOf('mp3')).toBeUndefined()
  })
})

/** Cross-platform input classification, plus actual local and file-URL voice uploads. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { localMediaPath, mediaProtocol, voiceReference } from '../src/local-path.ts'

it.each(['C:\\音频 项目\\voice.MP3', 'D:/audio/voice.wav', 'C:relative.wav', '\\\\server\\share\\voice.wav', '/audio/voice.wav', './audio/voice.wav'])(
  'does not mistake a filesystem path for a URI: %s', (source) => { expect(mediaProtocol(source)).toBeUndefined() },
)

it('uploads a local sample and its percent-encoded file URL as identical audio data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-voice-'))
  try {
    const path = join(directory, '音色 sample.MP3')
    await writeFile(path, Buffer.from('voice bytes'))
    const url = pathToFileURL(path).href
    expect(localMediaPath(url)).toBe(path)
    expect(await voiceReference(path)).toBe(`data:audio/mpeg;base64,${Buffer.from('voice bytes').toString('base64')}`)
    expect(await voiceReference(url)).toBe(await voiceReference(path))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.each(['https://example.com/voice.wav', 'HTTP://example.com/voice.wav', 'data:audio/wav;base64,AA=='])(
  'keeps a fetchable voice reference unchanged: %s', async (source) => { expect(await voiceReference(source)).toBe(source) },
)

it('rejects network protocols at a local input boundary', async () => {
  expect(() => localMediaPath('https://example.com/video.mp4')).toThrow('Only local input files are allowed')
  await expect(voiceReference('ftp://example.com/voice.wav')).rejects.toThrow('Only local input files are allowed')
})

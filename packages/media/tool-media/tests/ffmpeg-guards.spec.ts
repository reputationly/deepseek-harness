import { describe, expect, it } from 'vitest'
import {
  checkFfmpegAudioPreserve,
  checkFfmpegCommand,
  checkFfmpegDrawtext,
  escapeFfmpegFilterValue,
  extractOptionValues,
  injectCjkFont,
  isDryRun,
  isPureAudioReplacementMux,
} from '../src/ffmpeg-guards.ts'

describe('FFmpeg command guards', () => {
  it('rejects caller-controlled outputs, filter files, malformed options, and extra outputs', () => {
    expect(checkFfmpegCommand(['-i', 'a.mp4', '-y'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'a.mp4', '-n'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'a.mp4', '-y=1'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'a.mp4', '-n=1'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'a.mp4', '-unexpected', 'output.mp4'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-filter_complex_script', 'filters.txt'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-filter_complex=scale=20:20'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-filter_complex'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'a.mp4', '-crf'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'a.mp4', 'output.mp4'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand([])).toMatchObject({ ok: false, error: 'At least one local input or lavfi source is required.' })
    expect(checkFfmpegCommand(['-f', '-i', 'input.mp4'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'input.mp4', '-filter_script=filters.txt'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'https://example.test/video.mp4'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'pipe:0'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'concat:one|two'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', 'data:video/mp4;base64,AA'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', '/dev/video0'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-i', '-'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-f', 'unknown', '-i', 'input'])).toMatchObject({ ok: false })
    expect(checkFfmpegCommand(['-f', 'lavfi'])).toMatchObject({ ok: false })
  })

  it('allows local and lavfi inputs, null dry runs, and audio-only concat', () => {
    expect(checkFfmpegCommand(['-i', 'relative.mp4', '-an'])).toEqual({ ok: true })
    expect(checkFfmpegCommand(['-f', 'lavfi', '-i', 'color=c=black:s=320x240:d=1'])).toEqual({ ok: true })
    expect(checkFfmpegCommand(['-i', 'input.mp4', '-f', 'null'])).toEqual({ ok: true })
    expect(checkFfmpegCommand(['-f=lavfi', '-i=color=c=black:s=320x240:d=1'])).toEqual({ ok: true })
    expect(checkFfmpegCommand(['-i=input.mp4', '-f=null'])).toEqual({ ok: true })
    expect(isDryRun(['-i=input.mp4', '-f=null'])).toBe(true)
    expect(isDryRun(['-i', 'input.mp4', '-f', 'null'])).toBe(true)
    expect(isDryRun(['-i', 'input.mp4'])).toBe(false)
    expect(checkFfmpegCommand(['-i', 'a.mp4', '-i', 'b.mp4', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]'])).toEqual({ ok: true })
    expect(checkFfmpegCommand(['-i', 'a.mp4', '-i', 'b.mp4', '-filter_complex', '[0:v][1:v]concat=n=2[v]'])).toMatchObject({ ok: false })
  })

  it('rejects audio resampling when a command promises to preserve source audio', () => {
    const args = [
      '-i', 'a.mp4', '-i', 'b.mp4',
      '-filter_complex', '[0:a]aresample=48000[a0];[1:a]aformat=sample_rates=48000[a1];[a0][a1]concat=n=2:v=0:a=1[aout]',
      '-map', '[aout]',
    ]
    expect(checkFfmpegAudioPreserve(args, { description: 'preserve clip audio' })).toMatchObject({ ok: false })
    expect(checkFfmpegAudioPreserve(args, { description: '保留片段原始音频' })).toMatchObject({ ok: false })
    expect(checkFfmpegAudioPreserve(args, { prompt: '原样保留音频' })).toMatchObject({ ok: false })
    expect(checkFfmpegAudioPreserve(args, { description: 'mix a new soundtrack' })).toEqual({ ok: true })
    expect(checkFfmpegAudioPreserve(args)).toEqual({ ok: true })
    expect(checkFfmpegAudioPreserve([
      '-i', 'a.mp4', '-i', 'b.mp4', '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]',
    ], { description: 'preserve clip audio' }, 'audio')).toEqual({ ok: true })
    expect(checkFfmpegAudioPreserve([...args.slice(0, -2), '-map', '0:a'], { description: 'preserve clip audio' })).toEqual({ ok: true })
    expect(checkFfmpegAudioPreserve(['-i', 'a.mp4'], { description: 'copy audio' })).toEqual({ ok: true })
    expect(checkFfmpegAudioPreserve(['-i', 'a.mp4', '-f', 'null'], { description: 'preserve clip audio' })).toEqual({ ok: true })
    const intentional = [...args, '-af', 'volume=0.5']
    expect(checkFfmpegAudioPreserve(intentional, { description: 'preserve clip audio' })).toEqual({ ok: true })
    expect(checkFfmpegAudioPreserve(['-i', 'a.mp4', '-y'], { description: 'preserve clip audio' })).toMatchObject({ ok: false })
  })

  it('recognizes pure audio replacement muxes only for video outputs', () => {
    expect(isPureAudioReplacementMux(['-i', 'v.mp4', '-i', 'music.mp3', '-c:v', 'copy'], 'video')).toBe(true)
    expect(isPureAudioReplacementMux(['-i', 'v.mp4', '-i', 'a.mp4', '-map', '0:v', '-map', '1:a', '-vcodec', 'copy'], 'video')).toBe(true)
    expect(isPureAudioReplacementMux(['-i', 'v.mp4', '-i', 'a.mp4', '-map', '1:a', '-codec:v', 'copy'], 'video')).toBe(false)
    expect(isPureAudioReplacementMux(['-i', 'v.mp4', '-i', 'music.mp3', '-c:v', 'libx264'], 'video')).toBe(false)
    expect(isPureAudioReplacementMux(['-i', 'v.mp4', '-i', 'music.mp3', '-c:v', 'copy'], 'audio')).toBe(false)
    expect(isPureAudioReplacementMux(['-i', 'v.mp4', '-c:v', 'copy'], 'video')).toBe(false)
  })
})

describe('drawtext guards', () => {
  it('extracts quoted, escaped, unquoted, and repeated option values', () => {
    expect(extractOptionValues('drawtext=text=\'a\\:b\',drawtext=text=plain\\,text', 'text')).toEqual(['a\\:b', 'plain\\,text'])
    expect(extractOptionValues('text="two words":text=last', 'text')).toEqual(['two words', 'last'])
    expect(extractOptionValues('sometext=ignored;drawtext=text=plain:x=1', 'text')).toEqual(['plain'])
    expect(extractOptionValues('drawtext=font=/path.ttf', 'text')).toEqual([])
  })

  it('escapes filter values and injects a configured font into CJK drawtext only', () => {
    expect(escapeFfmpegFilterValue("C:\\fonts\\O'Neil.ttf")).toBe("C\\:\\\\fonts\\\\O\\'Neil.ttf")
    expect(injectCjkFont(['-i', 'a.mp4', '-vf', "drawtext=text='你好':x=1,drawtext=text='hello':x=2"], '/fonts/CJK:font.ttf', () => true))
      .toEqual({ ok: true, args: ['-i', 'a.mp4', '-vf', "drawtext=fontfile='/fonts/CJK\\:font.ttf':text='你好':x=1,drawtext=text='hello':x=2"] })
    expect(injectCjkFont(['-vf', "drawtext=text='你好':font='Heiti'"], '/font.ttf', () => true))
      .toEqual({ ok: true, args: ['-vf', "drawtext=text='你好':font='Heiti'"] })
    expect(injectCjkFont(['-vf', "drawtext=text='你\\,好':x=1"], '/font.ttf', () => true))
      .toMatchObject({ ok: true, args: ['-vf', expect.stringContaining("fontfile='/font.ttf'")] })
    expect(injectCjkFont(['-vf', 'drawtext=text=hello'], undefined)).toEqual({ ok: true, args: ['-vf', 'drawtext=text=hello'] })
    expect(injectCjkFont(['-vf', "drawtext=text='你好'"], undefined)).toMatchObject({ ok: false })
    expect(injectCjkFont(['-vf', "drawtext=text='你好'"], '/missing.ttf', () => false)).toMatchObject({ ok: false })
    expect(injectCjkFont(['-vf', "drawtext=text='你好'"], '/font.ttf', () => true)).toMatchObject({ ok: true })
    expect(injectCjkFont(['-vf', "drawtext=text='😀'"], '/font.ttf', () => true)).toMatchObject({ ok: true })
  })

  it('rejects literal newlines and missing explicit font files', () => {
    expect(checkFfmpegDrawtext(['-vf', "drawtext=text='a\\nb'"])).toMatchObject({ ok: false })
    expect(checkFfmpegDrawtext(['-vf', 'drawtext=fontfile=/nope.ttf:text=x'], () => false)).toMatchObject({ ok: false })
    expect(checkFfmpegDrawtext(['-vf', 'drawtext=fontfile=/ok.ttf:text=x'], path => path === '/ok.ttf')).toEqual({ ok: true })
    expect(checkFfmpegDrawtext(['-vf', "drawtext=fontfile='':text=x"])).toEqual({ ok: true })
    expect(checkFfmpegDrawtext(['-vf', 'scale=20:20'])).toEqual({ ok: true })
  })
})

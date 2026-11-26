import { describe, expect, it } from 'vitest'
import { ASPECT, RESOLUTION, check, normalizeAspect, normalizeResolution } from '../src/params.ts'

describe('parameter wording', () => {
  it('renames what users say without changing the value', () => {
    expect(normalizeAspect('竖屏')).toBe('9:16')
    expect(normalizeAspect('横屏')).toBe('16:9')
    expect(normalizeAspect('方图')).toBe('1:1')
    expect(normalizeAspect('16：9')).toBe('16:9')
    expect(normalizeResolution('超清4K')).toBe('4K')
    expect(normalizeResolution('4k')).toBe('4K')
  })

  it('keeps a value outside the catalog set unsupported instead of lowering it', () => {
    const spec = { key: 'resolution', label: '分辨率', options: ['1K', '2K'], default: '2K' }
    expect(check(spec, RESOLUTION, '2k')).toEqual({ kind: 'ok', value: '2K' })
    expect(check(spec, RESOLUTION, '超清4K')).toEqual({ kind: 'unsupported', requested: '超清4K' })
    expect(check(spec, RESOLUTION, undefined)).toEqual({ kind: 'missing' })
    expect(check({ ...spec, key: 'aspect_ratio', options: ['adaptive', '9:16'] }, ASPECT, '竖屏')).toEqual({ kind: 'ok', value: '9:16' })
  })
})

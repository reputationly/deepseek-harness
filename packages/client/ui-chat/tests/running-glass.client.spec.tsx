// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { RunningGlass } from '../src/client/chat/RunningGlass.tsx'

afterEach(cleanup)

describe('RunningGlass', () => {
  it('renders one decorative vector lens with no inline animation', () => {
    const view = render(<RunningGlass />)
    const icon = view.container.firstElementChild!
    expect(icon.tagName).toBe('SPAN')
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    const svg = icon.querySelector('svg')!
    expect(icon.lastElementChild).toBe(svg)
    expect(svg.getAttribute('viewBox')).toBe('0 0 16 16')
    expect(svg.querySelectorAll('circle')).toHaveLength(1)
    expect(svg.querySelectorAll('path')).toHaveLength(1)
    expect(svg.querySelector('circle')?.getAttribute('stroke')).toBe('currentColor')
    expect(view.container.querySelector('animate')).toBeNull()
    expect(view.container.querySelector('[style]')).toBeNull()
  })

  it('animates through the stylesheet and stops for reduced motion', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/client/chat/ChatView.module.css'), 'utf8')
    expect(css).toContain('animation: dsh-running-glass')
    expect(css).toContain('@keyframes dsh-running-glass')
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.runningGlass\s*\{\s*animation: none;/u)
  })
})

/** Magnifier that sweeps while a Turn runs, drawn as vectors so it stays crisp at any DPI. */
import css from './ChatView.module.css'

/**
 * Render the decorative running icon.
 * @returns the lens and handle; the stylesheet owns the sweep and its reduced-motion form.
 */
export function RunningGlass() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg className={css.runningGlass} viewBox="0 0 16 16" fill="none">
        <circle cx="6.6" cy="6.6" r="4.3" stroke="currentColor" strokeWidth="1.5" />
        <path d="M9.9 9.9L13.4 13.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </span>
  )
}

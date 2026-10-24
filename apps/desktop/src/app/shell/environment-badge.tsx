import { useStore } from '@nanostores/react'

import { $productEnv } from '@/store/product-env'

/**
 * The environment tag that sits beside the sidebar wordmark: DEV, TEST — and
 * nothing at all on the shipping (prod) artifact.
 *
 * The wordmark reads "Plankton" in all three artifacts, so on its own a
 * screenshot, a screen share, or two windows side by side cannot be attributed
 * to one of them. This is the cheap, always-visible answer, in the pane that is
 * open in both interface modes (Simple hides the right-hand chrome; this word
 * is in the list column).
 *
 * Hues match the badged app icon (`scripts/plankton-env-icons.py`), so the Dock
 * icon, ⌘-Tab and this tag read as one marker rather than three colour schemes.
 *
 * The label is the environment token itself, untranslated: like the product name
 * it is an identifier, and ten locale files would otherwise carry the same
 * ASCII. An environment this build does not know (a future one, a stale bridge
 * value) renders NOTHING rather than a guessed label.
 */
const TONES: Record<string, string> = {
  dev: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  test: 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
}

export function EnvironmentBadge(): React.ReactElement | null {
  const env = useStore($productEnv)
  const tone = env ? TONES[env] : undefined

  if (!env || !tone) {
    return null
  }

  return (
    <span
      className={`shrink-0 rounded px-1 py-px text-2xs font-semibold tracking-wide ${tone}`}
      data-env={env}
      data-slot="environment-badge"
      title={`${env} 环境 · 数据在 ~/.plankton/${env}`}
    >
      {env.toUpperCase()}
    </span>
  )
}

import type { StatusTone } from '@/components/status-dot'

// One reading of a messaging platform's runtime state, shared by the Messaging
// page and the gateway menu so the same bot never shows two different tones.
// Anything enabled that isn't connected or failed (connecting, retrying,
// restart needed, gateway stopped, needs setup) is waiting on something: warn.
const STATE_TONE: Record<string, StatusTone> = {
  connected: 'good',
  disabled: 'muted',
  fatal: 'bad',
  startup_failed: 'bad'
}

interface PlatformStatusInput {
  enabled?: boolean
  state?: null | string
}

export function platformStatusTone({ enabled = true, state }: PlatformStatusInput): StatusTone {
  if (!enabled) {
    return 'muted'
  }

  return (state && STATE_TONE[state]) || 'warn'
}

/** Tone → pill classes. Shared so a platform's tone reads the same on the
 *  list row's pending badge and on the detail's state pills. */
export const TONE_PILL_CLASS: Record<StatusTone, string> = {
  good: 'bg-primary/10 text-primary',
  muted: 'bg-muted text-muted-foreground',
  warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-300',
  bad: 'bg-destructive/10 text-destructive'
}

import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import type { FC } from 'react'

import { useI18n } from '@/i18n'
import { fmtFullDateTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { $displayTimestamps } from '@/store/display-timestamps'

import { formatMessageTimestamp } from './timestamp'

/** When the message landed, in seconds: a reply counts from its completion.
 *  `createdAt` already carries the row's own timestamp (see
 *  `messageCreatedAt`), falling back to now only for a just-sent message. */
const useMessageTime = (): number | undefined =>
  useAuiState(s => {
    const completedAt = (s.message.metadata?.custom as { timelineCompletedAt?: unknown } | undefined)
      ?.timelineCompletedAt

    const at = typeof completedAt === 'number' ? completedAt : (s.message.createdAt?.getTime() ?? NaN) / 1000

    return Number.isFinite(at) && at > 0 ? at : undefined
  })

const clockOnly = (time: string) => time

/**
 * The time a message landed, revealed with the message's hover actions
 * ("3:27 PM"; "Yesterday, 3:27 PM"; "Sep 28, 3:27 PM"); the tip carries the
 * full date/time. Visibility belongs to the host's hover group: this paints
 * the label only. Stands down while `display.timestamps` is on, because the
 * transcript already prints every stamp.
 *
 * No age anywhere — not in the tip, not in the standing line. 「1 min. ago」
 * says nothing the date does not, and once `plain` turned this into text under
 * every user turn it read as noise on each row. Ask what landed WHEN and the
 * absolute stamp is the whole answer.
 *
 * `plain` drops the tip and prints the full date/time as standing text under
 * the message instead of a hover reveal.
 */
export const MessageHoverTime: FC<{ className?: string; plain?: boolean }> = ({ className, plain }) => {
  const { t } = useI18n()
  const timelineStamps = useStore($displayTimestamps)
  const seconds = useMessageTime()

  if (timelineStamps || seconds === undefined) {
    return null
  }

  const date = new Date(seconds * 1000)

  const stamp = (
    <time
      className={cn(
        'pointer-events-auto cursor-default select-none whitespace-nowrap text-2xs leading-5 tabular-nums text-(--ui-text-tertiary)',
        className
      )}
      dateTime={date.toISOString()}
    >
      {plain ? (
        fmtFullDateTime.format(date)
      ) : (
        formatMessageTimestamp(date, { today: clockOnly, yesterday: t.assistant.thread.yesterday })
      )}
    </time>
  )

  // No hover tip on the stamp either: the row is standing chrome now, and a
  // bubble that repeats the same instant in a longer format is one more thing
  // appearing under the pointer. `plain` still prints the FULL date inline when
  // a caller wants that.
  return stamp
}

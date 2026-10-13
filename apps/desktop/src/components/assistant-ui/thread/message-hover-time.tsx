import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import type { FC } from 'react'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { DAY, fmtFullDateTime, relativeTime } from '@/lib/time'
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

/** Rendered only while the tip is open, so "5 min ago" is as of the hover.
 *  The age is only worth saying within the day; past that the label already
 *  names the day, and an hour-rounded "2 days ago" would contradict a
 *  calendar "Yesterday". */
const HoverTimeDetail: FC<{ ms: number }> = ({ ms }) => {
  const full = fmtFullDateTime.format(new Date(ms))

  return <span className="tabular-nums">{Date.now() - ms < DAY ? `${relativeTime(ms)} · ${full}` : full}</span>
}

const clockOnly = (time: string) => time

/**
 * The time a message landed, revealed with the message's hover actions
 * ("3:27 PM"; "Yesterday, 3:27 PM"; "Sep 28, 3:27 PM"), with the age and full
 * date in its tip. Visibility belongs to the host's hover group: this paints
 * the label only. Stands down while `display.timestamps` is on, because the
 * transcript already prints every stamp.
 *
 * `plain` drops the tip and prints the detail instead — the age and the full
 * date/time, the text the tip used to hide — for a surface that carries the
 * stamp as standing text under the message rather than as a hover reveal.
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
        <HoverTimeDetail ms={date.getTime()} />
      ) : (
        formatMessageTimestamp(date, { today: clockOnly, yesterday: t.assistant.thread.yesterday })
      )}
    </time>
  )

  if (plain) {
    return stamp
  }

  return <Tooltip><TooltipTrigger asChild>{stamp}</TooltipTrigger><TooltipContent side="top">{<HoverTimeDetail ms={date.getTime()} />}</TooltipContent></Tooltip>
}

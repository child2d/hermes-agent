import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { ContextUsagePanel } from '@/app/shell/context-usage-panel'
import { useContextBreakdown } from '@/app/shell/hooks/use-context-breakdown'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { mergeGaugeUsage, usageContextLabel } from '@/lib/statusbar'
import { useStoreSelector } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { requestGatewayForProfile } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $sessionStates } from '@/store/session-states'
import type { UsageStats } from '@/types/hermes'

import { GHOST_ICON_BTN } from './control-classes'

const EMPTY_USAGE: UsageStats = { calls: 0, input: 0, output: 0, total: 0 }
// r=6.5 in a 16px box: ring diameter 13px + a 1.5px stroke lands inside the
// composer-control box without touching it.
const RADIUS = 6.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

type GatewayRequest = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>

/**
 * How full the context window is, in the composer — a ring instead of the
 * statusbar meter's `[bar] 42%`, because this sits in a row of pills and
 * buttons where a second text readout would read as noise. The number is one
 * click away (`ContextUsagePanel`, the same panel the statusbar opens), and the
 * accessible name carries it too.
 *
 * Like the approval chip, this exists because Simple mode hides the statusbar:
 * the composer is the one surface every mode keeps.
 */
export function ContextUsageRing({ busy, sessionId }: { busy: boolean; sessionId: null | string }) {
  const { t } = useI18n()
  const copy = t.shell.statusbar
  const profile = useStore($activeGatewayProfile)

  const requestGateway = useMemo<GatewayRequest>(
    () => (method, params) => requestGatewayForProfile(profile, method, params),
    [profile]
  )

  // The session's own live usage (not the focused session's): a tile composer
  // shows a different session than the one in focus, and the ring must belong to
  // the session being typed into.
  const liveUsage = useStoreSelector($sessionStates, states =>
    sessionId ? (states[sessionId]?.usage ?? null) : null
  )

  const { breakdown, loading } = useContextBreakdown({
    busy,
    enabled: Boolean(sessionId),
    requestGateway,
    sessionId
  })

  const usage = useMemo(
    () => mergeGaugeUsage(breakdown, (liveUsage as UsageStats | null) ?? EMPTY_USAGE),
    [breakdown, liveUsage]
  )

  const label = usageContextLabel(usage)
  const percent = Math.max(0, Math.min(100, usage.context_percent ?? 0))

  if (!sessionId) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label ? `${copy.contextUsage}: ${label}` : copy.contextUsage}
          className={cn(GHOST_ICON_BTN, 'p-0')}
          data-slot="composer-context-ring"
          type="button"
          variant="ghost"
        >
          <svg aria-hidden="true" className="size-4 -rotate-90" viewBox="0 0 16 16">
            <circle
              cx="8"
              cy="8"
              fill="none"
              r={RADIUS}
              stroke="var(--ui-stroke-tertiary)"
              strokeWidth="1.5"
            />
            <circle
              cx="8"
              cy="8"
              fill="none"
              r={RADIUS}
              stroke="currentColor"
              strokeDasharray={`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              strokeLinecap="round"
              strokeWidth="1.5"
            />
          </svg>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto border-(--ui-stroke-secondary) p-0">
        <ContextUsagePanel breakdown={breakdown} loading={loading} usage={usage} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

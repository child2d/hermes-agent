import { useStore } from '@nanostores/react'
import { useCallback, useEffect } from 'react'

import { ApprovalModeMenuItems, useApprovalModeLabels } from '@/app/shell/approval-mode-menu'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { ChevronDown, Zap, ZapFilled } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $approvalModes,
  type ApprovalModeRequester,
  setApprovalModeForProfile,
  syncApprovalModeForProfile
} from '@/store/approval-mode'
import { requestGatewayForProfile } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'

import { CONTROL_PILL } from './control-classes'

/**
 * The approval mode, in the composer — same control the statusbar carries (one
 * store, one menu: `ApprovalModeMenuItems`), reachable from the row you are
 * already typing in. That is the whole reason it exists: Simple mode hides the
 * statusbar, which used to be the only place this setting lived, so the mode
 * became invisible and unchangeable exactly for the users who never open
 * settings.
 *
 * Scoped to the ACTIVE gateway profile, the same key the statusbar's item uses
 * (`$activeGatewayProfile`), so the two can never disagree about which mode they
 * are showing.
 */
export function ApprovalModeChip({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n()
  const copy = t.shell.approvalMode
  const labels = useApprovalModeLabels()
  const profile = useStore($activeGatewayProfile)
  const modes = useStore($approvalModes)
  const mode = modes[profile.trim() || 'default'] ?? 'smart'

  const requestGateway = useCallback<ApprovalModeRequester>(
    (method, params) => requestGatewayForProfile(profile, method, params),
    [profile]
  )

  // Adopt whatever the gateway reports and push local drift back, exactly as
  // the statusbar item does — same call, so a mode set in either place lands in
  // both.
  useEffect(() => {
    void syncApprovalModeForProfile(requestGateway, profile).catch(() => undefined)
  }, [profile, requestGateway])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={copy.ariaLabel(labels[mode])}
          className={cn(CONTROL_PILL, 'shrink-0')}
          data-slot="composer-approval-mode"
          disabled={disabled}
          type="button"
          variant="ghost"
        >
          {mode === 'off' ? <ZapFilled className="size-3.5" /> : <Zap className="size-3.5 opacity-70" />}
          <span className="truncate">{labels[mode]}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1">
        <ApprovalModeMenuItems
          mode={mode}
          onValueChange={value => {
            void setApprovalModeForProfile(requestGateway, profile, value).catch(() => undefined)
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

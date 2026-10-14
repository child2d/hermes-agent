import { useStore } from '@nanostores/react'

import { APPROVAL_MENU_CLASS, ApprovalModeMenuItems, useApprovalModeControl } from '@/app/shell/approval-mode-menu'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { ChevronDown, Zap, ZapFilled } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $activeGatewayProfile } from '@/store/profile'

import { CONTROL_PILL } from './control-classes'

/**
 * The approval mode, in the composer — the same control the statusbar carries
 * (one hook, one menu: `useApprovalModeControl` / `ApprovalModeMenuItems`),
 * reachable from the row you are already typing in. That is the whole reason it
 * exists: Simple mode hides the statusbar, which used to be the only place this
 * setting lived, so the mode became invisible and unchangeable exactly for the
 * users who never open settings.
 */
export function ApprovalModeChip({ disabled = false }: { disabled?: boolean }) {
  const copy = useI18n().t.shell.approvalMode
  const profile = useStore($activeGatewayProfile)
  const { labels, mode, setMode } = useApprovalModeControl(profile)

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
      <DropdownMenuContent align="start" className={APPROVAL_MENU_CLASS}>
        <ApprovalModeMenuItems mode={mode} onValueChange={setMode} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

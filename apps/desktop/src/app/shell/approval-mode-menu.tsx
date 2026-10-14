import { useStore } from '@nanostores/react'
import { useEffect, useMemo } from 'react'

import type { StatusbarItem } from '@/app/shell/statusbar-controls'
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { Zap, ZapFilled } from '@/lib/icons'
import {
  $approvalModes,
  type ApprovalMode,
  type ApprovalModeRequester,
  setApprovalModeForProfile,
  syncApprovalModeForProfile
} from '@/store/approval-mode'

/** The three modes, as menu items. One source of truth for both places this
 *  menu is opened from: the statusbar item below and the composer's chip — the
 *  labels and their descriptions must not drift between them. */
export function ApprovalModeMenuItems({
  mode,
  onValueChange
}: {
  mode: ApprovalMode
  onValueChange: (mode: ApprovalMode) => void
}) {
  const { t } = useI18n()
  const copy = t.shell.approvalMode

  const labels = useMemo<Record<ApprovalMode, string>>(
    () => ({ manual: copy.manual, smart: copy.smart, off: copy.off }),
    [copy.manual, copy.off, copy.smart]
  )

  const descriptions = useMemo<Record<ApprovalMode, string>>(
    () => ({
      manual: copy.manualDescription,
      smart: copy.smartDescription,
      off: copy.offDescription
    }),
    [copy.manualDescription, copy.offDescription, copy.smartDescription]
  )

  return (
    <>
      <DropdownMenuLabel>{copy.title}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup onValueChange={value => onValueChange(value as ApprovalMode)} value={mode}>
        {(['manual', 'smart', 'off'] as const).map(value => (
          <DropdownMenuRadioItem className="items-start gap-2" key={value} value={value}>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-foreground">{labels[value]}</span>
              <span className="text-2xs leading-snug text-(--ui-text-tertiary)">{descriptions[value]}</span>
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}

/** The statusbar's approval-mode item. The composer's chip (`approval-mode-chip`)
 *  opens the same menu from the input row — the statusbar is hidden in Simple
 *  mode, so that chip is the only place the mode is reachable there. */
export function useApprovalModeStatusbarItem(profile: string, requestGateway: ApprovalModeRequester): StatusbarItem {
  const { t } = useI18n()
  const copy = t.shell.approvalMode
  const modes = useStore($approvalModes)
  const mode = modes[profile.trim() || 'default'] ?? 'smart'

  const labels = useMemo<Record<ApprovalMode, string>>(
    () => ({ manual: copy.manual, smart: copy.smart, off: copy.off }),
    [copy.manual, copy.off, copy.smart]
  )

  useEffect(() => {
    void syncApprovalModeForProfile(requestGateway, profile).catch(() => undefined)
  }, [profile, requestGateway])

  return {
    className: mode === 'off' ? 'bg-(--chrome-action-hover) text-foreground' : undefined,
    icon: mode === 'off' ? <ZapFilled className="size-3.5" /> : <Zap className="size-3.5 opacity-70" />,
    id: 'approval-mode',
    label: labels[mode],
    menuAlign: 'end',
    menuClassName: 'w-72 p-1',
    menuContent: (
      <ApprovalModeMenuItems
        mode={mode}
        onValueChange={value => {
          void setApprovalModeForProfile(requestGateway, profile, value).catch(() => undefined)
        }}
      />
    ),
    title: copy.ariaLabel(labels[mode]),
    variant: 'menu'
  }
}

import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useMemo } from 'react'

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
import { requestGatewayForProfile } from '@/store/gateway'

/** The menu's box, shared by its two openings (the statusbar item's popover and
 *  the composer chip's dropdown) so the three-option list cannot be laid out two
 *  different ways. */
export const APPROVAL_MENU_CLASS = 'w-72 p-1'

/** The three mode labels — ONE map for the surfaces that show the setting (the
 *  statusbar item's trigger, the menu items, the composer's chip). */
function useApprovalModeLabels(): Record<ApprovalMode, string> {
  const copy = useI18n().t.shell.approvalMode

  return useMemo(
    () => ({ manual: copy.manual, smart: copy.smart, off: copy.off }),
    [copy.manual, copy.off, copy.smart]
  )
}

/**
 * The approval mode of one gateway profile: its current value, its labels, and
 * the scoped read/write. ONE hook for every surface that shows or changes it, so
 * the scoping rule lives in one place — a gateway `config.get`/`config.set` with
 * no `profile` resolves to whichever profile the backend was *launched* with, so
 * an unscoped call shows one profile's mode for all of them and writes to the
 * wrong one (#125969).
 *
 * The profile is dialled directly (not through the ambient, session-routed
 * dispatcher, which re-scopes `params.profile` to the focused session's).
 */
export function useApprovalModeControl(profile: string) {
  const labels = useApprovalModeLabels()
  const modes = useStore($approvalModes)
  const mode = modes[profile.trim() || 'default'] ?? 'smart'

  const requestGateway = useCallback<ApprovalModeRequester>(
    (method, params) => requestGatewayForProfile(profile, method, params),
    [profile]
  )

  // Adopt whatever the gateway reports on profile change, pushing local drift
  // back. Same call from every surface, so a mode set in one lands in all.
  useEffect(() => {
    void syncApprovalModeForProfile(requestGateway, profile).catch(() => undefined)
  }, [profile, requestGateway])

  const setMode = useCallback(
    (next: ApprovalMode) => {
      void setApprovalModeForProfile(requestGateway, profile, next).catch(() => undefined)
    },
    [profile, requestGateway]
  )

  return { labels, mode, setMode }
}

/** The three modes, as menu items. */
export function ApprovalModeMenuItems({
  mode,
  onValueChange
}: {
  mode: ApprovalMode
  onValueChange: (mode: ApprovalMode) => void
}) {
  const copy = useI18n().t.shell.approvalMode
  const labels = useApprovalModeLabels()

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

/** The statusbar's approval-mode item. The composer's chip
 *  (`approval-mode-chip`) opens the same menu from the input row — the statusbar
 *  is hidden in Simple mode, so that chip is the only place the mode is reachable
 *  there. */
export function useApprovalModeStatusbarItem(profile: string): StatusbarItem {
  const copy = useI18n().t.shell.approvalMode
  const { labels, mode, setMode } = useApprovalModeControl(profile)

  return {
    className: mode === 'off' ? 'bg-(--chrome-action-hover) text-foreground' : undefined,
    icon: mode === 'off' ? <ZapFilled className="size-3.5" /> : <Zap className="size-3.5 opacity-70" />,
    id: 'approval-mode',
    label: labels[mode],
    menuAlign: 'end',
    menuClassName: APPROVAL_MENU_CLASS,
    menuContent: <ApprovalModeMenuItems mode={mode} onValueChange={setMode} />,
    title: copy.ariaLabel(labels[mode]),
    variant: 'menu'
  }
}

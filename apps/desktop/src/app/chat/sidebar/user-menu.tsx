import { useStore } from '@nanostores/react'
import { type ReactElement, useState } from 'react'
import { useNavigate } from 'react-router'

import { usePlanktonSession } from '@/app/plankton-auth-gate'
import { AvatarChip } from '@/components/ui/avatar-chip'
import { menuItemClass, menuItemFocusClass, menuMotionClass, menuSurfaceClass } from '@/components/ui/menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { type IconComponent, LogOut, Palette, RefreshCw, Settings2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $enterpriseEnabled } from '@/store/enterprise-flag'
import { $updateChecking, $updateStatus, checkUpdates } from '@/store/updates'
import { useTheme } from '@/themes/context'

import { SETTINGS_ROUTE } from '../../routes'

/**
 * The sidebar's account row — the signed-in enterprise (Plankton) identity,
 * avatar + display name at the sidebar's foot, with the account panel behind
 * it: who is signed in, then the personal settings that used to be reachable
 * only by opening Settings, then sign-out on its own group.
 *
 * Renders ONLY on the enterprise build while the login gate is active
 * (`$enterpriseEnabled` is false on every upstream variant, and the session
 * hook is a no-op there), so upstream keeps its own sidebar foot.
 *
 * What it deliberately does NOT show: the raw SSO subject. Enterprise subjects
 * are often opaque ids ("5"), and a bare number under the name reads as a
 * broken badge — an address is displayed, an id is not.
 */

/** One action row: leading icon, label, optional trailing hint. */
function MenuAction({
  disabled,
  hint,
  icon: Icon,
  label,
  onSelect
}: {
  disabled?: boolean
  hint?: null | string
  icon: IconComponent
  label: string
  onSelect: () => void
}): ReactElement {
  return (
    <button
      className={cn(
        menuItemClass,
        menuItemFocusClass,
        'w-full text-left disabled:pointer-events-none disabled:opacity-50'
      )}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <Icon className="text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint ? <span className="shrink-0 text-xs text-muted-foreground">{hint}</span> : null}
    </button>
  )
}

/** Hairline between the panel's groups — the reference groups its rows too. */
function MenuGroup(): ReactElement {
  return <div aria-hidden="true" className="my-1 h-px bg-border" />
}

export function SidebarUserMenu(): ReactElement | null {
  const enterprise = useStore($enterpriseEnabled)
  const session = usePlanktonSession()
  const navigate = useNavigate()
  const { t } = useI18n()
  const { mode, setMode } = useTheme()
  const checking = useStore($updateChecking)
  const updateStatus = useStore($updateStatus)
  const [open, setOpen] = useState(false)

  if (!enterprise || !session.required) {
    return null
  }

  const name = session.whoami?.displayName || session.whoami?.subject || '企业账号'
  const subject = session.whoami?.subject ?? ''
  const address = subject.includes('@') ? subject : null

  // `behind: null` means "an update exists, the count is unknown" (global.d.ts),
  // so null must not fall through to "up to date".
  const updateHint = ((): null | string => {
    if (checking) {
      return '检查中…'
    }

    if (updateStatus?.supported !== true) {
      return null
    }

    if (updateStatus.behind === null) {
      return '有更新'
    }

    if (typeof updateStatus.behind !== 'number') {
      return null
    }

    return updateStatus.behind > 0 ? `有 ${updateStatus.behind} 个更新` : '已是最新'
  })()

  const modeOptions = (['light', 'dark', 'system'] as const).map(id => ({
    id,
    label: t.settings.modeOptions[id].label
  }))

  return (
    // The rail's foot: ONE avatar, no name and no chevron. The row that used to sit
    // at the sidebar's bottom repeated the identity the panel already opens with,
    // and the rail is where a window's account belongs. The trigger is a glyph box
    // like the rail's other buttons.
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-expanded={open}
          aria-label={name}
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-md transition-colors',
            'hover:bg-(--ui-control-hover-background)',
            open && 'bg-(--ui-control-active-background)'
          )}
          type="button"
        >
          <AvatarChip className="size-6 rounded-full text-2xs" name={name} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={cn(menuSurfaceClass, menuMotionClass, 'w-64')}
        side="right"
        sideOffset={8}
      >
          <div className="flex items-center gap-2.5 px-2 py-1.5" data-testid="plankton-account-identity">
            <AvatarChip className="size-8 rounded-full text-sm" name={name} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">{name}</div>
              {address ? <div className="truncate text-xs text-muted-foreground">{address}</div> : null}
            </div>
          </div>

          <MenuGroup />

          <MenuAction
            icon={Settings2}
            label="设置"
            onSelect={() => {
              setOpen(false)
              navigate(SETTINGS_ROUTE)
            }}
          />

          {/* Appearance is a control, not a destination: the row carries the
              segmented switch itself and no chevron, same as the reference. */}
          <div className={cn(menuItemClass, 'cursor-default')}>
            <Palette className="text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">外观</span>
            <SegmentedControl
              onChange={id => {
                triggerHaptic('crisp')
                setMode(id)
              }}
              options={modeOptions}
              value={mode}
            />
          </div>

          <MenuAction
            hint={updateHint}
            icon={RefreshCw}
            label="检查更新"
            onSelect={() => void checkUpdates({ force: true })}
          />

          <MenuGroup />

          <MenuAction
            disabled={session.signingOut}
            icon={LogOut}
            label={session.signingOut ? '正在退出…' : '退出登录'}
            onSelect={() => void session.signOut()}
          />

          {session.logoutError ? (
            <p className="px-2 py-1 text-xs text-destructive" role="alert">
              {session.logoutError}
            </p>
          ) : null}
      </PopoverContent>
    </Popover>
  )
}

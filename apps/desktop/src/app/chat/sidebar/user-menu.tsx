import { useStore } from '@nanostores/react'
import { type ReactElement, useState } from 'react'
import { useNavigate } from 'react-router'

import { usePlanktonSession } from '@/app/plankton-auth-gate'
import { AvatarChip } from '@/components/ui/avatar-chip'
import { Codicon } from '@/components/ui/codicon'
import {
  menuItemClass,
  menuItemFocusClass,
  menuLabelClass,
  menuMotionClass,
  menuSurfaceClass
} from '@/components/ui/menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LogOut, Settings2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $enterpriseEnabled } from '@/store/enterprise-flag'

import { SETTINGS_ROUTE } from '../../routes'

/**
 * The sidebar's account row — the signed-in enterprise (Plankton) identity,
 * avatar + display name, sitting at the sidebar's foot with the account panel
 * behind it (sign-out, Settings).
 *
 * Renders ONLY on the enterprise build while the login gate is active
 * (`$enterpriseEnabled` is false on every upstream variant, and the session
 * hook is a no-op there), so upstream keeps its own sidebar foot — the same
 * gate Settings' account block used to carry, moved to where the identity
 * actually belongs: beside everything else that is "this install, this
 * person", not buried in a settings subpage.
 */
export function SidebarUserMenu(): ReactElement | null {
  const enterprise = useStore($enterpriseEnabled)
  const session = usePlanktonSession()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  if (!enterprise || !session.required) {
    return null
  }

  const name = session.whoami?.displayName || session.whoami?.subject || '企业账号'
  const account = session.whoami?.subject

  return (
    <div className="shrink-0 px-0.5 pb-1 pt-0.5">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            aria-expanded={open}
            aria-label={name}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-(--ui-text-secondary)',
              'transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground',
              open && 'bg-(--ui-control-active-background) text-foreground'
            )}
            type="button"
          >
            <AvatarChip className="size-5 rounded-full text-2xs" name={name} />
            <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
            <Codicon className="text-(--ui-text-quaternary)" name="chevron-up" size="0.75rem" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className={cn(menuSurfaceClass, menuMotionClass, 'w-60')}
          side="top"
          sideOffset={6}
        >
          <div className={menuLabelClass} data-testid="plankton-account-identity">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            {account ? <span className="block truncate">{account}</span> : null}
          </div>
          <div aria-hidden="true" className="my-1 h-px bg-border" />
          <button
            className={cn(menuItemClass, menuItemFocusClass, 'w-full text-left')}
            onClick={() => {
              setOpen(false)
              navigate(SETTINGS_ROUTE)
            }}
            type="button"
          >
            <Settings2 />
            设置
          </button>
          <button
            className={cn(menuItemClass, menuItemFocusClass, 'w-full text-left')}
            disabled={session.signingOut}
            onClick={() => void session.signOut()}
            type="button"
          >
            <LogOut />
            {session.signingOut ? '正在退出…' : '退出登录'}
          </button>
          {session.logoutError ? (
            <p className="px-2 py-1 text-xs text-destructive" role="alert">
              {session.logoutError}
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  )
}

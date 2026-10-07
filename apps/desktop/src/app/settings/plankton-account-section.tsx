import { useStore } from '@nanostores/react'
import { type ReactElement } from 'react'

import { usePlanktonSession } from '@/app/plankton-auth-gate'
import { Button } from '@/components/ui/button'
import { LogOut } from '@/lib/icons'
import { $enterpriseEnabled } from '@/store/enterprise-flag'

import { SectionHeading } from './primitives'

/**
 * Settings › About: the enterprise (Plankton) account block — the signed-in
 * SSO identity plus its sign-out entry.
 *
 * Renders ONLY on the enterprise build while the login gate is active
 * (`$enterpriseEnabled` is false on every upstream variant, and the session
 * hook is a no-op there), so upstream About is byte-for-byte unchanged. It
 * lives beside the version/update facts because those already describe "this
 * app and this install"; the identity of the signed-in account is the same
 * class of fact.
 */
export function PlanktonAccountSection(): ReactElement | null {
  const enterprise = useStore($enterpriseEnabled)
  const session = usePlanktonSession()

  if (!enterprise || !session.required) {
    return null
  }

  const label = session.whoami?.displayName || session.whoami?.subject || '企业账号'

  return (
    <div className="mb-4 grid gap-3" id="setting-plankton-account">
      <SectionHeading icon={LogOut} title="账号" />
      <div
        className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
        data-testid="plankton-account-row"
      >
        <div className="grid gap-0.5">
          <span className="text-sm font-medium">已登录</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <Button disabled={session.signingOut} onClick={() => void session.signOut()} variant="outline">
          {session.signingOut ? '正在退出…' : '退出登录'}
        </Button>
      </div>
      {session.logoutError ? (
        <p className="text-sm text-destructive" role="alert">
          {session.logoutError}
        </p>
      ) : null}
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'

/**
 * Enterprise (Plankton) SSO login gate — the renderer half of the fail-closed
 * gate in `electron/plankton-session-gate.ts`.
 *
 * While no SSO session is live this REPLACES the app (it never mounts it), so
 * no session list, chat, or config read is even attempted: the session list is
 * not rendered because the surface that owns it is not rendered. Login opens
 * the system browser against shaoke 240 SSO; the desktop catches the loopback
 * callback and the gate opens.
 *
 * On every upstream variant `planktonAuthRequired` is absent/false and this is
 * a transparent pass-through — their UI is unchanged.
 */
type GateState = 'checking' | 'out' | 'in' | 'working'

interface SsoStatus {
  loginReady: boolean
  loginBlockedReason: string | null
  loggedIn: boolean
  whoami: { subject: string; displayName: string | null } | null
}

export function PlanktonAuthGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const required = typeof window !== 'undefined' && window.hermesDesktop?.planktonAuthRequired === true
  const api = typeof window !== 'undefined' ? window.hermesDesktop?.planktonAuth : undefined
  const [state, setState] = useState<GateState>(required ? 'checking' : 'in')
  const [status, setStatus] = useState<SsoStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState<'feishu' | 'password'>('feishu')

  const refresh = useCallback(async (): Promise<void> => {
    if (!required || !api) {
      return
    }

    try {
      const next = (await api.status()) as unknown as SsoStatus
      setStatus(next)
      setError(next.loginReady ? null : next.loginBlockedReason)
      setState(next.loggedIn ? 'in' : 'out')
    } catch {
      setError('无法读取登录状态')
      setState('out')
    }
  }, [required, api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const signIn = useCallback(async (): Promise<void> => {
    if (!api) {
      return
    }

    setState('working')
    setError(null)

    try {
      const result = (await api.login(channel)) as { ok: boolean; error?: string }

      if (result.ok) {
        await refresh()
      } else {
        setError(result.error || '登录失败')
        setState('out')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
      setState('out')
    }
  }, [api, channel, refresh])

  if (!required) {
    return <>{children}</>
  }

  if (state === 'in') {
    return <>{children}</>
  }

  if (state === 'checking') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-sm text-muted-foreground">
        正在检查登录状态…
      </div>
    )
  }

  const busy = state === 'working'

  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background px-8 text-center">
      <h1 className="text-xl font-semibold">登录 Plankton</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        此应用需要企业身份才能使用。请先通过捎客 SSO 登录，登录前不会显示任何会话，也不会读取企业数据。
      </p>

      <div className="flex gap-2">
        <button
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
          disabled={busy || status?.loginReady === false}
          onClick={() => void signIn()}
          type="button"
        >
          {busy ? '等待浏览器完成登录…' : '使用飞书登录'}
        </button>
        <button
          className="rounded-md border px-4 py-2 text-sm disabled:opacity-50"
          disabled={busy || status?.loginReady === false}
          onClick={() => {
            setChannel('password')
            void signIn()
          }}
          type="button"
        >
          使用密码登录
        </button>
      </div>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input checked={channel === 'password'} onChange={e => setChannel(e.target.checked ? 'password' : 'feishu')} type="checkbox" />
        改用密码渠道（默认飞书）
      </label>

      {error ? (
        <p className="max-w-md text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <button className="text-xs text-muted-foreground underline" disabled={busy} onClick={() => void refresh()} type="button">
        重新检查登录状态
      </button>
    </div>
  )
}

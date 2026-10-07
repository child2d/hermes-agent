import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

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

/** The signed-in identity, reduced to what a display surface needs. */
export interface PlanktonSessionIdentity {
  subject: string
  displayName: string | null
}

/**
 * What the signed-in surface (Settings › About) may ask of the session. A
 * no-op on every upstream variant, so consuming components need no variant
 * branch of their own.
 */
export interface PlanktonSession {
  /** True only where the gate is actually active (the enterprise build). */
  required: boolean
  /** The signed-in identity, or null while logged out. */
  whoami: PlanktonSessionIdentity | null
  /** A sign-out is in flight. */
  signingOut: boolean
  /** A visible, non-detail message from a failed sign-out. */
  logoutError: string | null
  /**
   * Sign out: drop the SSO session, then return to the login page with no
   * in-memory trace of the signed-in surface. Never rejects.
   */
  signOut: () => Promise<void>
}

const NO_SESSION: PlanktonSession = {
  required: false,
  whoami: null,
  signingOut: false,
  logoutError: null,
  signOut: async () => undefined
}

const PlanktonSessionContext = createContext<PlanktonSession>(NO_SESSION)

/** The enterprise SSO session, for the signed-in surface. No-op off-enterprise. */
export function usePlanktonSession(): PlanktonSession {
  return useContext(PlanktonSessionContext)
}

/** Reload the renderer. Wrapped so a test can stub `window.location`. */
function reloadRenderer(): void {
  window.location.reload()
}

export function PlanktonAuthGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const required = typeof window !== 'undefined' && window.hermesDesktop?.planktonAuthRequired === true
  const api = typeof window !== 'undefined' ? window.hermesDesktop?.planktonAuth : undefined
  const [state, setState] = useState<GateState>(required ? 'checking' : 'in')
  const [status, setStatus] = useState<SsoStatus | null>(null)
  const [whoami, setWhoami] = useState<PlanktonSessionIdentity | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [channel, setChannel] = useState<'feishu' | 'password'>('feishu')

  // Fence for the login/logout-while-probing race main.ts calls out (a newer
  // sign-in/sign-out can finish while a status/provider probe is still in
  // flight): every async result is discarded unless it still owns the session
  // generation it started under. Without it a `status()` that resolves after a
  // sign-out would flip the gate back to 'in' and remount the app with the old
  // identity.
  const generation = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    if (!required || !api) {
      return
    }

    const gen = generation.current

    try {
      const next = (await api.status()) as unknown as SsoStatus

      if (gen !== generation.current) {
        return
      }

      setStatus(next)
      setWhoami(next.whoami ? { displayName: next.whoami.displayName, subject: next.whoami.subject } : null)
      setError(next.loginReady ? null : next.loginBlockedReason)
      setState(next.loggedIn ? 'in' : 'out')
    } catch {
      if (gen !== generation.current) {
        return
      }

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
    const gen = ++generation.current

    try {
      const result = (await api.login(channel)) as { ok: boolean; error?: string }

      if (gen !== generation.current) {
        return
      }

      if (result.ok) {
        await refresh()
      } else {
        setError(result.error || '登录失败')
        setState('out')
      }
    } catch (err) {
      if (gen !== generation.current) {
        return
      }

      setError(err instanceof Error ? err.message : '登录失败')
      setState('out')
    }
  }, [api, channel, refresh])

  const signOut = useCallback(async (): Promise<void> => {
    if (!required || !api) {
      return
    }

    setSigningOut(true)
    setLogoutError(null)
    // Take a new generation BEFORE awaiting: any status/login read still in
    // flight when the logout lands is now stale and cannot resurrect the
    // session.
    const gen = ++generation.current

    try {
      const result = (await api.logout()) as { ok?: boolean }

      if (gen !== generation.current) {
        return
      }

      if (result && result.ok === false) {
        // Visible, but deliberately without any internal detail.
        setLogoutError('退出登录失败，请稍后重试。')
        setSigningOut(false)

        return
      }

      // Drop the session facts before the app unmounts, then reload the
      // renderer: the gate unmounting `App` removes the signed-in surface, and
      // the reload tears down the module-level stores / sockets it left behind
      // so the next sign-in cannot render a stale session, connection, or
      // identity. The reloaded renderer re-queries the (now logged-out) status
      // and shows the login page.
      setStatus(null)
      setWhoami(null)
      setState('out')
      reloadRenderer()
    } catch {
      if (gen !== generation.current) {
        return
      }

      setLogoutError('退出登录失败，请稍后重试。')
      setSigningOut(false)
    }
  }, [required, api])

  const session = useMemo<PlanktonSession>(
    () => ({ logoutError, required, signOut, signingOut, whoami }),
    [logoutError, required, signOut, signingOut, whoami]
  )

  if (!required) {
    return <>{children}</>
  }

  if (state === 'in') {
    return <PlanktonSessionContext.Provider value={session}>{children}</PlanktonSessionContext.Provider>
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

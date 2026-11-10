/**
 * AutoCode workspace page — embeds the local AutoCode Vite UI in an iframe.
 * When the frontend is down, show a clear offline state with open/retry actions.
 */

import { Button, Codicon } from '@hermes/plugin-sdk'
import { useCallback, useEffect, useState } from 'react'

import { useAutoCode } from './i18n'
import { DEFAULT_URL } from './shared'

type ProbeState = 'checking' | 'down' | 'up'

async function probe(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 2500)
    const res = await fetch(url, { method: 'GET', mode: 'no-cors', signal: controller.signal })
    window.clearTimeout(timer)
    // no-cors: opaque success still means the TCP/HTTP handshake reached something.
    return res.type === 'opaque' || res.ok || res.status === 0
  } catch {
    return false
  }
}

export function AutoCodePage({
  openExternal,
  url = DEFAULT_URL
}: {
  openExternal: (url: string) => Promise<boolean>
  url?: string
}) {
  const k = useAutoCode()
  const target = url.replace(/\/$/, '')
  const [state, setState] = useState<ProbeState>('checking')
  const [frameKey, setFrameKey] = useState(0)

  const refresh = useCallback(async () => {
    setState('checking')
    const ok = await probe(target)
    setState(ok ? 'up' : 'down')
    if (ok) {
      setFrameKey(n => n + 1)
    }
  }, [target])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-(--ui-bg-primary)">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-3">
        <Codicon className="text-(--ui-text-tertiary)" name="code" size="0.85rem" />
        <div className="min-w-0 flex-1 truncate text-xs font-medium text-(--ui-text-secondary)">{k.title}</div>
        <Button className="h-7 px-2 text-2xs" onClick={() => void openExternal(target)} size="sm" type="button" variant="ghost">
          {k.openExternal}
        </Button>
        <Button className="h-7 px-2 text-2xs" onClick={() => void refresh()} size="sm" type="button" variant="ghost">
          {k.retry}
        </Button>
      </div>

      {state === 'up' ? (
        <iframe
          allow="clipboard-read; clipboard-write"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          key={frameKey}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          src={target}
          title={k.title}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Codicon className="text-(--ui-text-quaternary)" name="debug-disconnect" size="1.6rem" />
          <div className="text-sm font-medium text-(--ui-text-primary)">
            {state === 'checking' ? k.loading : k.offlineTitle}
          </div>
          {state === 'down' ? (
            <>
              <div className="max-w-md text-xs text-(--ui-text-tertiary)">{k.offlineBody}</div>
              <div className="max-w-md font-mono text-2xs text-(--ui-text-quaternary)">{k.offlineHint}</div>
              <div className="mt-1 flex gap-2">
                <Button onClick={() => void openExternal(target)} type="button" variant="secondary">
                  {k.openExternal}
                </Button>
                <Button onClick={() => void refresh()} type="button">
                  {k.retry}
                </Button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}

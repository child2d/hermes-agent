/**
 * AutoCode module page — left-rail entry that opens the AutoCode console
 * inside Plankton. Auth is Plankton SSO; AutoCode is told `embed=plankton`
 * so it skips its own Feishu setup gate.
 *
 * Cold start: the page does not assume the service is already running. It asks
 * the main process to `ensure` it — main spawns the backend with
 * AUTOCODE_AGENT_PAYLOAD + HERMES_HOME so the agent runs as this install's
 * shaoke-agent (see electron/autocode-service.ts). Falls back to a plain probe
 * when the desktop bridge is absent (browser dev).
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'

import { AUTOCODE_DEFAULT_URL, autocodeEmbedUrl } from './shared'

type Phase = 'starting' | 'up' | 'failed'

interface Failure {
  title: string
  detail: string
}

async function probe(url: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 2500)
    const res = await fetch(url, { method: 'GET', mode: 'no-cors', signal: controller.signal })
    window.clearTimeout(timer)
    return res.type === 'opaque' || res.ok || res.status === 0
  } catch {
    return false
  }
}

export function AutocodeView() {
  const target = autocodeEmbedUrl(AUTOCODE_DEFAULT_URL)
  const origin = AUTOCODE_DEFAULT_URL.replace(/\/$/, '')
  const [phase, setPhase] = useState<Phase>('starting')
  const [failure, setFailure] = useState<Failure | null>(null)
  const [frameKey, setFrameKey] = useState(0)
  // The ensure() promise can resolve after the user leaves the page; a setState
  // there is a no-op but a React warning in dev.
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  const boot = useCallback(async () => {
    setPhase('starting')
    setFailure(null)

    const bridge = window.hermesDesktop?.autocodeService
    if (!bridge) {
      // Browser / older shell: no supervisor, just probe what is already up.
      const ok = await probe(origin)
      if (!mounted.current) return
      if (ok) {
        setPhase('up')
        setFrameKey(n => n + 1)
      } else {
        setPhase('failed')
        setFailure({
          title: 'AutoCode 未启动',
          detail: `未连接桌面端监管接口。请手动启动 AutoCode 后重试（默认 ${origin}）。`
        })
      }

      return
    }

    const result = await bridge.ensure().catch(
      (error: unknown): { state: 'failed'; url: string; spawned: boolean; detail: string } => ({
        state: 'failed',
        url: target,
        spawned: false,
        detail: error instanceof Error ? error.message : String(error)
      })
    )
    if (!mounted.current) return

    if (result.state === 'running') {
      setPhase('up')
      setFrameKey(n => n + 1)

      return
    }

    setPhase('failed')
    setFailure({
      title: result.state === 'missing' ? 'AutoCode 未就绪' : 'AutoCode 启动失败',
      detail: result.detail || `无法连接 ${origin}`
    })
  }, [origin, target])

  useEffect(() => {
    void boot()
  }, [boot])

  const openExternal = () => {
    void window.hermesDesktop?.openExternal?.(target)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-(--ui-bg-primary)">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-(--ui-stroke-secondary) px-3">
        <Codicon className="text-(--ui-text-tertiary)" name="code" size="0.85rem" />
        <div className="min-w-0 flex-1 truncate text-xs font-medium text-(--ui-text-secondary)">AutoCode</div>
        <Button className="h-7 px-2 text-2xs" onClick={openExternal} size="sm" type="button" variant="ghost">
          浏览器打开
        </Button>
        <Button className="h-7 px-2 text-2xs" onClick={() => void boot()} size="sm" type="button" variant="ghost">
          重试
        </Button>
      </div>

      {phase === 'up' ? (
        <iframe
          allow="clipboard-read; clipboard-write"
          className="min-h-0 w-full flex-1 border-0 bg-white"
          key={frameKey}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
          src={target}
          title="AutoCode"
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Codicon
            className="text-(--ui-text-quaternary)"
            name={phase === 'starting' ? 'loading' : 'debug-disconnect'}
            size="1.6rem"
          />
          <div className="text-sm font-medium text-(--ui-text-primary)">
            {phase === 'starting' ? '正在启动 AutoCode…' : failure?.title}
          </div>
          {phase === 'starting' ? (
            <div className="max-w-md text-xs text-(--ui-text-tertiary)">
              首次启动会准备 agent 运行时（约 600MB，仅一次），请稍候。
            </div>
          ) : (
            <>
              <div className="max-w-md text-xs text-(--ui-text-tertiary)">{failure?.detail}</div>
              <div className="max-w-md font-mono text-2xs text-(--ui-text-quaternary)">{origin}</div>
              <div className="mt-1 flex gap-2">
                <Button onClick={openExternal} type="button" variant="secondary">
                  浏览器打开
                </Button>
                <Button onClick={() => void boot()} type="button">
                  重试
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export { AUTOCODE_ROUTE } from './shared'

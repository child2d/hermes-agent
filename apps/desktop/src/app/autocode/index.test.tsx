/**
 * AutocodeView — cold-start behaviour of the embedded AutoCode page.
 *
 * The page's whole job is "点开就能用": ask main to ensure the local service,
 * render the iframe only once it is really up, and show an actionable reason
 * when it cannot be. Each state is asserted here so the rail entry never
 * silently degrades into a blank frame.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { AutocodeView } from './index'

const EMBED_SRC = 'http://127.0.0.1:8787/?embed=plankton'

function stubBridge(ensure: () => Promise<unknown>): void {
  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    openExternal: vi.fn(),
    autocodeService: { ensure, status: vi.fn(), stop: vi.fn() }
  }
}

afterEach(() => {
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
  vi.unstubAllGlobals()
})

describe('AutocodeView', () => {
  test('renders the embedded console once the service reports running', async () => {
    stubBridge(async () => ({ state: 'running', url: EMBED_SRC, spawned: true, detail: '' }))
    render(<AutocodeView />)

    const frame = await waitFor(() => {
      const node = document.querySelector('iframe')

      expect(node).not.toBeNull()

      return node as HTMLIFrameElement
    })
    expect(frame.src).toBe(EMBED_SRC)
    // Sandbox must keep same-origin so the AutoCode SPA can talk to its own API.
    expect(frame.getAttribute('sandbox')).toContain('allow-same-origin')
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts')
  })

  test('a second mount reuses the running service instead of spawning again', async () => {
    const ensure = vi.fn(async () => ({ state: 'running', url: EMBED_SRC, spawned: false, detail: '' }))
    stubBridge(ensure)

    const { unmount } = render(<AutocodeView />)
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
    unmount()

    render(<AutocodeView />)
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
    expect(ensure).toHaveBeenCalledTimes(2)
    expect(ensure.mock.calls.length).toBe(2)
  })

  test('spawn failure surfaces the backend detail rather than a blank frame', async () => {
    stubBridge(async () => ({
      state: 'failed',
      url: EMBED_SRC,
      spawned: true,
      detail: 'AutoCode 后端 30s 内没有就绪'
    }))
    render(<AutocodeView />)

    await waitFor(() => expect(screen.getByText('AutoCode 启动失败')).toBeTruthy())
    expect(screen.getByText(/30s 内没有就绪/)).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  test('a missing checkout tells the user how to point at one', async () => {
    stubBridge(async () => ({
      state: 'missing',
      url: EMBED_SRC,
      spawned: false,
      detail: '未找到 AutoCode 源码目录。请设置 AUTOCODE_HOME'
    }))
    render(<AutocodeView />)

    await waitFor(() => expect(screen.getByText('AutoCode 未就绪')).toBeTruthy())
    expect(screen.getByText(/AUTOCODE_HOME/)).toBeTruthy()
  })

  test('a rejected ensure promise is caught and shown, not thrown at React', async () => {
    stubBridge(async () => {
      throw new Error('IPC channel closed')
    })
    render(<AutocodeView />)

    await waitFor(() => expect(screen.getByText('AutoCode 启动失败')).toBeTruthy())
    expect(screen.getByText(/IPC channel closed/)).toBeTruthy()
  })

  test('without the desktop bridge it falls back to probing an already-running service', async () => {
    // Browser dev: no preload. A same-origin probe answering opaque/ok counts as up.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, type: 'basic' }) as unknown as Response)
    )
    render(<AutocodeView />)

    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull())
  })

  test('without the bridge and without a service it explains the desktop requirement', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      })
    )
    render(<AutocodeView />)

    await waitFor(() => expect(screen.getByText('AutoCode 未启动')).toBeTruthy())
    expect(screen.getByText(/未连接桌面端监管接口/)).toBeTruthy()
  })
})

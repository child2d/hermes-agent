import { configure } from '@testing-library/react'
import type * as RtlModule from '@testing-library/react'
import type { RenderOptions, RenderResult } from '@testing-library/react'
import { vi } from 'vitest'

import { InertResizeObserver } from './src/test/jsdom'

// Shared tooltips measure their arrow through Radix's useSize hook.
// Geometry assertions still belong in a real browser, not this inert observer. Assigned,
// not `vi.stubGlobal`, so a test's `vi.unstubAllGlobals()` cannot strip it.
globalThis.ResizeObserver ??= InertResizeObserver as unknown as typeof ResizeObserver

// Node 26 defines its own `localStorage` accessor on the global object, which
// returns `undefined` unless the process was started with --localstorage-file
// (it warns: "localStorage is not available because --localstorage-file was
// not provided"). In the jsdom environment `globalThis` IS the window, so that
// accessor shadows jsdom's Storage and every `localStorage.getItem(...)` in a
// test throws "Cannot read properties of undefined". Install a real in-memory
// Storage when the global resolves to nothing, before any test module reads it.
if (typeof (globalThis as any).localStorage === 'undefined') {
  const store = new Map<string, string>()

  const storage: Storage = {
    get length() {
      return store.size
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(String(k)) ?? null,
    setItem: (k: string, v: string) => void store.set(String(k), String(v)),
    removeItem: (k: string) => void store.delete(String(k)),
    clear: () => store.clear()
  }

  for (const target of [globalThis, (globalThis as any).window].filter(Boolean)) {
    Object.defineProperty(target, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true
    })
  }
}

// jsdom has no layout or intersection delivery. Tests of observer behavior
// supply their own callbacks; ordinary component tests only need the lifecycle.
globalThis.IntersectionObserver = class {
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
} as typeof IntersectionObserver

// Idle prefetches and feature queries (`CSS.supports`) run on mount.
// jsdom has neither API; idle work never fires and every feature reads as absent.
globalThis.requestIdleCallback ??= () => 0
globalThis.cancelIdleCallback ??= () => undefined
globalThis.CSS ??= { escape: (value: string) => value, supports: () => false } as unknown as typeof CSS

if ('Element' in globalThis) {
  Element.prototype.scrollTo ??= () => undefined

  // React 19 + Testing Library 16: opt into the act environment so render(),
  // fireEvent(), and findBy* queries automatically flush state updates without
  // spurious "not wrapped in act(...)" warnings.
}

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// findBy*/waitFor default to a 1000ms deadline — too tight for async-heavy
// panels (radix menus, refetch chains) when the full suite runs under xdist
// CPU contention in CI. Success still resolves the instant the node appears;
// the wider deadline only absorbs a starved runner, killing timing flakes.
// 5s proved insufficient on saturated runners (2026-08-31: gateway-settings,
// messaging, session-unread-tile, toolset-config-panel each tripped a
// waitFor(mock-called) deadline on runs whose only common factor was load —
// including a plugins-only commit on main). 12s mirrors the same reasoning
// as the 15s testTimeout above it while still finishing below it, so a
// genuinely hung await still surfaces as this assertion, not a test timeout.
configure({ asyncUtilTimeout: 12_000 })

// The app hoists ONE `TooltipProvider` to its root (main.tsx). Stock Radix throws
// "`Tooltip` must be used within `TooltipProvider`" with no ancestor — the fork's
// own `Tip` used to carry a private fallback provider, which is why isolated
// renders never needed one before. Mock the library once here instead of wrapping
// ~478 `render()` call sites: compose our provider around whatever `wrapper` a
// test already passes.
vi.mock('@testing-library/react', async (importOriginal: () => Promise<typeof RtlModule>) => {
  const actual = await importOriginal()
  const React = await import('react')
  const { TooltipProvider } = await import('./src/components/ui/tooltip')

  type Wrapper = React.ComponentType<{ children?: React.ReactNode }>

  const withProviders = (inner?: Wrapper): Wrapper =>
    function Providers({ children }) {
      const nested = inner ? React.createElement(inner, null, children) : (children as React.ReactElement)

      return React.createElement(TooltipProvider, null, nested)
    }

  return {
    ...actual,
    render: ((ui: React.ReactElement, options?: RenderOptions): RenderResult =>
      actual.render(ui, {
        ...options,
        wrapper: withProviders(options?.wrapper as Wrapper | undefined)
      })) as typeof actual.render,
    renderHook: ((callback: () => unknown, options?: RenderOptions) =>
      actual.renderHook(callback as never, {
        ...options,
        wrapper: withProviders(options?.wrapper as Wrapper | undefined)
      })) as typeof actual.renderHook
  }
})

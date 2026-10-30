import { type RefObject, useCallback, useLayoutEffect, useState } from 'react'

import { TITLEBAR_CHROME_CHANGED_EVENT } from '@/app/shell/titlebar'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { $connection } from '@/store/session'

/** The window-chrome inputs that move the fixed titlebar clusters without
 *  changing their size (macOS fullscreen hides the traffic lights → the left
 *  cluster pins to the window edge). */
function chromeKey(): string {
  const connection = $connection.get()
  const position = connection?.windowButtonPosition

  return `${connection?.isFullscreen ? 1 : 0}:${position?.x ?? ''}:${position?.y ?? ''}`
}

/** Where the fixed window-chrome clusters cover THIS zone, in px from its own
 *  edges — plus whether the strip has to drop below them. `null` until
 *  measured: the band then reserves its whole slot (the spacers' own safe
 *  default in tree-group.tsx) instead of painting a title under the traffic
 *  lights.
 *
 *  RETURNED, never written onto the zone element: a top-edge band is PORTALED
 *  out of the zone into the window's own row (app-top-bar.tsx), where a custom
 *  property set on the zone no longer inherits — the spacers fell back to
 *  `100%` and pushed every drag surface in the band out of its slot. */
export interface PanelTitlebarReservation {
  belowControls: boolean
  left: null | number
  right: null | number
}

/** Reserve actual chrome intersections, including after a neighbor becomes a rail. */
export function usePanelTitlebar(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  minimized: boolean
): PanelTitlebarReservation {
  const [reservation, setReservation] = useState<{ left: number; right: number } | null>(null)
  const [belowControls, setBelowControls] = useState(true)

  const measure = useCallback(() => {
    const element = ref.current

    if (!enabled || !element) {
      return
    }

    const rect = element.getBoundingClientRect()

    if (!rect.width) {
      return
    }

    const leftControls = document.querySelector<HTMLElement>('[data-titlebar-cluster="left"]')?.getBoundingClientRect()

    const rightControls = document
      .querySelector<HTMLElement>('[data-titlebar-cluster="right"]')
      ?.getBoundingClientRect()

    // Empty chrome during a route overlay retains the last safe reservation.
    if (!leftControls || !rightControls) {
      return
    }

    const left = Math.min(rect.width, Math.max(0, leftControls.right + 12 - rect.left))
    const right = Math.min(rect.width - left, Math.max(0, rect.right - rightControls.left + 24))
    setReservation(previous => (previous?.left === left && previous.right === right ? previous : { left, right }))
    setBelowControls(minimized || rect.width - left - right < 120)
  }, [enabled, minimized, ref])

  useResizeObserver(measure, ref)
  useLayoutEffect(() => {
    if (!enabled) {
      return
    }

    const observer = new ResizeObserver(measure)

    const observe = () => {
      // Re-query on every chrome change: route switches mount a different
      // cluster set (app clusters vs a page-owned band), and observing the
      // unmounted set would measure nothing.
      observer.disconnect()

      for (const element of document.querySelectorAll('[data-titlebar-cluster], [data-tree-group]')) {
        observer.observe(element)
      }
    }

    const onChromeChanged = () => {
      observe()
      measure()
    }

    observe()
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener(TITLEBAR_CHROME_CHANGED_EVENT, onChromeChanged)

    // A fullscreen transition first fires `resize` (measured against the
    // pre-transition cluster) and only then lands the window-state IPC that
    // translates the fixed clusters — same size, new position — so neither
    // ResizeObserver nor `resize` re-runs. Re-measure after the frame that
    // repaints the clusters from the new chrome vars.
    let lastChrome = chromeKey()
    let frame = 0

    const unsubscribeChrome = $connection.subscribe(() => {
      const nextChrome = chromeKey()

      if (nextChrome === lastChrome) {
        return
      }

      lastChrome = nextChrome
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(measure)
      })
    })

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener(TITLEBAR_CHROME_CHANGED_EVENT, onChromeChanged)
      unsubscribeChrome()
      cancelAnimationFrame(frame)
    }
  }, [enabled, measure])

  return {
    belowControls: enabled && belowControls,
    left: reservation?.left ?? null,
    right: reservation?.right ?? null
  }
}

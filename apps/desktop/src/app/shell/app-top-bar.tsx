import { createContext, useContext, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { TITLEBAR_HEIGHT } from './titlebar'

/**
 * The window's top bar — L1 of the shell: `column[ top bar , row[ rail , A zone ] ]`.
 *
 * It is ONE element spanning the whole window, above the rail as well as above
 * the panes, so the window chrome is a single band and the rail starts under it.
 * A zone on the window's top edge does NOT draw that band itself any more: it
 * renders its own bar (tabs, title, drag handles — all of it, unchanged) through
 * `<BandSlot>`, which places it at the zone's own measured x/width inside this
 * row. Keeping the strip the ZONE's own element is the point: drag-to-stack,
 * per-zone drop targets, the multi-tab selection and the key hints all key off
 * the strip that belongs to that zone, and collapsing every zone into one shared
 * strip would quietly drop them.
 *
 * With no bar on screen (the HUD, a popped-out browser window, an isolated test
 * render) `<BandSlot>` renders inline — the zone's own layout, exactly as before.
 */

const BandRowContext = createContext<HTMLDivElement | null>(null)

/** The row a zone's band should mount into. `null` → render in place. */
export function useBandRowTarget(): HTMLDivElement | null {
  return useContext(BandRowContext)
}

export function AppTopBar({ children }: { children?: React.ReactNode }) {
  const [row, setRow] = useState<HTMLDivElement | null>(null)

  return (
    <BandRowContext.Provider value={row}>
      <div
        className="relative flex shrink-0 items-stretch bg-(--ui-region-chrome)"
        data-slot="app-top-bar"
        style={{ height: `var(${BAND_HEIGHT_VAR}, ${APP_BAND_FALLBACK_HEIGHT}px)` }}
      >
        <div className="relative flex min-w-0 flex-1 items-stretch" data-slot="app-band-row" ref={setRow} />
        {/* Window-drag area as MARGINS, never as the row itself: a drag region
            wins hit-testing over the DOM inside it (the codebase has been bitten
            by this before — see the sidebar's no-drag carve-out and
            browser-popout-shell.tsx, which builds its strips AROUND the titlebar
            clusters for exactly this reason). A row-wide `drag` put the whole bar
            — the tool buttons sitting over it included — inside the drag region,
            and their clicks stopped arriving. The strips cover only what no
            cluster occupies; bands bring their own drag patches. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 w-(--titlebar-controls-left,0.75rem) [-webkit-app-region:drag]"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-(--titlebar-tools-right,0.75rem) [-webkit-app-region:drag]"
        />
      </div>
      {children}
    </BandRowContext.Provider>
  )
}

/**
 * A zone's band, rendered where the window wants it. `box` is that zone's own
 * rect (measured by the zone, which re-measures on every resize frame), so a
 * split's sash drag moves the strip with its zone without anyone re-deriving the
 * layout tree's arithmetic here.
 */
export function BandSlot({
  box,
  children,
  enabled = true
}: {
  box: null | { left: number; width: number }
  children: React.ReactNode
  enabled?: boolean
}) {
  const row = useBandRowTarget()

  if (!enabled || !row) {
    // No bar: the band stays in the zone's own flow. Every window that does not
    // run the app shell (HUD, browser popout) and every isolated render takes
    // this path, so a zone's band is never silently missing.
    return <>{children}</>
  }

  if (!box) {
    // Measured on the first frame only — an unplaced band would flash at x=0.
    return null
  }

  return createPortal(
    // `overflow-hidden` is the zone's own clip, restored: a band carries window-level
    // spacers (`--panel-titlebar-left/right`), so its content can be ~28px wider than
    // the zone's slot. Inside a zone the zone clipped it; mounted in this row it would
    // spill into the neighbouring slot.
    <div className="absolute inset-y-0 flex items-stretch overflow-hidden" style={{ left: box.left, width: box.width }}>
      {children}
    </div>,
    row
  )
}

/** The band row's own height, published by a zone that drew a full band. The bar
 *  reads it so a strip that has to drop BELOW the window controls grows the whole
 *  row (and the zones below shrink) instead of overflowing the bar. */
export const BAND_HEIGHT_VAR = '--app-band-height'

/** Height of the window's top row when no zone claimed it: one titlebar band. */
export const APP_BAND_FALLBACK_HEIGHT = TITLEBAR_HEIGHT + 10

const bandHeights = new Map<string, number>()

export function publishBandHeight(height: number | undefined, owner: string): void {
  const root = document.documentElement

  if (height) {
    bandHeights.set(owner, height)
  } else {
    bandHeights.delete(owner)
  }

  if (bandHeights.size) {
    root.style.setProperty(BAND_HEIGHT_VAR, `${Math.max(...bandHeights.values())}px`)
  } else {
    root.style.removeProperty(BAND_HEIGHT_VAR)
  }
}

/** Re-measure a band host on the next frame — sash drags rewrite geometry per
 *  frame, and a ResizeObserver only fires when the box actually changes. */
export function useBandBox(
  ref: React.RefObject<HTMLElement | null>,
  enabled: boolean
): null | { left: number; width: number } {
  const [box, setBox] = useState<null | { left: number; width: number }>(null)

  useEffect(() => {
    if (!enabled) {
      setBox(null)

      return
    }

    const el = ref.current

    if (!el) {
      return
    }

    const measure = () => {
      const rect = el.getBoundingClientRect()

      setBox(prev =>
        prev && prev.left === rect.left && prev.width === rect.width ? prev : { left: rect.left, width: rect.width }
      )
    }

    measure()

    const observer = new ResizeObserver(measure)

    observer.observe(el)
    window.addEventListener('resize', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [enabled, ref])

  return box
}

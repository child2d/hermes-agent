import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import {
  chatSurfaceRoot,
  clearSurfaceVar,
  COMPOSER_HEIGHT_VAR,
  COMPOSER_SURFACE_HEIGHT_VAR,
  setSurfaceVar
} from '@/app/chat/surface-vars'
import { useResizeObserver } from '@/hooks/use-resize-observer'

import {
  COMPOSER_COMPACT_PILL_PX,
  COMPOSER_FOLD_VOICE_PX,
  COMPOSER_MINIMAL_PX,
  COMPOSER_STACK_BREAKPOINT_PX
} from '../composer-utils'

interface UseComposerMetricsArgs {
  composerDockRef: RefObject<HTMLDivElement | null>
  composerRef: RefObject<HTMLFormElement | null>
  composerSurfaceRef: RefObject<HTMLDivElement | null>
  editorRef: RefObject<HTMLDivElement | null>
  poppedOut: boolean
}

/** Every width-driven collapse stage, resolved from the composer's own width. */
export interface ComposerFit {
  compactPill: boolean
  foldVoice: boolean
  minimal: boolean
  tight: boolean
}

const ROOMY: ComposerFit = { compactPill: false, foldVoice: false, minimal: false, tight: false }

const fitForWidth = (width: number): ComposerFit => ({
  compactPill: width < COMPOSER_COMPACT_PILL_PX,
  foldVoice: width < COMPOSER_FOLD_VOICE_PX,
  minimal: width < COMPOSER_MINIMAL_PX,
  tight: width < COMPOSER_STACK_BREAKPOINT_PX
})

const sameFit = (a: ComposerFit, b: ComposerFit) =>
  a.compactPill === b.compactPill && a.foldVoice === b.foldVoice && a.minimal === b.minimal && a.tight === b.tight

/**
 * Owns the composer's *sizing* engine: the width-driven control ladder and the
 * measured-height CSS vars the thread reads for bottom clearance. All work is
 * edge-gated — the ResizeObserver only fires on real size changes, the height
 * vars are 8px-bucketed so per-keystroke growth never invalidates the tree's
 * computed style, and the fit only re-renders when it crosses a stage.
 *
 * There is no stacked-vs-inline decision to make here: the composer's row
 * layout is fixed (input on its own row, controls below), so the only thing the
 * measured width still decides is how much of the control cluster survives.
 */
export function useComposerMetrics({
  composerDockRef,
  composerRef,
  composerSurfaceRef,
  editorRef,
  poppedOut
}: UseComposerMetricsArgs): ComposerFit {
  const [fit, setFit] = useState<ComposerFit>(ROOMY)

  // Bucket measured heights so we only invalidate the global CSS var when
  // the size crosses a meaningful threshold. Without bucketing, the editor
  // grows ~1px per character → setProperty fires every keystroke → entire
  // tree's computed style is invalidated → next paint forces a full
  // recalculate-style pass. With an 8px bucket, the invalidation rate drops
  // ~8× and small char-by-char typing produces no style invalidation at all
  // until a wrap or row change actually happens.
  const lastBucketedHeightRef = useRef(0)
  const lastBucketedSurfaceHeightRef = useRef(0)
  const lastFitRef = useRef(ROOMY)
  // Mirrored into a ref so `syncComposerMetrics` stays referentially stable —
  // it's the shared ResizeObserver's handler, and a new identity every render
  // would re-register the observation.
  const poppedOutRef = useRef(poppedOut)
  poppedOutRef.current = poppedOut

  const syncComposerMetrics = useCallback(() => {
    const composer = composerRef.current
    // The dock is the full docked footprint — strips, status stack, composer —
    // so it, not the composer alone, is what the thread has to clear.
    const dock = composerDockRef.current

    if (!composer || !dock) {
      return
    }

    const { height } = dock.getBoundingClientRect()
    const { width } = composer.getBoundingClientRect()
    const surfaceHeight = composerSurfaceRef.current?.getBoundingClientRect().height

    if (width > 0) {
      const nextFit = fitForWidth(width)

      if (!sameFit(nextFit, lastFitRef.current)) {
        lastFitRef.current = nextFit
        setFit(nextFit)
      }
    }

    // Floats still need their width-driven controls, but no pane reserves
    // bottom clearance while the shared composer is detached.
    if (poppedOutRef.current) {
      lastBucketedHeightRef.current = 0
      lastBucketedSurfaceHeightRef.current = 0
      setSurfaceVar(composer, COMPOSER_HEIGHT_VAR, '0px')
      setSurfaceVar(composer, COMPOSER_SURFACE_HEIGHT_VAR, '0px')

      return
    }

    if (height > 0) {
      const bucket = Math.round(height / 8) * 8

      if (bucket !== lastBucketedHeightRef.current) {
        lastBucketedHeightRef.current = bucket
        setSurfaceVar(composer, COMPOSER_HEIGHT_VAR, `${bucket}px`)
      }
    }

    if (surfaceHeight && surfaceHeight > 0) {
      const bucket = Math.round(surfaceHeight / 8) * 8

      if (bucket !== lastBucketedSurfaceHeightRef.current) {
        lastBucketedSurfaceHeightRef.current = bucket
        setSurfaceVar(composer, COMPOSER_SURFACE_HEIGHT_VAR, `${bucket}px`)
      }
    }
  }, [composerDockRef, composerRef, composerSurfaceRef])

  useResizeObserver(syncComposerMetrics, composerDockRef, composerRef, composerSurfaceRef, editorRef)

  // Toggling pop-out changes whether the composer reserves thread clearance.
  // The ResizeObserver may not fire (the box can keep the same box size), so
  // re-sync explicitly: docked republishes the measured height, floating zeroes
  // it so the thread reclaims the bottom space.
  useEffect(() => {
    syncComposerMetrics()
  }, [poppedOut, syncComposerMetrics])

  // eslint-disable-next-line no-restricted-syntax -- resets a publish-dedupe cache in cleanup, not a mirrored atom
  useEffect(() => {
    // Resolve the owning surface while the composer is still attached; the
    // unmount cleanup runs after React detached the node, where closest() can
    // no longer find [data-chat-surface].
    const root = chatSurfaceRoot(composerRef.current)

    return () => {
      clearSurfaceVar(root, COMPOSER_HEIGHT_VAR)
      clearSurfaceVar(root, COMPOSER_SURFACE_HEIGHT_VAR)
      // The bucket refs mirror what is published, so clearing the vars must
      // clear them too. This cleanup also runs on a non-final unmount (a
      // StrictMode effect replay, a Suspense hide); the re-mount then
      // re-measures the same dock, and with the refs still holding the old
      // bucket the unchanged-skip check swallowed the republish. The thread
      // fell back to the :root estimate (~62px) under a dock that could be
      // 200px tall, and the status stack sat on top of the last turn until a
      // real resize happened to fire.
      lastBucketedHeightRef.current = 0
      lastBucketedSurfaceHeightRef.current = 0
    }
  }, [composerRef])

  // Every decision comes from the composer's OWN measured width, never the
  // viewport's. There used to be a `(max-width: 30rem)` media query in here as
  // well, and it quietly outranked everything: any window under 480px stacked
  // the row AND compacted the pill in the same instant, regardless of how much
  // room the composer actually had. That collapsed the whole progressive ladder
  // into one step for small windows — HUD mode is ~470px, so it never saw the
  // ladder at all — and it disagreed with the measured breakpoints (320 to
  // stack) by 160px. The ResizeObserver knows the real width; the viewport is
  // not a proxy for it.
  //
  // The ladder is monotonic: each stage implies the ones above it, so the pill
  // is always compact by the time the pane is too narrow for the cluster, and
  // the voice controls are always folded before minimal drops them.
  return {
    compactPill: fit.compactPill || fit.tight,
    foldVoice: fit.foldVoice || fit.minimal,
    minimal: fit.minimal,
    tight: fit.tight
  }
}

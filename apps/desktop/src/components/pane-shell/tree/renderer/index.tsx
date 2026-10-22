/**
 * Layout tree renderer (root).
 *
 * - `split` -> flex row/column; 1px seams between siblings double as resize
 *   sashes (the seam IS the boundary — junction-owned, never doubled). See
 *   tree-split.tsx.
 * - `group` -> a ZONE: header strip (tabs when stacked, minimize chevron) +
 *   the active pane's content, resolved from the contribution registry
 *   (`area: 'panes'`). Empty zones exist only in editor-authored trees. See
 *   tree-group.tsx.
 *
 * Dragging is FancyZones-style (drag-session.ts): the LAYOUT STAYS FIXED and
 * every zone lights up as a whole-region drop target; dropping moves the pane
 * into that zone (joining its tab stack). Structure changes (splitting/merging/
 * resizing zones) belong to the zone editor, not the drag.
 *
 * This file owns only the composition: the recursive tree, the narrow-viewport
 * overlays, the edit palette, and the zone editor. The pieces live in sibling
 * modules — track-model (sizing), drag-session (drag), tree-split / tree-group
 * (nodes), layout-picker + edit-bar (edit mode), narrow-overlays.
 */

import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect } from 'react'

import { cn } from '@/lib/utils'

import { useLayoutEditHotkey } from '../../edit-mode'
import { publishWorkspaceGeometry } from '../../geometry'
import { $layoutTree, trackActiveTreeGroup } from '../store'
import { useTabKeyHints } from '../tab-key-hint-state'
import { ZoneEditor } from '../zone-editor'

import { TreeEditBar } from './edit-bar'
import { FloatingPanes } from './floating-panes'
import { KeepAlivePanes } from './keep-alive-panes'
import { NarrowOverlays } from './narrow-overlays'
import { TreeNode } from './tree-node'

export function LayoutTreeRoot({ children, titlebar = false }: { children?: ReactNode; titlebar?: boolean }) {
  const tree = useStore($layoutTree)

  useLayoutEditHotkey(true)
  useTabKeyHints()
  // Track the interacted zone so ⌘W closes the right tab even when nothing is
  // DOM-focused.
  useEffect(trackActiveTreeGroup, [])
  // Publish --workspace-left/right so chrome (titlebar title) aligns to the
  // main pane's geometry in plain CSS.
  useEffect(publishWorkspaceGeometry, [])

  return (
    // THE CARD: the content area owns the geometry (radius + the left/top cast),
    // and its children are just content inside it — so the top-left corner is
    // the SAME corner whether the list column is showing or has folded and the
    // chat spans the whole width. It has to be this box: it starts at the
    // activity bar's right edge and the top bar's lower edge, exactly the two
    // edges the cast lands on. `overflow-hidden` clips whatever pane is leftmost
    // / topmost into the corner; the shadow is the box's own, so it is never
    // clipped by that and needs no clip margin.
    <div
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-tl-2xl',
        '[box-shadow:-0.125rem_0_0.375rem_-0.125rem_var(--ui-panel-cast),0_-0.125rem_0.375rem_-0.125rem_var(--ui-band-cast)]'
      )}
      data-slot="content-card"
    >
      {/* THE SEAM INVARIANT: boundaries are drawn by the tree (one sash
          hairline per seam) — content mounted in a zone must not paint its
          own edge chrome. App components (asides, the shadcn sidebar) carry
          edge borders + inset highlights for the OLD shell's geometry; this
          neutralizes all of them at the zone boundary, for every current and
          future pane, instead of per-pane class surgery. */}
      <style>{`
        [data-tree-group] :is(aside, [data-slot=sidebar]) {
          border-left-width: 0;
          border-right-width: 0;
          box-shadow: none;
        }
        /* Old-shell titlebar BANDS (chat's session header et al size to
           --titlebar-height, which is 0 inside zones): a zero-height band is
           non-functional but still paints its border-b — a stray hairline
           doubling the zone's top seam. Remove the band entirely. */
        [data-tree-group] header[class*="h-(--titlebar-height)"] {
          display: none;
        }

        /* THE FOLD (FLIP): the layout change commits in one frame and the motion
           is pixels only — no flex-basis, so nothing below this split re-lays out
           while it runs. The folding zone keeps the place it had and is clipped
           away from the content side; its neighbours start at their old on-screen
           place and slide home. --zone-fold-shift is the folded zone's width,
           published by the split that runs the animation. */
        @keyframes zone-fold-hide {
          from { clip-path: inset(0 0 0 0); }
          to { clip-path: inset(0 100% 0 0); }
        }
        @keyframes zone-fold-show {
          from { clip-path: inset(0 100% 0 0); }
          to { clip-path: inset(0 0 0 0); }
        }
        /* HALF the folded width, not all of it: a neighbour beside the folded
           zone keeps its far edge and grows into the freed space, so its CONTENT
           (centred, capped width) only travels half as far as that edge — and it
           is the content a transform must reproduce. The neighbour's own fill
           ends up 118px short for the length of the animation, which the clipped
           zone above it hides; by the time that zone has been clipped away, the
           fill has arrived. */
        @keyframes zone-fold-neighbors {
          from { transform: translateX(calc(var(--zone-fold-shift, 0px) / 2)); }
          to { transform: none; }
        }
        @keyframes zone-unfold-neighbors {
          from { transform: translateX(calc(var(--zone-fold-shift, 0px) / -2)); }
          to { transform: none; }
        }

        /* The content area's cast is the CARD's own box-shadow now (see the
           root div below) — one box, so it follows the corner and stays put
           when the list column folds and the chat takes the whole width. The
           per-zone stencils this replaced are gone with it: a straight strip
           ran across the rounded corner, and the per-zone version had to be
           keyed on which pane happened to be leftmost. */
      `}</style>
      <KeepAlivePanes>
        {tree && (
          <TreeNode
            leftEdge={titlebar}
            node={tree}
            rightEdge={titlebar}
            root
            rootRow={tree.type === 'split' && tree.orientation === 'row'}
            topEdge={titlebar}
          />
        )}
        {tree && <NarrowOverlays />}
      </KeepAlivePanes>
      {/* The top bar's lower edge is NOT drawn here any more. One window-wide
          strip ran straight past the session panel's rounded corner instead of
          bending with it (the strip crossed the corner's notch while the panel's
          curve sat below it). Each top-row zone now casts it from its own box —
          see the cast rule in the <style> above, which takes the panel's own
          radius. Nothing else in this file depended on the strip. */}
      {tree && (
        <>
          {/* Non-tiling panes: fixed cards above the tree, outside every zone. */}
          <FloatingPanes />
          <TreeEditBar />
          <ZoneEditor />
          {children}
        </>
      )}
    </div>
  )
}

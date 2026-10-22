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
    <div className="relative flex min-h-0 min-w-0 flex-1">
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

        /* THE ZONE CAST: the top bar's handoff is cast by each TOP-ROW zone's own
           box, not by one window-wide strip. A strip is a straight rectangle, so
           it ran across the session panel's rounded corner — the notch and the
           curve disagreed. A box-shadow belongs to its box and therefore follows
           its border-radius (the panel's radius is applied below, where a list
           column is what the zone holds). overflow:clip plus a clip margin keeps
           the pane content clipped exactly as overflow:hidden did, while letting
           this cast reach the bar above. */
        [data-tree-group]:is([data-window-top], :has([data-slot='list-column'])) {
          overflow: clip;
          overflow-clip-margin: 0.5rem;
        }
        [data-tree-group][data-window-top]::after {
          content: '';
          position: absolute;
          inset: 0;
          z-index: 20;
          pointer-events: none;
          box-shadow: 0 -0.125rem 0.375rem -0.125rem var(--ui-band-cast);
        }
        /* The panel's RAIL-side half of the same cast. The rail used to paint it
           as a straight strip down its own edge, which read as a hairline and
           died at the panel's corner; cast by the panel's box it is the same
           falloff and it bends into the corner, because the box does. */
        [data-tree-group]:has([data-slot='list-column'])::before {
          content: '';
          position: absolute;
          inset: 0;
          z-index: 20;
          pointer-events: none;
          border-top-left-radius: calc(var(--radius-scalar) * 1.5rem);
          box-shadow: -0.125rem 0 0.375rem -0.125rem var(--ui-panel-cast);
        }
        [data-tree-group][data-window-top]:has([data-slot='list-column'])::after {
          border-top-left-radius: calc(var(--radius-scalar) * 1.5rem);
        }
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

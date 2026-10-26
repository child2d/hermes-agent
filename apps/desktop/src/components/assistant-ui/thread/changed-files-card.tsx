import { useStore } from '@nanostores/react'
import { type FC, useMemo } from 'react'

import { useComposerScope } from '@/app/chat/composer/scope'
import { useSessionView } from '@/app/chat/session-view'
import { deriveChangedFiles } from '@/components/assistant-ui/thread/changed-files'
import { WIDGET_SHELL_CLASS } from '@/components/chat/widget-shell'
import { DiffCount } from '@/components/ui/diff-count'
import { FadeScroll } from '@/components/ui/fade-scroll'
import { FileTypeIcon } from '@/components/ui/file-type-icon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { displayPath } from '@/lib/display-path'
import { cn } from '@/lib/utils'
import { openReviewForPath, revealReview } from '@/store/review'

// ~5 rows. A turn that rewrites twenty files should still read as one card in
// the transcript, not a wall the user has to scroll past to reach the composer.
const MAX_ROWS_HEIGHT = '9.375rem'

/**
 * Cursor-style "N files changed" summary closing out the newest assistant turn:
 * one row per file it edited with that file's +/-, and a Review action opening
 * the diff pane (⌘G). A row click opens that file's diff directly.
 *
 * Wears the shared `WIDGET_SHELL_CLASS` so it reads as the same panel as the
 * transcript's other inline widgets rather than inventing its own chrome.
 */
export const ChangedFilesCard: FC<{ parts: readonly unknown[] }> = ({ parts }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const files = useMemo(() => deriveChangedFiles(parts), [parts])
  // Review THIS surface's repo: a tile transcript pins the pane to the tile's
  // worktree; the primary passes null (follow the active session, as before).
  const view = useSessionView()
  const viewCwd = useStore(view.$cwd)
  const scopeCwd = view.kind === 'primary' ? null : viewCwd || null
  const composerScope = useComposerScope()

  if (files.length === 0) {
    return null
  }

  return (
    <div
      className={cn(
        WIDGET_SHELL_CLASS,
        // The message's own gutter: every block of a turn — prose, tools, todos,
        // the timestamp row (`px-(--message-text-indent)`) — shares this indent,
        // and a root-level card pinned to the content edge instead overhung the
        // text column by exactly that 12px (measured: card box 402 vs prose 414
        // at a 402-wide content edge).
        'ml-(--message-text-indent)',
        // The one transcript widget that overrides the shared fill: this card is
        // the turn's working-tree report, and on the widget token (near-white on
        // a near-white transcript) it read as rows floating in the prose. A
        // slate-100 block makes it a surface in its own right, still light enough
        // to sit in the transcript.
        //
        // Both modes ride the app's OWN region rung rather than a shared token:
        // slate-100 sits 1.9 L* under the light transcript (gray-50) and
        // slate-900 9.0 L* over the dark one (gray-950) — the same pair of steps
        // the app's panel rung uses (gray-100 / gray-900), so the card stays in
        // the ladder in either mode. slate-800 was the alternative and lands 17.4
        // L* up, i.e. at the window-chrome rung — too loud for a card.
        'mt-1.5 bg-slate-100 text-[length:var(--conversation-tool-font-size)] dark:bg-slate-900'
      )}
      data-slot="aui_changed-files"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-(--ui-text-primary)">{copy.filesChanged(files.length)}</span>
        <button
          className="shrink-0 cursor-pointer text-(--ui-text-tertiary) transition-colors hover:text-(--ui-text-primary)"
          onClick={() => revealReview(scopeCwd, composerScope.target)}
          type="button"
        >
          {copy.reviewChanges}
        </button>
      </div>
      <FadeScroll className="-mx-1.5 mt-1.5 flex flex-col overscroll-y-auto px-1.5" maxHeight={MAX_ROWS_HEIGHT}>
        {files.map(file => (
          <Tooltip><TooltipTrigger asChild>
            <button
              className="row-hover flex shrink-0 items-center gap-2 rounded-md px-1.5 py-1 text-left"
              onClick={() => void openReviewForPath(file.path, scopeCwd, composerScope.target)}
              type="button"
            >
              <FileTypeIcon className="shrink-0 text-(--ui-text-tertiary)" path={file.path} size="0.875rem" />
              <span className="min-w-0 flex-1 truncate text-(--ui-text-secondary)">{file.name}</span>
              <DiffCount added={file.added} removed={file.removed} />
            </button>
          </TooltipTrigger><TooltipContent>{displayPath(file.path)}</TooltipContent></Tooltip>
        ))}
      </FadeScroll>
    </div>
  )
}

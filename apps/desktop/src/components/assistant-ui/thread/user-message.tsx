import { ActionBarPrimitive, BranchPickerPrimitive, MessagePrimitive, useAuiState } from '@assistant-ui/react'
import { type FC, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { DirectiveContent } from '@/components/assistant-ui/directive-text'
import { isAttachmentRef } from '@/components/assistant-ui/reference-kinds'
import {
  messageAttachmentRefs,
  messageContentText,
  PROCESS_NOTIFICATION_RE
} from '@/components/assistant-ui/thread/content'
import { MessageHoverTime } from '@/components/assistant-ui/thread/message-hover-time'
import { ReactionBadge, ReactionPicker } from '@/components/assistant-ui/thread/message-reactions'
import { BackgroundResult } from '@/components/assistant-ui/thread/system-message'
import { MessageTimelineTimestamp } from '@/components/assistant-ui/thread/timeline-timestamp'
import { useMessageReactions } from '@/components/assistant-ui/thread/use-message-reactions'
import { UserMessageText } from '@/components/assistant-ui/thread/user-message-text'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Pencil, StopFilled } from '@/lib/icons'
import { LruCache } from '@/lib/lru-cache'
import { cn } from '@/lib/utils'
import { $gateway } from '@/store/gateway'
import { notifyThreadEditOpen } from '@/store/thread-scroll'
import { isWatchWindow } from '@/store/windows'

/** True when the user has a live text highlight (drag-select / triple-click). */
export function hasTextSelection(): boolean {
  const selection = window.getSelection()

  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0)
}

export function HumanMessageContainer({
  attachments,
  children,
  messageId
}: {
  attachments?: ReactNode
  children: ReactNode
  messageId?: string
}) {
  return (
    // Two flow siblings, no wrapper element: a wrapping div would become the
    // bubble's containing block for anything positioned inside it. The bubble
    // and its attachments simply follow each other down the page — nothing in
    // the transcript is pinned, so there is no sticky box to clip behind.
    <>
      <div
        className="group/user-message -mx-4 flex w-[calc(100%+2rem)] min-w-0 max-w-none flex-col items-end gap-0 self-end overflow-visible px-4 pb-(--conversation-turn-gap) pt-1"
        data-message-id={messageId}
        data-role="user"
        data-slot="aui_user-message-root"
      >
        {children}
      </div>
      {attachments}
    </>
  )
}

// Shared "user bubble" base. The read-only message and the inline edit
// composer draw the same bubble geometry, but not the same surface: the message
// is the inverted card (w-fit, --dt-user-bubble fill, --dt-user-bubble-foreground
// ink), while the drawer overrides all three with w-full / --composer-fill /
// foreground ink (see its call site). Everything else — radius, padding, the
// text metrics — comes from here.
//
// Inverted on purpose (--dt-user-bubble = the theme foreground): your turn is
// a filled bubble with the chat surface as its ink, against an agent reply
// that paints no surface at all — the one distinction in the transcript that
// cannot be missed. `w-fit` lets it hug a two-word prompt and still take the
// full column for a paragraph. Padding stays SYMMETRIC (px-3.5 both sides):
// the old right-hand gutter reserved room for the hover actions, and those now
// live on their own row under the bubble — a wider right pad would only read as
// a lopsided bubble.
//
// no-drag: scrolled up, the bubble passes under the titlebar's
// [-webkit-app-region:drag] strips (app-shell.tsx). Electron resolves drag
// regions at the compositor level — z-index and pointer-events don't help — so
// without the carve-out, clicking or selecting text in a bubble parked up there
// drags the window instead.
export const USER_BUBBLE_BASE_CLASS =
  'composer-human-message relative flex w-fit min-w-0 max-w-full flex-col gap-1.5 overflow-y-auto rounded-xl bg-(--dt-user-bubble) px-3.5 py-2.5 text-left text-(--dt-user-bubble-foreground) [-webkit-app-region:no-drag]'

// Message actions are shadcn Buttons (`variant="ghost" size="icon"`) that paint
// as bare glyphs: the presentation is owned by the shared message-action spec in
// styles.css ([data-slot='aui_msg-actions'] / [data-slot='aui_user-actions'], and
// the edit drawer's own bubble), so no call site carries box styling of its own.
export const StopGlyph = <StopFilled aria-hidden className="size-3.5 -translate-y-px" />

// Agent-to-agent deliveries ("Message from 🤖 <sender>: …", the Bot Mode /
// multi-profile convention; optional "(@<handle>)" carries the sender's
// profile name for avatar resolution — a relayed sender is re-stamped
// "(@<handle>@<connection>)" so a reply reaches the right machine (#103731);
// legacy "[Message from agent '<sender>'] …" too). They arrive on the user
// role because the recipient's turn runs on it, but they are NOT the human
// speaking — render them as a compact attributed timeline notice instead of
// a user bubble.
export const AGENT_MESSAGE_RE =
  /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})(?:@[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u

// sender handle -> avatar data URL. Module-level so a chat full of notices
// from one bot resolves once. Bounded LRU: handles are parsed out of message
// text (unbounded distinct senders over a long session list) and hits hold
// base64 avatar data URLs, so an unbounded map pins image bytes for the
// window's lifetime. Eviction only costs a refetch.
// Misses expire after 30s — an avatar can appear at any moment (bot just
// created, art backfill still running), and a permanent negative cache
// froze the 🤖 glyph until an app restart.
const AGENT_AVATAR_CACHE_MAX = 128
export const agentAvatarCache = new LruCache<string, { at: number; url: null | string }>(AGENT_AVATAR_CACHE_MAX)
const AVATAR_MISS_TTL_MS = 30_000
const agentAvatarInflight = new Map<string, Promise<null | string>>()

export async function resolveAgentAvatar(handle: string): Promise<null | string> {
  const key = handle.trim().toLowerCase()

  if (!key) {
    return null
  }

  const hit = agentAvatarCache.get(key)

  if (hit) {
    if (hit.url !== null) {
      return hit.url
    }

    // Negative entry: honor it only within the TTL, then re-probe.
    if (Date.now() - hit.at < AVATAR_MISS_TTL_MS) {
      return null
    }
  }

  const inflight = agentAvatarInflight.get(key)

  if (inflight) {
    return inflight
  }

  const run = (async (): Promise<null | string> => {
    try {
      const gateway = $gateway.get()

      if (!gateway) {
        return null
      }

      const res = await gateway.request<{ profiles?: Array<{ has_avatar?: boolean; name: string }> }>('profiles.list', {
        include_sessions: false
      })

      const profiles = res?.profiles ?? []
      let profile = profiles.find(p => p.name.toLowerCase() === key)

      // 'hermes' is the conventional alias for the primary profile.
      if (!profile && key === 'hermes') {
        profile = profiles.find(p => p.name === 'default')
      }

      if (!profile?.has_avatar) {
        return null
      }

      const asset = await gateway.request<{ data?: string; found?: boolean }>('profiles.get_asset', {
        asset: 'avatar',
        name: profile.name
      })

      return asset?.found && asset.data ? asset.data : null
    } catch {
      // Older gateway (no profiles.* RPCs) or transient failure — the 🤖
      // glyph fallback is always correct.
      return null
    } finally {
      agentAvatarInflight.delete(key)
    }
  })()

  agentAvatarInflight.set(key, run)
  const out = await run
  agentAvatarCache.set(key, { at: Date.now(), url: out })

  return out
}

const AgentMessageNote: FC<{ text: string }> = ({ text }) => {
  const match = AGENT_MESSAGE_RE.exec(text)
  const sender = (match?.[1] || match?.[3] || 'agent').trim()
  const handle = (match?.[2] || match?.[3] || sender).trim()
  const body = (match?.[4] || '').trim()
  const [avatar, setAvatar] = useState<null | string>(() => agentAvatarCache.get(handle.toLowerCase())?.url ?? null)

  useEffect(() => {
    let live = true

    void resolveAgentAvatar(handle).then(url => {
      if (live && url) {
        setAvatar(url)
      }
    })

    return () => {
      live = false
    }
  }, [handle])

  // Grok-bots shape: an inter-agent delivery is a timeline EVENT, not a
  // conversation bubble — a subtle centered notice ("Message from 🤖 X"),
  // with the delivered text one click away instead of shouting in the
  // transcript. The recipient's reply below it stays a normal assistant
  // message, so the exchange still reads in order.
  return (
    <div
      className="flex max-w-[min(86%,44rem)] flex-col gap-0.5 self-center px-2 py-0.5 text-2xs leading-5 text-muted-foreground/60"
      data-slot="aui_agent-message-note"
    >
      <span className="flex items-center justify-center gap-1.5">
        {avatar ? (
          <img alt="" aria-hidden className="size-4 shrink-0 rounded-full object-cover" src={avatar} />
        ) : (
          <span aria-hidden className="text-sm leading-none">
            🤖
          </span>
        )}
        <span className="wrap-anywhere">Message from {sender}</span>
      </span>
      {body && (
        <details className="self-center">
          <summary className="cursor-pointer select-none text-center text-muted-foreground/45 hover:text-muted-foreground/70">
            show message
          </summary>
          <div className="mt-1 max-w-[36rem] rounded-lg border border-(--ui-stroke-tertiary) px-3 py-2 text-left text-xs leading-5 text-foreground/85">
            <UserMessageText text={body} />
          </div>
        </details>
      )}
    </div>
  )
}

const ProcessNotificationNote: FC<{ text: string }> = ({ text }) => {
  const body = text.replace(/^\[IMPORTANT:\s*/, '').replace(/\]$/, '')
  const newline = body.indexOf('\n')
  const headline = (newline === -1 ? body : body.slice(0, newline)).trim()
  const detail = newline === -1 ? '' : body.slice(newline + 1).trim()

  return <BackgroundResult process report={detail} text={headline} />
}

/** Your turn. Takes no props: everything it needs comes from the message
 *  context, and the two callbacks it once carried (stop, restore-confirm) lost
 *  their buttons — stopping is the composer's primary control, and rewinding is
 *  the checkpoint row's job. */
export const UserMessage = () => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const messageId = useAuiState(s => s.message.id)
  const content = useAuiState(s => s.message.content)
  const messageText = messageContentText(content)

  const attachmentRefs = useAuiState(s => {
    const custom = (s.message.metadata?.custom ?? {}) as { attachmentRefs?: unknown }

    return messageAttachmentRefs(custom.attachmentRefs)
  })

  const [pickerOpen, setPickerOpen] = useState(false)
  const { enabled: reactionsEnabled, react, reactions: shownReactions } = useMessageReactions(messageId, 'user')

  const pickEmoji = useCallback(
    (emoji: null | string) => {
      setPickerOpen(false)
      react(emoji)
    },
    [react]
  )

  // A long prompt clamps to four lines with a soft fade so it doesn't dominate
  // the viewport while the response streams underneath; nothing lifts it back
  // open (the bubble is inert — see styles.css `.human-msg-clamp`). We measure
  // the *unclamped* inner wrapper so the ResizeObserver only fires on real
  // content / width changes, not on every frame while the outer max-height
  // settles.
  const clampInnerRef = useRef<HTMLDivElement | null>(null)
  const [bodyClamped, setBodyClamped] = useState(false)
  const lastClampHeightRef = useRef(-1)
  const lineHeightRef = useRef(0)

  // Watch windows spectate a subagent run driven elsewhere — prompts can't be
  // edited, restored, or stopped from here. The bubble stays a button that
  // toggles the 2-line clamp so long prompts are still fully readable.
  const readOnly = isWatchWindow()
  const [expanded, setExpanded] = useState(false)
  const clampActive = !(readOnly && expanded)

  const measureClamp = useCallback((entries: readonly ResizeObserverEntry[]) => {
    const inner = clampInnerRef.current
    const outer = inner?.parentElement

    if (!inner || !outer) {
      return
    }

    // Prefer the size the ResizeObserver already computed — reading
    // `scrollHeight` outside RO timing forces a synchronous layout, and with
    // many user bubbles observed at once those reads interleave with the
    // style write below into a read-write-read reflow cascade.
    const entryHeight = entries.find(entry => entry.target === inner)?.borderBoxSize?.[0]?.blockSize
    const fullHeight = Math.ceil(entryHeight ?? inner.scrollHeight)

    if (fullHeight === lastClampHeightRef.current) {
      return
    }

    lastClampHeightRef.current = fullHeight

    // Line-height is stable for the life of the bubble (font settings don't
    // change under it) — resolve the computed style once.
    if (!lineHeightRef.current) {
      const styles = getComputedStyle(inner)
      lineHeightRef.current = parseFloat(styles.lineHeight) || 1.5 * parseFloat(styles.fontSize) || 20
    }

    outer.style.setProperty('--human-msg-full', `${fullHeight}px`)
    setBodyClamped(fullHeight > lineHeightRef.current * 2 + 1)
  }, [])

  useResizeObserver(measureClamp, clampInnerRef)

  // Injected background-process notification, not a human prompt — render the
  // compact system-style notice (after all hooks above have run).
  if (PROCESS_NOTIFICATION_RE.test(messageText.trim())) {
    return (
      <MessagePrimitive.Root
        className="flex w-full min-w-0 flex-col items-stretch"
        data-role="user"
        data-slot="aui_user-message-root"
      >
        <ProcessNotificationNote text={messageText.trim()} />
      </MessagePrimitive.Root>
    )
  }

  // Agent-to-agent delivery, not a human prompt — attributed inter-agent card.
  if (AGENT_MESSAGE_RE.test(messageText.trim())) {
    return (
      <MessagePrimitive.Root
        className="flex w-full min-w-0 flex-col items-stretch pb-(--conversation-turn-gap)"
        data-role="user"
        data-slot="aui_user-message-root"
      >
        <AgentMessageNote text={messageText.trim()} />
      </MessagePrimitive.Root>
    )
  }

  const hasBody = messageText.trim().length > 0
  const chipOnlyTurn = !hasBody && attachmentRefs.length > 0 && attachmentRefs.every(isAttachmentRef)

  // The bubble surface. Not interactive any more (the edit button lives in the
  // row below), so it carries no cursor/hover affordance of its own.
  const bubbleSurface = cn(
    USER_BUBBLE_BASE_CLASS,
    'text-[length:var(--conversation-text-font-size)] leading-(--dt-line-height)'
  )

  const bubbleContent = hasBody ? (
    // Render the user's text through a minimal markdown pipeline:
    // backtick `code` and ``` fenced ``` blocks, with directive chips
    // (`@file:` etc.) still resolved inside the plain-text spans.
    <div
      className={cn(clampActive && 'human-msg-clamp')}
      data-clamped={clampActive && bodyClamped ? 'true' : undefined}
    >
      {/* Match the edit composer's collapsed line box (min-h-[1.25rem]) so
          clicking to edit can't grow the bubble by a sub-pixel and reflow the
          turn 1px. */}
      <div className="min-h-[1.25rem]" ref={clampInnerRef}>
        <UserMessageText className="wrap-anywhere" text={messageText} />
      </div>
    </div>
  ) : (
    // A file-only turn (a bare large paste, a dropped file) has no prose, so
    // its chips ARE the prompt: they fill the bubble rather than leaving it
    // empty above a detached row. Images keep their thumbnail row below.
    chipOnlyTurn && (
      <div className="flex min-h-[1.25rem] flex-wrap gap-1">
        <DirectiveContent text={attachmentRefs.join(' ')} />
      </div>
    )
  )

  return (
    <MessagePrimitive.Root asChild>
      <HumanMessageContainer
        attachments={
          // Attachments live BELOW the bubble, in normal flow, so the bubble's
          // own box stays the message and the refs follow it down the page. No
          // negative margin: -mt-* would pull the row up into the bubble's box.
          // Image refs render as thumbnails, file refs as chips; no border.
          attachmentRefs.length > 0 && !chipOnlyTurn ? (
            <div className="mb-2 ml-auto flex max-w-full flex-wrap justify-end gap-1">
              <DirectiveContent text={attachmentRefs.join(' ')} />
            </div>
          ) : null
        }
        messageId={messageId}
      >
        <ActionBarPrimitive.Root className="relative w-full max-w-full" data-slot="aui_user-bubble-actions">
          <div className="human-message-with-todos-wrapper flex w-full flex-col items-end gap-0">
            <ReactionPicker
              onOpenChange={setPickerOpen}
              onSelect={pickEmoji}
              open={pickerOpen}
              selected={shownReactions.find(reaction => reaction.author === 'user')?.emoji}
            >
              <div
                className="relative w-fit max-w-full"
                // The app context menu skips PLAIN right-clicks here (the
                // attr below) so this handler keeps the picker gesture; a
                // link/image/selection inside the bubble still gets the app
                // menu, and this handler's selection guard keeps ⌘C flows.
                data-context-menu-skip=""
                onContextMenu={
                  // Right-click is the desktop stand-in for iOS touch-and-hold —
                  // but only when there's nothing selected. A live highlight
                  // keeps the native Copy menu (and ⌘C) instead of the picker.
                  readOnly || !reactionsEnabled
                    ? undefined
                    : event => {
                        if (hasTextSelection()) {
                          return
                        }

                        event.preventDefault()
                        setPickerOpen(true)
                      }
                }
              >
                {readOnly ? (
                  // Spectator transcript: expanding a clamped prompt is the only
                  // thing this bubble does — a watch window has no edit button,
                  // so this one keeps its toggle and stays a button.
                  <button
                    aria-expanded={bodyClamped ? expanded : undefined}
                    className={cn(bubbleSurface, bodyClamped ? 'cursor-pointer' : 'cursor-default')}
                    onClick={() => {
                      // Drag-select ends on mouseup→click; don't collapse the
                      // clamp just because the highlight finished.
                      if (hasTextSelection() || !bodyClamped) {
                        return
                      }

                      triggerHaptic('selection')
                      setExpanded(value => !value)
                    }}
                    type="button"
                  >
                    {bubbleContent}
                  </button>
                ) : (
                  // No click-to-edit. The row under the bubble carries the edit
                  // button, so a bubble that ALSO swapped the composer on a stray
                  // click was the same door twice — and it had to fight a live
                  // drag-selection on every attempt to copy text. The bubble is
                  // content now: selectable, right-clickable, nothing more.
                  <div className={bubbleSurface}>{bubbleContent}</div>
                )}
              </div>
            </ReactionPicker>
            {/* Your turn's stamp and actions, under the bubble — the row the
                reference points at: [when it was sent] [copy] [edit]. The
                controls are shadcn Buttons (`variant="ghost" size="icon"`), but
                they PAINT as bare glyphs: the message-action spec in styles.css
                covers this slot and the assistant bar alike, so one row of flat
                icons is the whole transcript's treatment. No tooltips either —
                one spec, no hidden states. Stop is NOT here: the composer's
                primary control already flips to Stop during a turn. */}
            <div
              className="flex w-fit max-w-full items-center justify-end gap-1.5 py-1.5 pr-1.5"
              data-slot="aui_user-actions"
            >
              <MessageHoverTime className="mr-1 px-0.5" plain />
              {hasBody && (
                <CopyButton
                  appearance="icon"
                  buttonSize="icon"
                  buttonVariant="ghost"
                  label={copy.copy}
                  text={messageText}
                  tooltip={false}
                />
              )}
              {!readOnly && hasBody && (
                <ActionBarPrimitive.Edit asChild>
                  <Button
                    // Distinct from the bubble's own "Edit message" name: the
                    // bubble IS the primary trigger, and two controls sharing
                    // one accessible name make either of them ambiguous.
                    aria-label={t.common.edit}
                    onPointerDown={() => notifyThreadEditOpen()}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </ActionBarPrimitive.Edit>
              )}
            </div>
            {/* Below the bubble, same register as the assistant action row:
                same emoji size, same vertical padding, right-aligned to the
                sent bubble. Overlaying the corner read badly in practice. */}
            <ReactionBadge
              className="justify-end gap-1.5 py-1.5 pr-1.5"
              onRetract={() => react(null)}
              reactions={shownReactions}
            />
            <MessageTimelineTimestamp className="self-end pr-1.5" />
            <BranchPickerPrimitive.Root
              className={cn(
                'checkpoint-container flex w-fit items-center gap-1 pb-0 pt-1 pl-1.5 text-xs leading-none text-(--ui-text-tertiary)',
                readOnly && 'hidden'
              )}
              hideWhenSingleBranch
            >
              <span aria-hidden className="checkpoint-icon size-1.5 rounded-full border border-current" />
              <BranchPickerPrimitive.Previous
                className="checkpoint-restore-text rounded-sm bg-transparent px-1 opacity-65 hover:opacity-100 disabled:hidden disabled:cursor-default"
                title={copy.restorePrevious}
              >
                {copy.restoreCheckpoint}
              </BranchPickerPrimitive.Previous>
              <span className="checkpoint-divider opacity-55">
                <BranchPickerPrimitive.Number />/<BranchPickerPrimitive.Count />
              </span>
              <BranchPickerPrimitive.Next
                className="checkpoint-restore-text rounded-sm bg-transparent px-1 opacity-65 hover:opacity-100 disabled:hidden disabled:cursor-default"
                title={copy.restoreNext}
              >
                {copy.goForward}
              </BranchPickerPrimitive.Next>
            </BranchPickerPrimitive.Root>
          </div>
        </ActionBarPrimitive.Root>
      </HumanMessageContainer>
    </MessagePrimitive.Root>
  )
}

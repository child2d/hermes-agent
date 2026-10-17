import {
  MessagePartPrimitive,
  MessagePrimitive,
  type PartState,
  type TextMessagePartProps,
  type ToolCallMessagePartProps,
  useAuiState,
  useMessagePartReasoning,
  useMessagePartText
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import {
  Children,
  type ComponentProps,
  type FC,
  Fragment,
  isValidElement,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { CatalogInstallTool } from '@/components/assistant-ui/catalog-install-tool'
import { ClarifyTool } from '@/components/assistant-ui/clarify'
import { ConnectorExecution, ConnectorTool } from '@/components/assistant-ui/connector-tool'
import { MarkdownText, MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { McpSetupTool } from '@/components/assistant-ui/mcp-setup-tool'
import { AgentDeliveryNotice, deliveryTargetFromCommand } from '@/components/assistant-ui/thread/agent-delivery'
import { TimelineTimestamp } from '@/components/assistant-ui/thread/timeline-timestamp'
import {
  finalTextIndex,
  MIN_FOLDED_PARTS,
  SectionTurnFoldContext
} from '@/components/assistant-ui/thread/turn-process'
import { DelegateTool } from '@/components/assistant-ui/tool/delegate'
import { ToolFallback, ToolGroupSlot } from '@/components/assistant-ui/tool/fallback'
import { parseMaybeObject, toolCallFailed } from '@/components/assistant-ui/tool/fallback-model'
import { formatElapsed, useElapsedSeconds, useMeasuredDuration } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { GeneratedImage } from '@/components/chat/generated-image-result'
import { SCAFFOLD_LABEL_CLASS, SCAFFOLD_META_CLASS, ScaffoldRow } from '@/components/chat/scaffold-row'
import { useOnboardingChatActive } from '@/components/onboarding-chat/assembly'
import { useI18n } from '@/i18n'
import { mcpTargets, toolLabels } from '@/lib/connector-tools'
import { generatedImageFromResult } from '@/lib/generated-images'
import { separateGluedReasoningBlocks } from '@/lib/reasoning-blocks'
import { isTodoToolName } from '@/lib/todos'
import { type CardToolName, isCardTool, isCardToolName } from '@/lib/tool-render-class'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { $reasoningCollapsedByDefault, $showReasoning } from '@/store/reasoning-disclosure'
import { useForcedTextDirection } from '@/store/text-direction'
import { $showToolActivity } from '@/store/tool-activity'
import { $toolDisclosureOpen, setToolDisclosureOpen } from '@/store/tool-view'

type TimelineToolCallProps = ToolCallMessagePartProps & { completedAt?: number; timestamp?: number }

// A call sealed without a result (turn stopped, completion event lost) is
// neither pending nor successful; only the generic row can say so.
const settledWithoutResult = ({ completedAt, result }: TimelineToolCallProps): boolean =>
  result === undefined && completedAt !== undefined

const ImageGenerateTool: FC<TimelineToolCallProps> = props => {
  const { args, completedAt, result, timestamp } = props
  const aspectRatio = typeof args?.aspect_ratio === 'string' ? args.aspect_ratio : undefined

  // The image card owns successful generations. Failed or malformed results
  // still need the normal tool row: it extracts the error text and gives the
  // user an honest, expandable failure rather than silently dropping the call.
  if (settledWithoutResult(props) || (result !== undefined && !generatedImageFromResult(result))) {
    return <ToolFallback {...props} />
  }

  return (
    <div className="mt-1.5">
      <TimelineTimestamp className="mb-0.5 block" completedAt={completedAt} timestamp={timestamp} />
      <GeneratedImage aspectRatio={aspectRatio} result={result} />
    </div>
  )
}

const DelegateToolPart: FC<TimelineToolCallProps> = props => {
  // A call that failed outright dispatched nothing — there are no children to
  // list, only an error. The generic row extracts and expands it properly.
  if (props.isError || settledWithoutResult(props)) {
    return <ToolFallback {...props} />
  }

  return (
    <>
      <TimelineTimestamp className="mb-0.5 block" completedAt={props.completedAt} timestamp={props.timestamp} />
      <DelegateTool args={props.args} result={props.result} toolCallId={props.toolCallId} />
    </>
  )
}

const ClarifyToolPart: FC<TimelineToolCallProps> = props => {
  // Stopped on this question, never answered: history. ClarifyTool reads
  // the session's live clarify request, so a later turn's question would
  // otherwise paint onto this row as a second live card.
  if (settledWithoutResult(props)) {
    return <ToolFallback {...props} />
  }

  return (
    <>
      <TimelineTimestamp className="mb-0.5 block" completedAt={props.completedAt} timestamp={props.timestamp} />
      <ClarifyTool {...props} />
    </>
  )
}

const ConnectionsToolPart: FC<TimelineToolCallProps> = props =>
  mcpTargets(props.toolName, props.args).length > 0 ? <McpSetupTool {...props} /> : <ConnectorTool {...props} />

const TOOL_CARDS: Record<CardToolName, FC<TimelineToolCallProps>> = {
  clarify: ClarifyToolPart,
  delegate_task: DelegateToolPart,
  image_generate: ImageGenerateTool,
  manage_catalog: CatalogInstallTool,
  manage_connections: ConnectionsToolPart
}

// A failure the user still has to see. The gateway's tool.complete carries the
// failure inside `result`, never as the top-level error that sets isError, so
// this reads the body like the run summary does. A non-zero exit_code counts
// too, matching the gateway's _tool_result_needs_user, which forwards terminal
// {output, exit_code: 1, error: null} even with display.tool_progress off.
const failedCallNeedsUser = (part: TimelineToolCallProps): boolean => {
  const exitCode = parseMaybeObject(part.result).exit_code

  return toolCallFailed(part) || (typeof exitCode === 'number' && exitCode !== 0)
}

const ChainToolFallback: FC<TimelineToolCallProps> = props => {
  const showToolActivity = useStore($showToolActivity)

  // todo parts are hoisted to a dedicated panel above the message content.
  if (isTodoToolName(props.toolName)) {
    return null
  }

  // An inter-agent delivery run through the terminal tool renders as the
  // compact "Messaged X" / "Message from X" notices, not a transcript row
  // (Grok-bots parity; the receiving side already renders notices via
  // AGENT_MESSAGE_RE). Non-delivery terminal calls fall through unchanged.
  if (props.toolName === 'terminal' && !props.isError && !settledWithoutResult(props)) {
    const command = typeof props.args?.command === 'string' ? props.args.command : ''

    if (deliveryTargetFromCommand(command)) {
      return <AgentDeliveryNotice {...props} />
    }
  }

  // A reaction's UI is the emoji landing on the bubble (message.reaction
  // event) — a "React To Message" tool block next to it would be the agent
  // narrating its own tapback. Failures still render so they're debuggable.
  if (props.toolName === 'react_to_message' && !props.isError) {
    return null
  }

  if (isCardToolName(props.toolName)) {
    const ToolCard = TOOL_CARDS[props.toolName]

    return <ToolCard {...props} />
  }

  if (toolLabels(props.args).length > 0) {
    return <ConnectorExecution {...props} />
  }

  // The tool feed (reads, searches, commands) follows display.tool_progress,
  // never show_reasoning. Cards, approvals, and failed calls the user must act
  // on remain regardless.
  if (!showToolActivity && !failedCallNeedsUser(props) && !isCardTool(props.toolName)) {
    return null
  }

  return <ToolFallback {...props} />
}

// Match the compact terminal/log viewers rather than the full thread's slack.
const PREVIEW_RELOCK_THRESHOLD_PX = 24

type TimelineTextPartProps = TextMessagePartProps & { completedAt?: number; timestamp?: number }

const TimelineMarkdownText: FC<TimelineTextPartProps> = ({ completedAt, timestamp }) => {
  const { text } = useMessagePartText()

  // assistant-ui adds an empty continuation after a tool starts. It is not
  // prose yet and must not create paragraph spacing above pending approvals.
  if (!text.trim()) {
    return null
  }

  return (
    <>
      <TimelineTimestamp className="mb-0.5 block" completedAt={completedAt} timestamp={timestamp} />
      <MarkdownText />
    </>
  )
}

const ThinkingDisclosure: FC<{
  children: ReactNode
  completedAt?: number
  messageRunning?: boolean
  pending?: boolean
  timestamp?: number
  // Required: the block's duration is remembered against this key, so a
  // component that mounts after the block finished can still report it.
  timerKey: string
}> = ({ children, completedAt, messageRunning = false, pending = false, timestamp, timerKey }) => {
  const { t } = useI18n()
  const reasoningCollapsedByDefault = useStore($reasoningCollapsedByDefault)
  // `null` = no explicit user toggle yet. Live reasoning remains visible by
  // default, unless the user opts into the low-jitter collapsed presentation.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const elapsed = useElapsedSeconds(pending, timerKey)
  const thoughtFor = useMeasuredDuration(pending, timerKey)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const enterRef = useEnterAnimation(messageRunning, timerKey)
  // A live preview that later settles must not unmount its body — that is the
  // "turn settled and everything jumped" shift. Latch that we showed one so
  // the clip stays. Groups that mount already complete (earlier thoughts in
  // a still-running turn) never latch, so they stay collapsed.
  const [sawLivePreview, setSawLivePreview] = useState(false)

  if (pending && !sawLivePreview) {
    setSawLivePreview(true)
  }

  // The collapsed-by-default preference outranks the latch: it opts out of
  // live previews entirely, so there is nothing to hold open.
  const showPreview = !reasoningCollapsedByDefault && (pending || sawLivePreview)
  const open = userOpen ?? showPreview
  const isPreview = userOpen === null && showPreview

  // Three ways a finished block can report itself. With a measured duration it
  // says so, unless the timer's whole seconds round it to "0s" — accurate and
  // useless — in which case it just says it was quick. With no duration at all
  // it still has to read as finished; a turn that ended must not go on saying
  // "Thinking".
  let thoughtLabel = t.assistant.thread.thinking

  if (!pending) {
    if (thoughtFor === null) {
      thoughtLabel = t.assistant.thread.thought
    } else if (thoughtFor < 1) {
      thoughtLabel = t.assistant.thread.thoughtBriefly
    } else {
      thoughtLabel = t.assistant.thread.thoughtFor(formatElapsed(thoughtFor))
    }
  }

  // Follow new tokens until the user scrolls up to read earlier reasoning.
  useEffect(() => {
    if (!isPreview) {
      return
    }

    const el = scrollRef.current
    const content = contentRef.current

    if (!el || !content) {
      return
    }

    // Height-gated: the observer also fires when the container's WIDTH changes
    // (sidebar sash drag resizes every message), and pinning there forces a
    // scrollHeight read+write per preview per frame. Only actual content
    // growth needs the pin; the height rides the RO entry, reflow-free.
    let lastHeight = -1
    let following = true

    const trackScroll = () => {
      following = el.scrollHeight - el.scrollTop - el.clientHeight < PREVIEW_RELOCK_THRESHOLD_PX
    }

    const pin = (entries: readonly ResizeObserverEntry[]) => {
      const height = entries[entries.length - 1]?.borderBoxSize?.[0]?.blockSize ?? -1
      const grew = height < 0 || height > lastHeight
      lastHeight = height

      if (grew && following) {
        el.scrollTop = el.scrollHeight
      }
    }

    // No sync pin(): the observer's guaranteed initial delivery runs it with
    // layout already clean (still before paint), avoiding a forced reflow.
    const observer = new ResizeObserver(pin)
    observer.observe(content)
    el.addEventListener('scroll', trackScroll, { passive: true })

    return () => {
      observer.disconnect()
      el.removeEventListener('scroll', trackScroll)
    }
    // Re-run when the disclosure toggles so the observer attaches to the new
    // DOM after expand/collapse (refs are conditionally rendered on `open`).
  }, [isPreview, open])

  return (
    <div
      className="text-[length:var(--conversation-tool-font-size)] text-(--ui-text-tertiary)"
      data-conversation-scaffold=""
      data-slot="aui_thinking-disclosure"
      ref={enterRef}
    >
      <ScaffoldRow
        onToggle={() => setUserOpen(!open)}
        open={open}
        trailing={
          <span className="flex shrink-0 items-center gap-1.5">
            <TimelineTimestamp className={SCAFFOLD_META_CLASS} completedAt={completedAt} timestamp={timestamp} />
            {pending && <ActivityTimerText className={SCAFFOLD_META_CLASS} seconds={elapsed} />}
          </span>
        }
      >
        <span className={cn(SCAFFOLD_LABEL_CLASS, pending && 'shimmer')}>{thoughtLabel}</span>
      </ScaffoldRow>
      {open && (
        <div
          className={cn(
            // Body sits flush with the "Thinking" header — no left indent —
            // and inherits the disclosure-level opacity fade defined in
            // styles.css (~0.67 at rest, 1 on hover/focus). overflow-auto so
            // the max-h-40 preview is a real scroller, not a clip.
            // Even a body that fits must hand vertical input to the thread.
            'mt-0.5 w-full min-w-0 max-w-full overflow-auto overscroll-x-contain overscroll-y-auto wrap-anywhere pb-1',
            isPreview && 'max-h-40'
          )}
          data-slot="aui_thinking-body"
          ref={scrollRef}
        >
          <div ref={contentRef}>{children}</div>
        </div>
      )}
    </div>
  )
}

// Self-gate "Thinking…" on this message's own reasoning parts. Reading
// `thread.isRunning` directly would flicker shimmer/timer on every old
// assistant whenever the external-store runtime clears+reimports its
// repository (one ref-identity bump per streaming delta).
const ReasoningAccordionGroup: FC<{ children?: ReactNode; endIndex: number; startIndex: number }> = ({
  children,
  endIndex,
  startIndex
}) => {
  const showReasoning = useStore($showReasoning)
  const messageId = useAuiState(s => s.message.id)
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')
  // The guide's reasoning is it reading its own runbook ("Now step 4: offer
  // the tour with ::ask"), and a first-time user reading that alongside the
  // greeting breaks the one conversation the guide is trying to have.
  const guidedChat = useOnboardingChatActive()

  const pending = useAuiState(
    s =>
      s.thread.isRunning &&
      s.message.status?.type === 'running' &&
      s.message.parts
        .slice(Math.max(0, startIndex), endIndex + 1)
        .some(p => p?.type === 'reasoning' && p.status?.type !== 'complete')
  )

  // A reasoning group with no actual text is pure noise — drop the whole
  // "Thinking" disclosure rather than leave an empty header eating a row. This
  // applies live too: encrypted/spinner-coerced reasoning (Opus reasoning max)
  // never carries visible text, and the bottom-of-thread loader already signals
  // "thinking", so an empty header is never wanted. Real reasoning surfaces the
  // instant its first token lands.
  const hasContent = useAuiState(s =>
    s.message.parts
      .slice(Math.max(0, startIndex), endIndex + 1)
      .some(p => p?.type === 'reasoning' && typeof p.text === 'string' && p.text.trim().length > 0)
  )

  const timestamp = useAuiState(s =>
    s.message.parts.slice(Math.max(0, startIndex), endIndex + 1).reduce<number | undefined>((earliest, part) => {
      const value = part.type === 'reasoning' ? (part as { timestamp?: number }).timestamp : undefined

      return value === undefined ? earliest : earliest === undefined ? value : Math.min(earliest, value)
    }, undefined)
  )

  const completedAt = useAuiState(s =>
    s.message.parts.slice(Math.max(0, startIndex), endIndex + 1).reduce<number | undefined>((latest, part) => {
      const value = part.type === 'reasoning' ? (part as { completedAt?: number }).completedAt : undefined

      return value === undefined ? latest : latest === undefined ? value : Math.max(latest, value)
    }, undefined)
  )

  if (!hasContent || guidedChat || !showReasoning) {
    return null
  }

  return (
    // Keyed per block, not per message: the timer registry hands every caller
    // of a key the same origin, so a turn that thinks three separate times used
    // to measure the second and third blocks from the first one's start and
    // report the running total as each block's duration.
    <ThinkingDisclosure
      completedAt={completedAt}
      messageRunning={messageRunning}
      pending={pending}
      timerKey={`reasoning:${messageId}:${startIndex}`}
      timestamp={timestamp}
    >
      {children}
    </ThinkingDisclosure>
  )
}

// Read the part from context, same contract as MarkdownText's
// useMessagePartText — the reasoning-only smoothing wrapper (removed) stalled
// the char-reveal at empty, blanking the widget.
const ReasoningTextPart: FC = () => {
  const { status, text } = useMessagePartReasoning()
  const messageRunning = useAuiState(s => s.message.status?.type === 'running')

  // The group above already hides grouped parts; this covers a Reasoning part
  // rendered without a ReasoningGroup wrapper (assistant-ui drops the group
  // when a ChainOfThought component is registered).
  const showReasoning = useStore($showReasoning)
  const textDirection = useForcedTextDirection()

  if (!showReasoning) {
    return null
  }

  return (
    <MarkdownTextContent
      containerClassName="text-xs leading-snug text-muted-foreground/85"
      containerProps={{ 'data-slot': 'aui_reasoning-text' } as ComponentProps<'div'>}
      isRunning={status.type === 'running' || messageRunning}
      scratchpad
      text={separateGluedReasoningBlocks(text.trimStart())}
      textDirection={textDirection}
    />
  )
}

// Module-level constant so the `components` prop on `MessagePrimitive.Parts`
// has a stable identity across renders. Without this every AssistantMessage
// render would create a fresh `components` object, invalidating the memo on
// `MessagePrimitivePartByIndex` and forcing every tool/reasoning child to
// re-render on every streaming delta. Memo invalidation alone doesn't
// remount, but combined with the previous ToolFallback group-swap it was a
// big chunk of the per-delta work.
export const MESSAGE_PARTS_COMPONENTS = {
  Reasoning: ReasoningTextPart,
  ReasoningGroup: ReasoningAccordionGroup,
  Text: TimelineMarkdownText,
  ToolGroup: ToolGroupSlot,
  tools: { Fallback: ChainToolFallback }
} as const

const PROCESS_GROUP = 'group-process'
const THOUGHT_GROUP = 'group-thought'
const TOOLS_GROUP = 'group-tools'

type TurnGroup = typeof PROCESS_GROUP | typeof THOUGHT_GROUP | typeof TOOLS_GROUP

/**
 * Everything the turn DID, behind one line: the thinking blocks, the tool runs,
 * the paragraphs written between them, the diffs — failures included, since a
 * settled turn that reports its own failures in prose does not need the raw row
 * shouting over the answer. What stays outside is the closing reply, so a
 * finished turn reads as one row plus the answer instead of forty rows around
 * it (Codex's shape, with the header as the one click back to the work).
 *
 * A message with no closing reply at all — one desktop turn is often several
 * assistant messages, and the ones in the middle are work from end to end —
 * folds WHOLE rather than standing there as rows: mid-turn work left unfolded is
 * what made a single prompt read as three screens of activity.
 *
 * Open while the turn runs, collapsed the moment it settles: the work is what
 * the user is watching live, and what stops being interesting once there is an
 * answer. A user toggle outranks both and is persisted per message, so a fold
 * they opened stays open across a rehydrate.
 */
const TurnProcessFold: FC<PropsWithChildren<{ indices: readonly number[] }>> = ({ children, indices }) => {
  const { t } = useI18n()
  const messageId = useAuiState(s => s.message.id)
  const running = useAuiState(s => s.message.status?.type === 'running')
  const disclosureId = `turn-process:${messageId}`
  const persistedOpen = useStore(useMemo(() => $toolDisclosureOpen(disclosureId), [disclosureId]))
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? persistedOpen ?? running
  // Measured on the turn, not on the disclosure: the number under the label is
  // how long the WORK took, whether or not the user was watching it.
  const elapsed = useElapsedSeconds(running, disclosureId)
  const measured = useMeasuredDuration(running, disclosureId)

  const label = running
    ? t.assistant.thread.turnProcessRunning
    : measured === null
      ? t.assistant.thread.turnProcessSteps(indices.length)
      : t.assistant.thread.turnProcessStepsWithDuration(indices.length, formatElapsed(measured))

  return (
    <div data-conversation-scaffold="" data-slot="aui_turn-process">
      <ScaffoldRow
        onToggle={() => {
          const next = !open
          setUserOpen(next)
          setToolDisclosureOpen(disclosureId, next)
        }}
        open={open}
        trailing={running ? <ActivityTimerText className={SCAFFOLD_META_CLASS} seconds={elapsed} /> : undefined}
      >
        <span className={cn(SCAFFOLD_LABEL_CLASS, 'truncate', running && 'shimmer')}>{label}</span>
      </ScaffoldRow>
      {open && (
        <div className="min-w-0 max-w-full" data-slot="aui_turn-process-body">
          {children}
        </div>
      )}
    </div>
  )
}

/**
 * One QUESTION's whole answer, folded across the messages it took to produce it.
 *
 * The desktop splits a prompt into several assistant messages — an interim per
 * tool round, then the reply — so folding each message on its own leaves the
 * prompt reading as several rows with rows left between them. What the reader
 * thinks in is the question: everything the turn did goes behind ONE row (the
 * interim messages whole, plus the reply's own work), and only the closing reply
 * stays on screen. The messages below paint nothing but body, so the row is the
 * only header.
 *
 * Collapsed once the turn settles, open while it runs, user toggle wins — the
 * same contract as the single-message fold.
 */
export const TurnSectionProcess: FC<{
  answerId?: string
  children: ReactNode
  indices: readonly number[]
}> = ({ answerId, children, indices }) => {
  const { t } = useI18n()

  // Only what the fold would hide counts: every part of the messages before the
  // reply, plus the reply's own work. A number, so this re-renders when the count
  // moves rather than on every streamed token.
  const steps = useAuiState(s =>
    indices.reduce((total, index) => {
      const message = s.thread.messages[index]

      if (!message) {
        return total
      }

      const boundary = message.id === answerId ? finalTextIndex(message.parts) : -1

      return total + (boundary < 0 ? message.parts.length : boundary)
    }, 0)
  )

  const running = useAuiState(s => indices.some(index => s.thread.messages[index]?.status?.type === 'running'))
  const firstId = useAuiState(s => s.thread.messages[indices[0] ?? -1]?.id)
  const disclosureId = `turn-process:section:${firstId ?? ''}`
  const persistedOpen = useStore(useMemo(() => $toolDisclosureOpen(disclosureId), [disclosureId]))
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? persistedOpen ?? running
  const elapsed = useElapsedSeconds(running, disclosureId)
  const measured = useMeasuredDuration(running, disclosureId)

  // A single message is not a question with interims — that turn folds inside
  // `TurnMessageParts` instead, where the threshold is about step count. Here the
  // question itself is the reason to fold: two messages means an interim reply
  // the reader did not ask to keep.
  if (indices.length < 2) {
    return <>{children}</>
  }

  const label = running
    ? t.assistant.thread.turnProcessRunning
    : measured === null
      ? t.assistant.thread.turnProcessSteps(steps)
      : t.assistant.thread.turnProcessStepsWithDuration(steps, formatElapsed(measured))

  return (
    <>
      <div data-conversation-scaffold="" data-slot="aui_turn-process">
        <ScaffoldRow
          onToggle={() => {
            const next = !open
            setUserOpen(next)
            setToolDisclosureOpen(disclosureId, next)
          }}
          open={open}
          trailing={running ? <ActivityTimerText className={SCAFFOLD_META_CLASS} seconds={elapsed} /> : undefined}
        >
          <span className={cn(SCAFFOLD_LABEL_CLASS, 'truncate', running && 'shimmer')}>{label}</span>
        </ScaffoldRow>
      </div>
      <SectionTurnFoldContext.Provider value={{ answerId, open }}>{children}</SectionTurnFoldContext.Provider>
    </>
  )
}

const EMPTY_PART_LIST: readonly PartState[] = []

/**
 * A group's subtree comes back from `GroupedParts` as ONE fragment, and
 * `ToolGroupSlot` reads its children by position to decide which calls are a run
 * and which are a card that splits it. Hand it the flat array the parts door
 * used to pass, or every index past the first lands on `undefined` and the diff
 * a turn exists to show renders as nothing.
 */
const flattenPartNodes = (node: ReactNode): ReactNode[] =>
  Children.toArray(node).flatMap(child =>
    isValidElement(child) && child.type === Fragment
      ? flattenPartNodes((child.props as { children?: ReactNode }).children)
      : [child]
  )

/**
 * One assistant turn's parts: the work folded behind a single line, the closing
 * reply in place underneath it.
 *
 * `GroupedParts` is assistant-ui's grouping door, and the paths built below are
 * the whole layout decision. Everything before the closing text part takes the
 * `group-process` prefix, so adjacent parts coalesce into ONE fold; under it sit
 * the same two runs this transcript has always had — consecutive tool calls
 * (`group-tools`) and consecutive reasoning (`group-thought`). What the fold
 * reveals when opened is therefore the layout that existed before the fold, one
 * level deeper.
 *
 * Inside a `TurnSectionProcess` (one question, folded across its messages) this
 * message contributes no header of its own: a message before the reply is pure
 * body, and the reply's own work joins the section's body so the reader sees one
 * row, not one per message.
 */
export const TurnMessageParts: FC = () => {
  const section = useContext(SectionTurnFoldContext)
  const messageId = useAuiState(s => s.message.id)
  const isSectionAnswer = section !== null && section.answerId === messageId
  const partsRef = useRef<readonly PartState[]>(EMPTY_PART_LIST)

  // The ONE number the grouping depends on. The parts themselves are mirrored
  // into a ref because `groupBy` is handed a part and nothing else, so it has to
  // ask "where is this part, and is the reply already talking?" — and a selector
  // runs on every store update, so the mirror is never stale. Returning the
  // length rather than the parts keeps this component re-rendering when the
  // work/answer boundary moves, not on every streamed token.
  const folded = useAuiState(s => {
    const parts = s.message.parts
    partsRef.current = parts

    // Body of a question's fold: the whole message is process, headerless.
    if (section !== null && !isSectionAnswer) {
      return parts.length
    }

    const boundary = finalTextIndex(parts)
    const length = boundary < 0 ? parts.length : boundary

    // The reply's own work goes into the section's body, so it does not need to
    // earn a header of its own (and must not stand outside one either).
    return section !== null ? length : length >= MIN_FOLDED_PARTS ? length : -1
  })

  const groupBy = useMemo(
    () => (part: PartState) => {
      const path: TurnGroup[] = []
      const index = partsRef.current.indexOf(part)

      if (folded >= 0 && index >= 0 && index < folded) {
        path.push(PROCESS_GROUP)
      }

      if (part.type === 'reasoning') {
        path.push(THOUGHT_GROUP)
      } else if (part.type === 'tool-call') {
        path.push(TOOLS_GROUP)
      }

      return path
    },
    [folded]
  )

  return (
    <MessagePrimitive.GroupedParts groupBy={groupBy} indicator="never">
      {({ part, children }) => {
        switch (part.type) {
          case PROCESS_GROUP:
            // A question's fold paints the one row (and owns the open state);
            // inside it, each message only supplies its body.
            return section ? (
              section.open && (
                <div className="min-w-0 max-w-full" data-slot="aui_turn-process-body">
                  {children}
                </div>
              )
            ) : (
              <TurnProcessFold indices={part.indices}>{children}</TurnProcessFold>
            )

          case THOUGHT_GROUP:
            return (
              <ReasoningAccordionGroup endIndex={part.indices.at(-1) ?? 0} startIndex={part.indices[0] ?? 0}>
                {children}
              </ReasoningAccordionGroup>
            )

          case TOOLS_GROUP:
            return (
              <ToolGroupSlot endIndex={part.indices.at(-1) ?? 0} startIndex={part.indices[0] ?? 0}>
                {flattenPartNodes(children)}
              </ToolGroupSlot>
            )

          case 'reasoning':
            return <ReasoningTextPart />

          case 'text':
            return <TimelineMarkdownText {...(part as TimelineTextPartProps)} />

          case 'tool-call':
            return part.toolUI ?? <ChainToolFallback {...(part as TimelineToolCallProps)} />

          case 'image':
            return <MessagePartPrimitive.Image />

          case 'data':
            return part.dataRendererUI

          // source / file / audio / generative-ui: no default component in this
          // app's registry, so they render nothing — same as the parts door did.
          default:
            return null
        }
      }}
    </MessagePrimitive.GroupedParts>
  )
}

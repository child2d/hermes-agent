import { createContext } from 'react'

/**
 * Index of the turning point between a turn's work and its answer: the reply's
 * LAST part that carries actual prose. `-1` means the message never wrote a
 * closing text part — it is pure work, and it folds whole.
 *
 * Whitespace-only text is not an answer — assistant-ui appends an empty
 * continuation text part once a tool call starts, and reading that as the
 * conclusion would park the fold in front of nothing.
 */
export const finalTextIndex = (parts: readonly { text?: unknown; type?: string }[]): number => {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]

    if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0) {
      return index
    }
  }

  return -1
}

/**
 * How long a turn took, derived from the timestamps every part already carries.
 *
 * This is the ONLY duration a transcript read back from history has: the live
 * measurement lives in an in-memory registry and the backend stores no per-turn
 * elapsed field (its `duration_seconds` belongs to delegation rows). First
 * timestamp → last completion, so it spans the work AND the reply, which is what
 * the row is summarizing anyway.
 */
interface SpanPart {
  completedAt?: unknown
  timestamp?: unknown
}

export const partSpanSeconds = (messages: readonly { parts: readonly unknown[] }[]): null | number => {
  let first: null | number = null
  let last: null | number = null

  for (const message of messages) {
    for (const part of message.parts as readonly SpanPart[]) {
      if (typeof part.timestamp === 'number' && (first === null || part.timestamp < first)) {
        first = part.timestamp
      }

      if (typeof part.completedAt === 'number' && (last === null || part.completedAt > last)) {
        last = part.completedAt
      }
    }
  }

  return first !== null && last !== null && last > first ? Math.max(1, Math.round(last - first)) : null
}

/** A single line of work is not worth a header over it — the same threshold the
 *  tool runs use (below two entries they render expanded, with no header). */
export const MIN_FOLDED_PARTS = 2

/**
 * One QUESTION's fold, published by the response section that owns it.
 *
 * The desktop turns one prompt into several assistant messages (an interim per
 * tool round, then the reply), so folding per message leaves a prompt reading as
 * several rows with rows left over between them. The section is the unit the
 * reader thinks in: everything it holds except the closing reply goes behind ONE
 * row, and the messages inside stop folding (or heading a fold) themselves.
 *
 * `null` means no section fold is in play — a single-message turn, which folds
 * inside `TurnMessageParts` instead.
 */
export interface SectionTurnFold {
  /** The message whose closing reply stays on screen; `undefined` when the whole
   *  section is work and nothing survives the fold. */
  answerId: string | undefined
  open: boolean
}

export const SectionTurnFoldContext = createContext<SectionTurnFold | null>(null)

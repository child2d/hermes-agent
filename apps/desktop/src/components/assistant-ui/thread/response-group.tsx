import { ThreadPrimitive, useAuiState } from '@assistant-ui/react'
import { type ComponentProps, createContext, type FC, Fragment, type ReactNode, useContext, useMemo } from 'react'

import { TurnSectionProcess } from '@/components/assistant-ui/thread/message-parts'
import { SectionTurnFoldContext } from '@/components/assistant-ui/thread/turn-process'

import { contentHasVisibleText, messageContentText, PROCESS_NOTIFICATION_RE } from './content'

interface GroupMessage {
  role: string
  content: unknown
  metadata?: { custom?: Record<string, unknown> }
}

/** Background deliveries continue the response without becoming human prompts. */
export function responseMessageRole(message: GroupMessage): string {
  const custom = message.metadata?.custom

  const background =
    message.role === 'system'
      ? Boolean(custom?.asyncResult || custom?.asyncResultKind)
      : message.role === 'user' && PROCESS_NOTIFICATION_RE.test(messageContentText(message.content))

  return background ? 'background' : message.role
}

export const ResponseMessageIds = createContext<readonly string[]>([])

interface ResponseMessagesProps {
  components: ComponentProps<typeof ThreadPrimitive.MessageByIndex>['components']
  indices: readonly number[]
}

interface ResponseRow {
  index: number
  id: string
  role: string
  hasText: boolean
}

interface ResponseRowRef {
  id: string
  index: number
}

interface ResponseSection {
  key: string
  indices: number[]
  assistantIds: string[]
  response: boolean
  rows: ResponseRowRef[]
}

/** Keep message runtimes intact; only their visual container and footer are shared. */
export function ResponseMessages({ components, indices }: ResponseMessagesProps) {
  const signature = useAuiState(s =>
    JSON.stringify(
      indices.flatMap(index => {
        const message = s.thread.messages[index]

        // A history replacement can notify this row before its parent updates indices.
        return message
          ? [
              {
                index,
                id: message.id,
                role: responseMessageRole(message),
                hasText: contentHasVisibleText(message.content)
              }
            ]
          : []
      })
    )
  )

  const sections = useMemo(() => {
    const rows = JSON.parse(signature) as ResponseRow[]
    const result: ResponseSection[] = []

    for (const row of rows) {
      const response = row.role === 'assistant' || row.role === 'background'
      const previous = result.at(-1)

      const section: ResponseSection =
        response && previous?.response
          ? previous
          : { key: row.id, indices: [], assistantIds: [], response, rows: [] }

      if (section !== previous) {
        result.push(section)
      }

      section.indices.push(row.index)
      section.rows.push({ id: row.id, index: row.index })

      if (row.role === 'assistant' && row.hasText) {
        section.assistantIds.push(row.id)
      }
    }

    return result
  }, [signature])

  return sections.map(section =>
    section.response ? (
      <Fragment key={section.key}>
        <ResponseMessageIds.Provider value={section.assistantIds}>
          <div className="group flex min-w-0 flex-col gap-(--scaffold-block-gap)" data-slot="aui_response-group">
            <TurnSectionProcess answerId={section.assistantIds.at(-1)} indices={section.indices}>
              {section.rows.map(row => (
                <SectionFoldRow id={row.id} key={row.id}>
                  <ThreadPrimitive.MessageByIndex components={components} index={row.index} />
                </SectionFoldRow>
              ))}
            </TurnSectionProcess>
          </div>
        </ResponseMessageIds.Provider>
      </Fragment>
    ) : (
      <ThreadPrimitive.MessageByIndex components={components} index={section.indices[0]!} key={section.key} />
    )
  )
}

/**
 * A message inside a question's fold paints nothing until that fold is open —
 * except the reply, whose closing text is the whole point of the fold. Painting
 * nothing (rather than hiding a subtree) keeps the collapsed transcript cheap:
 * the interim messages' tool rows never mount.
 */
const SectionFoldRow: FC<{ children: ReactNode; id: string }> = ({ children, id }) => {
  const fold = useContext(SectionTurnFoldContext)

  if (fold && !fold.open && fold.answerId !== id) {
    return null
  }

  return <>{children}</>
}

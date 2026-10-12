import { useStore } from '@nanostores/react'

import { $layoutEditMode } from '@/components/pane-shell/edit-mode'
import { useI18n } from '@/i18n'

import { ToggleRow } from './primitives'

/**
 * The layout editor's door in Settings. It moved here from the titlebar, where
 * it was one of two buttons nobody could name: the mode itself is live UI state
 * (⌘⇧\ and the ⌘K palette toggle it too, and Esc leaves), never a stored
 * preference — so this row reads and writes the atom directly and there is
 * nothing to save or roll back.
 */
export function LayoutEditorSetting() {
  const { t } = useI18n()
  const a = t.settings.appearance
  const on = useStore($layoutEditMode)

  return (
    <ToggleRow
      checked={on}
      description={a.layoutEditorDesc}
      label={a.layoutEditorTitle}
      onChange={enabled => $layoutEditMode.set(enabled)}
    />
  )
}

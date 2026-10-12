import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { $layoutEditMode, toggleLayoutEditMode } from '@/components/pane-shell/edit-mode'
import { en } from '@/i18n/en'

import { LayoutEditorSetting } from './layout-editor-setting'

const a = en.settings.appearance

afterEach(() => {
  cleanup()
  $layoutEditMode.set(false)
})

test('the settings row is the layout editor: it reads and writes the live mode atom both ways', () => {
  render(<LayoutEditorSetting />)

  const toggle = screen.getByRole('switch', { name: a.layoutEditorTitle })

  expect(screen.getByText(a.layoutEditorDesc)).toBeTruthy()
  expect(toggle.getAttribute('aria-checked')).toBe('false')

  // Clicking the row's switch IS the mode — nothing is persisted, nothing saves.
  fireEvent.click(toggle)
  expect($layoutEditMode.get()).toBe(true)

  // And the keybind / ⌘K path moves the same switch, not a private copy.
  act(() => toggleLayoutEditMode())
  expect(toggle.getAttribute('aria-checked')).toBe('false')

  act(() => $layoutEditMode.set(true))
  expect(toggle.getAttribute('aria-checked')).toBe('true')
})

// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { SidebarNavItem } from '@/app/types'
import { Codicon } from '@/components/ui/codicon'
import { I18nProvider } from '@/i18n'

import { AppRail } from './nav-rail'

// The rail draws the app's own icon family (lucide SVGs) at 20px, resolved from
// the codicon NAME its nav model carries — the list's row keeps its codicon.
// Locked here: a rail icon must be an SVG sized in px (a Codicon is a FONT glyph,
// whose size is font-size and ignores a `size-*` box), and an unmapped name must
// degrade to the item's own icon instead of leaving a hole.
const railItems = vi.hoisted(() => ({ current: [] as SidebarNavItem[] }))

vi.mock('./nav-model', () => ({
  sidebarRailItems: (items: SidebarNavItem[]) => items,
  useSidebarNavItems: () => railItems.current
}))

const navItem = (over: Partial<SidebarNavItem> & { codicon: string }): SidebarNavItem => ({
  // The row's icon IS the codicon the model names — the rail then chooses.
  icon: props => <Codicon name={over.codicon} {...props} />,
  id: 'capabilities',
  label: 'Capabilities',
  ...over
})

const renderRail = () =>
  render(
    <MemoryRouter initialEntries={['/']}>
      <I18nProvider configClient={null} initialLocale="en">
        <AppRail />
      </I18nProvider>
    </MemoryRouter>
  )

describe('AppRail', () => {
  beforeEach(() => {
    railItems.current = []
  })

  it('draws a lucide SVG at 20px, with the rail line weight', () => {
    railItems.current = [navItem({ codicon: 'symbol-misc' })]
    const { container } = renderRail()

    const svg = container.querySelector('svg')

    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('20')
    // A thinner line than lucide's default 2 — this is what "icons look heavy" moves.
    expect(svg?.getAttribute('stroke-width')).toBe('1.5')
    expect(container.querySelector('.codicon')).toBeNull()
  })

  it("keeps the item's own icon when the name has no lucide equivalent", () => {
    railItems.current = [navItem({ codicon: 'some-unknown-codicon' })]
    const { container } = renderRail()

    const glyph = container.querySelector<HTMLElement>('.codicon')

    expect(glyph?.classList.contains('codicon-some-unknown-codicon')).toBe(true)
  })

  it('names the button even though the rail draws no label', () => {
    railItems.current = [navItem({ codicon: 'comment' })]
    const { getByRole } = renderRail()

    expect(getByRole('button', { name: 'Capabilities' }).getAttribute('aria-current')).toBeNull()
  })

  it('renders nothing when the nav model is empty', () => {
    const { container } = renderRail()

    expect(container.querySelector('[data-slot="app-rail"]')).toBeNull()
  })
})

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SidebarNavItem } from '@/app/types'
import { Codicon } from '@/components/ui/codicon'

import { SidebarNavRail } from './nav-rail'

// The rail draws the app's own icon family (lucide SVGs) at 18px, resolved from
// the codicon NAME its nav model carries — the list's row keeps its codicon.
// Locked here: a rail icon must be an SVG sized in px (a Codicon is a FONT glyph,
// whose size is font-size and ignores a `size-*` box), and an unmapped name must
// degrade to the item's own icon instead of leaving a hole.
const navItem = (over: Partial<SidebarNavItem> & { codicon: string }): SidebarNavItem => ({
  // The row's icon IS the codicon the model names — the rail then chooses.
  icon: props => <Codicon name={over.codicon} {...props} />,
  id: 'capabilities',
  label: 'Capabilities',
  ...over
})

const renderRail = (items: SidebarNavItem[]) =>
  render(
    <SidebarNavRail isActive={() => false} items={items} labelFor={item => item.label} onNavigate={() => undefined} />
  )

describe('SidebarNavRail', () => {
  it('draws a lucide SVG at 18px for a known codicon name', () => {
    const { container } = renderRail([navItem({ codicon: 'symbol-misc' })])

    const svg = container.querySelector('svg')

    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('18')
    expect(container.querySelector('.codicon')).toBeNull()
  })

  it("keeps the item's own icon when the name has no lucide equivalent", () => {
    const { container } = renderRail([navItem({ codicon: 'some-unknown-codicon' })])

    const glyph = container.querySelector<HTMLElement>('.codicon')

    expect(glyph?.classList.contains('codicon-some-unknown-codicon')).toBe(true)
  })

  it('names the button even though the rail draws no label', () => {
    const { getByRole } = renderRail([navItem({ codicon: 'comment' })])

    expect(getByRole('button', { name: 'Capabilities' }).getAttribute('aria-current')).toBeNull()
  })
})

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SidebarNavItem } from '@/app/types'
import { Codicon } from '@/components/ui/codicon'

import { SidebarNavRail } from './nav-rail'

// A Codicon is a FONT glyph: `.codicon{font-size:.875em}` sizes it, so a `size-*`
// utility only sets the box and leaves the icon at its inherited size. The rail
// therefore hands the icon an explicit px size — that is the thing a "make the
// rail icons bigger" change actually has to move.
const item: SidebarNavItem = {
  icon: props => <Codicon name="symbol-misc" {...props} />,
  id: 'capabilities',
  label: 'Capabilities',
  route: '/capabilities'
}

describe('SidebarNavRail', () => {
  it('sizes the icon glyph itself, not just its box', () => {
    const { container } = render(
      <SidebarNavRail
        isActive={() => false}
        items={[item]}
        labelFor={() => 'Capabilities'}
        onNavigate={() => undefined}
      />
    )

    const icon = container.querySelector<HTMLElement>('.codicon')

    expect(icon?.style.fontSize).toBe('18px')
    expect(icon?.classList.contains('size-4.5')).toBe(true)
  })

  it('names the button even though the rail draws no label', () => {
    const { getByRole } = render(
      <SidebarNavRail
        isActive={() => true}
        items={[item]}
        labelFor={() => 'Capabilities'}
        onNavigate={() => undefined}
      />
    )

    expect(getByRole('button', { name: 'Capabilities' }).getAttribute('aria-current')).toBe('page')
  })
})

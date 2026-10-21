// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AppTopBar, BandSlot } from './app-top-bar'

// The shell's L1: one band row across the whole window. A zone on the window's
// top edge hands its band to that row (it keeps being the zone's own element —
// tabs, drag-to-stack and drop targets all key off the strip that belongs to the
// zone), and falls back to its own flow when no bar is on screen.
describe('AppTopBar / BandSlot', () => {
  it('mounts a zone band inside the window band row', () => {
    render(
      <AppTopBar>
        <BandSlot box={{ left: 52, width: 200 }}>
          <div data-testid="band">tabs</div>
        </BandSlot>
      </AppTopBar>
    )

    const row = document.querySelector('[data-slot="app-band-row"]')

    expect(row).not.toBeNull()
    expect(row?.contains(screen.getByTestId('band'))).toBe(true)
    // Placed at the ZONE's x/width, not the row's: the row spans the window, the
    // band spans the zone.
    const slot = row?.querySelector<HTMLElement>('[data-testid="band"]')?.parentElement
    expect(slot?.style.left).toBe('52px')
    expect(slot?.style.width).toBe('200px')
  })

  it('renders the band in place when no bar is on screen', () => {
    const { container } = render(
      <BandSlot box={{ left: 0, width: 100 }}>
        <div data-testid="band">tabs</div>
      </BandSlot>
    )

    expect(container.querySelector('[data-testid="band"]')).not.toBeNull()
  })

  it('draws nothing before the zone has been measured', () => {
    render(
      <AppTopBar>
        <BandSlot box={null}>
          <div data-testid="band">tabs</div>
        </BandSlot>
      </AppTopBar>
    )

    // An unplaced band would flash at x=0; it appears on the first measurement.
    expect(screen.queryByTestId('band')).toBeNull()
  })
})

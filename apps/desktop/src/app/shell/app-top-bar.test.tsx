// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AppTopBar, BAND_HEIGHT_VAR, BandSlot, publishBandHeight } from './app-top-bar'

// The shell's L1: one band row across the whole window. A zone on the window's
// top edge hands its band to that row (it keeps being the zone's own element —
// tabs, drag-to-stack and drop targets all key off the strip that belongs to the
// zone), and falls back to its own flow when no bar is on screen.
describe('AppTopBar / BandSlot', () => {
  it('keeps a lower zone strip in its body when the window has a top bar', () => {
    render(
      <AppTopBar>
        <div data-testid="lower-body">
          <BandSlot box={null} enabled={false}>
            <div data-testid="lower-band">lower tabs</div>
          </BandSlot>
        </div>
      </AppTopBar>
    )
    expect(screen.getByTestId('lower-body').contains(screen.getByTestId('lower-band'))).toBe(true)
    expect(
      globalThis.document.querySelector('[data-slot="app-band-row"]')?.contains(screen.getByTestId('lower-band'))
    ).toBe(false)
  })

  it('reserves the tallest live top-edge band regardless of mounting and cleanup order', () => {
    const height = () => globalThis.document.documentElement.style.getPropertyValue(BAND_HEIGHT_VAR)

    try {
      publishBandHeight(72, 'tall-test-zone')
      publishBandHeight(44, 'short-test-zone')
      expect(height()).toBe('72px')
      publishBandHeight(undefined, 'short-test-zone')
      expect(height()).toBe('72px')
      publishBandHeight(44, 'short-test-zone')
      publishBandHeight(undefined, 'tall-test-zone')
      expect(height()).toBe('44px')
    } finally {
      publishBandHeight(undefined, 'tall-test-zone')
      publishBandHeight(undefined, 'short-test-zone')
    }

    expect(height()).toBe('')
  })

  it('mounts a zone band inside the window band row', () => {
    render(
      <AppTopBar>
        <BandSlot box={{ left: 52, width: 200 }}>
          <div data-testid="band">tabs</div>
        </BandSlot>
      </AppTopBar>
    )

    const row = globalThis.document.querySelector('[data-slot="app-band-row"]')

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

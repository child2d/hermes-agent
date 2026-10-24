import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { $productEnv } from '@/store/product-env'

import { EnvironmentBadge } from './environment-badge'

// The three artifacts share one wordmark, so this tag is the only in-app thing
// that says which one is on screen. The shipped artifact must render nothing:
// its UI has to stay exactly as it was.
describe('EnvironmentBadge', () => {
  afterEach((): void => {
    $productEnv.set(null)
  })

  it('labels a non-shipped environment with its own token and tone', () => {
    $productEnv.set('dev')
    const { container } = render(<EnvironmentBadge />)
    const badge = container.querySelector('[data-slot="environment-badge"]')

    expect(badge?.textContent).toBe('DEV')
    expect(badge?.className).toContain('text-orange-600')
    expect(badge?.getAttribute('title')).toContain('~/.plankton/dev')
  })

  it('gives test its own tone, not a shared one', () => {
    $productEnv.set('test')
    const { container } = render(<EnvironmentBadge />)

    expect(container.querySelector('[data-slot="environment-badge"]')?.className).toContain('text-violet-600')
  })

  it('renders nothing on the shipped artifact', () => {
    $productEnv.set('prod')
    const { container } = render(<EnvironmentBadge />)

    expect(container.querySelector('[data-slot="environment-badge"]')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('renders nothing without an environment (upstream, or an unknown value)', () => {
    $productEnv.set(null)
    expect(render(<EnvironmentBadge />).container.textContent).toBe('')

    // A value this build does not know must not guess a look.
    $productEnv.set('staging')
    expect(render(<EnvironmentBadge />).container.textContent).toBe('')
    expect(screen.queryByText('STAGING')).toBeNull()
  })
})

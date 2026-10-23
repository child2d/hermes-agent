import { useStore } from '@nanostores/react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { $paneStates } from '@/store/panes'

import { group, split } from '../model'
import { $hiddenTreePanes, $layoutTree, setTreeGroupMinimized } from '../store'

import { TreeSplit } from './tree-split'

// The fold's motion is a FLIP: the layout commits in ONE frame and only
// transform / clip-path animate. These pin the mechanics — which element leaves
// the flow, which keyframe it and its neighbour get, that the transient state is
// torn down, and that the OS's reduced-motion setting disables all of it. The
// feel is a judgement call; none of this may regress silently.

const LIST = 'sessions'

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** jsdom has no matchMedia; the hook reads it, so every test states its answer. */
function installMatchMedia(reducedMotion: boolean) {
  const stub = (query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: reducedMotion,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined
  })

  vi.stubGlobal('matchMedia', stub)
  // vitest's jsdom keeps `window` distinct from `globalThis` for some globals, and
  // the hook reads it off `window`.
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: stub, writable: true })
}

const disposers: (() => void)[] = []

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('CSS', { ...globalThis.CSS, escape: (value: string) => value })
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => undefined
  Element.prototype.releasePointerCapture ??= () => undefined
  HTMLElement.prototype.scrollIntoView ??= () => undefined
})

beforeEach(() => {
  installMatchMedia(false)
  window.localStorage.clear()
  $hiddenTreePanes.set(new Set())
  $paneStates.set({})

  disposers.push(
    registry.register({
      area: 'panes',
      data: {
        collapsible: true,
        hideOnly: true,
        maxWidth: '320px',
        minWidth: '237px',
        placement: 'left',
        railInShell: true,
        width: '237px'
      },
      id: LIST,
      render: () => null,
      title: 'Sessions'
    }),
    registry.register({
      area: 'panes',
      data: { placement: 'main' },
      id: 'workspace',
      render: () => null,
      title: 'Chat'
    })
  )
})

afterEach(() => {
  cleanup()
  $layoutTree.set(null)
  $paneStates.set({})
  disposers.splice(0).forEach(dispose => dispose())
})

/** The shape the fold walks: list column, chat beside it. */
const listAndChat = () =>
  split('row', [group([LIST], { id: 'grp-list' }), group(['workspace'], { id: 'grp-main' })], [1, 3.4], 'spl-root')

let view: ReturnType<typeof render>

const splitEl = () => view.container.querySelector<HTMLElement>('[data-tree-split="spl-root"]')!

const wrappers = () => [...splitEl().children] as HTMLElement[]

/** The split as the app mounts it: driven by the store, not by a static prop —
 *  a `node` prop would never see the fold. */
function LiveSplit() {
  const tree = useStore($layoutTree)

  return tree && tree.type === 'split' ? <TreeSplit node={tree} root rootRow /> : null
}

function mount() {
  $layoutTree.set(listAndChat())
  view = render(<LiveSplit />)
}

describe('the list pane fold is a FLIP', () => {
  it('takes the folded zone out of the flow, clips it, and slides its neighbour in', async () => {
    mount()

    expect(wrappers()[0].style.position).toBe('')

    setTreeGroupMinimized('grp-list', true)

    await waitFor(() => expect(wrappers()[0].style.position).toBe('absolute'))

    const [list, main] = wrappers()

    // The folded zone keeps the place it had, at the width it had.
    expect(list.style.width).toBe('237px')
    expect(list.style.animation).toContain('zone-fold-hide')
    // It is a ghost of a committed layout: no clicks while it plays.
    expect(list.style.pointerEvents).toBe('none')
    // The neighbour's BOX does not move — its own fill would gap at the far edge.
    // What travels is its content, marked `data-fold-shift` and driven by the
    // `data-fold` CSS, so the split only has to publish the direction and width.
    expect(main.style.animation).toBe('')
    expect(splitEl().getAttribute('data-fold')).toBe('close')
    expect(splitEl().style.getPropertyValue('--zone-fold-shift')).toBe('237px')
  })

  it('animates the open direction too, and tears the state down afterwards', async () => {
    mount()
    setTreeGroupMinimized('grp-list', true)

    await waitFor(() => expect(wrappers()[0].style.animation).toContain('zone-fold-hide'))

    setTreeGroupMinimized('grp-list', false)

    await waitFor(() => expect(wrappers()[0].style.animation).toContain('zone-fold-show'))
    expect(splitEl().getAttribute('data-fold')).toBe('open')
    // The open direction commits the OPEN layout: the zone takes its width back in
    // the flow on the first frame. Holding it out of the flow for the animation
    // left the row at the folded widths and re-measured in one jump at the end —
    // the twitch that closed this out.
    expect(wrappers()[0].style.position).toBe('')
    expect(wrappers()[0].style.flex).toContain('237px')

    // The timer, not animationend (a background window may never fire it): the
    // transient state must clear itself. The zone is in the flow throughout the
    // open direction, so the ANIMATION is what says the motion is over.
    await waitFor(() => expect(wrappers()[0].style.animation).toBe(''), { timeout: 800 })
    expect(wrappers()[0].style.position).toBe('')
    expect(wrappers()[1].style.animation).toBe('')
    expect(splitEl().getAttribute('data-fold')).toBeNull()
    expect(splitEl().style.getPropertyValue('--zone-fold-shift')).toBe('')
  })

  it('animates nothing when the OS asks for reduced motion', async () => {
    installMatchMedia(true)
    mount()

    setTreeGroupMinimized('grp-list', true)

    // The fold still lands — it just lands in one frame.
    await waitFor(() => expect(wrappers()[0].style.flex).toBe('0 0 0px'))
    expect(wrappers()[0].style.position).toBe('')
    expect(wrappers()[0].style.animation).toBe('')
    expect(wrappers()[1].style.animation).toBe('')
    expect(splitEl().getAttribute('data-fold')).toBeNull()
  })
})

/**
 * Runtime-loaded example — this file is NOT bundled as a module: it ships as
 * raw text (`?raw`) and goes through the real runtime pipeline (specifier
 * rewrite -> SDK/react shim blobs -> blob import -> register). Plain ESM js
 * with `jsx()` calls — exactly what an agent (or a compiler) writes into
 * `~/.hermes/desktop-plugins/<name>/plugin.js`.
 */

import { cn, host, Tooltip, TooltipContent, TooltipTrigger, useValue } from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'

function RuntimeChip() {
  const gateway = useValue(host.state.gateway)

  return jsxs(Tooltip, {
    children: [
      jsx(TooltipTrigger, {
        asChild: true,
        children: jsxs('span', {
          className: cn(
            'inline-flex h-full items-center gap-1 px-1.5 text-2xs',
            'text-(--ui-text-tertiary)'
          ),
          children: [jsx('span', { 'aria-hidden': true, children: '⚡' }), jsx('span', { children: 'runtime' })]
        })
      }),
      jsx(TooltipContent, {
        children: `Loaded at RUNTIME through blob import + SDK injection (gateway: ${gateway})`
      })
    ]
  })
}

export default {
  id: 'hello-runtime',
  name: 'Hello Runtime',
  register(ctx) {
    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 110,
      render: () => jsx(RuntimeChip, {})
    })
  }
}

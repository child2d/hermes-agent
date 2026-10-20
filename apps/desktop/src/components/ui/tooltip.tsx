import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import * as React from "react"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider

/**
 * Opt a subtree out of hover tooltips entirely. The sidebar uses this: its rows
 * and header buttons all carry an `aria-label`, so the bubble only repeated what
 * the label already says — and on a dense list it fired under the pointer on
 * every pass.
 */
const QuietTooltipsContext = React.createContext(false)

function QuietTooltips({ children }: { children: React.ReactNode }) {
  return <QuietTooltipsContext.Provider value>{children}</QuietTooltipsContext.Provider>
}

/**
 * Quiet subtree: the Root stays mounted (Radix's Trigger throws without it) but
 * is pinned closed, so nothing ever portals — while the trigger keeps its
 * aria-label and keyboard behaviour.
 */
function Tooltip(props: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const quiet = React.useContext(QuietTooltipsContext)

  return <TooltipPrimitive.Root {...props} open={quiet ? false : props.open} />
}

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      className={cn(
        "z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--radix-tooltip-content-transform-origin]",
        className
      )}
      ref={ref}
      sideOffset={sideOffset}
      {...props}
    />
  </TooltipPrimitive.Portal>
))

TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { QuietTooltips, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }

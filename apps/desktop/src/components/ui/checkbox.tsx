import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import * as React from "react"

import { Codicon } from '@/components/ui/codicon'
import { Check } from "@/lib/icons"
import { cn } from "@/lib/utils"

/** The control's look, shared with `CheckboxMark` (rows that are themselves the
 *  toggle can't nest a real Checkbox inside a button). */
const BOX =
  "peer grid size-4 shrink-0 place-content-center rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    className={cn(
      BOX,
      className
    )}
    data-slot="checkbox"
    ref={ref}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("grid place-content-center text-current")}
      data-slot="checkbox-indicator"
    >
      <Check className="h-4 w-4" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))

Checkbox.displayName = CheckboxPrimitive.Root.displayName

/** The Checkbox look without a control, for rows that are themselves the toggle
 *  (a real Checkbox is a button and can't nest inside one). */
function CheckboxMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(BOX, 'grid place-items-center', className)}
      data-slot="checkbox-mark"
      data-state={checked ? 'checked' : 'unchecked'}
    >
      {checked && <Codicon name="check" size="0.875rem" />}
    </span>
  )
}

export { Checkbox, CheckboxMark }

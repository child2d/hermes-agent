import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Text+icon actions underline the label on hover, not the glyph.
const TEXT_ACTION_ICON = '[&_.codicon]:no-underline [&_svg]:no-underline'

// Plankton's Button IS the stock shadcn button (style: new-york) — the base
// string, the six variants and the size ladder below mirror
// `src/components/ui-kit/button.tsx`, which is the vendored registry copy. Keep
// the two in step: that is what lets us re-sync from the shadcn registry. The
// only deliberate divergence in the base string is `cursor-pointer`, which
// DESIGN.md requires at the primitive level.
//
// The entries under the `--- Plankton ---` markers are NOT shadcn. They exist
// because ~278 call sites already use these names. They are aliases kept for
// compatibility, not part of the design system: no new code should reach for
// them, and they can be deleted once call sites move onto the shadcn names.
//
// Density is deliberately shadcn's (h-9 default, text-sm) rather than the old
// padding-driven compact sizing, so app chrome reads as stock shadcn.
const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        // --- Plankton aliases ---
        // Emphasized inline-text action: bold + always-underlined ("Change", "Open logs").
        textStrong: `font-semibold text-muted-foreground underline underline-offset-4 hover:text-foreground ${TEXT_ACTION_ICON}`,
        // Boxless inline-text action (no bg/border) — "Cancel", "Clear".
        text: `text-muted-foreground underline-offset-4 hover:text-foreground hover:underline ${TEXT_ACTION_ICON}`,
        // A control floating free of any surface (fan-menu discs, detached chips).
        floating: 'bg-popover text-muted-foreground shadow-md hover:text-foreground',
        // Quiet, fill-free drawer handle.
        grip: 'bg-transparent text-muted-foreground transition-colors hover:text-foreground'
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9',
        // --- Plankton aliases ---
        // One step below `sm` — the old compact default.
        xs: "h-7 gap-1.5 rounded-md px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        // Flush inline text action — no box padding/height.
        inline: 'h-auto gap-1 p-0 has-[>svg]:px-0',
        // Status-stack headers, table footers — 12px text actions beside a label.
        micro: "h-auto gap-0.5 px-1 py-0 text-xs leading-4 font-normal [&_svg:not([class*='size-'])]:size-3",
        'icon-xs': 'size-7',
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
        grip: 'h-4 w-12 rounded-full p-0',
        // Measured from the titlebar tokens, not the size ladder: the window
        // controls and the tab strip are reserved from these same numbers.
        'icon-titlebar':
          'titlebar-icon-button h-(--titlebar-control-height) w-(--titlebar-control-size) [&_svg:not([class*="size-"])]:size-(--titlebar-icon-size)'
      }
    },
    compoundVariants: [
      // textStrong is a boxless link — size variants still inject px-*; strip
      // inline padding so the underline sits flush with the label.
      {
        variant: 'textStrong',
        class: 'px-0 has-[>svg]:px-0'
      }
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  loading = false,
  children,
  disabled,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Working. The label stays in flow but goes invisible and a spinner
     *  sits over it, so the button keeps its exact width and height — a
     *  label swapped for a glyph reflows every sibling on the row. */
    loading?: boolean
  }) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), loading && 'relative', className)}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          {/* Same flex + gap as the button itself, so the ghost label measures
              exactly what the live one did. The spinner sits in a wrapper so
              it is never a direct-child svg — the size variants' `has-[>svg]`
              would otherwise switch to icon padding and shave the width. */}
          <span aria-hidden className="invisible inline-flex items-center gap-[inherit]">
            {children}
          </span>
          <span aria-hidden className="absolute inset-0 grid place-items-center">
            <Loader2 className="animate-spin" />
          </span>
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { Button, buttonVariants }

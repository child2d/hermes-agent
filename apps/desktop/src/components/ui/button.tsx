import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from 'radix-ui'
import * as React from 'react'

import { Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

// Stock shadcn button (style: new-york). Kept in step with
// `src/components/ui-kit/button.tsx`, the vendored registry copy — staying equal
// to it is what lets us re-sync from the registry.
//
// DO NOT add app-specific variant or size names here. This component layer is
// deliberately stock shadcn; call sites still using the fork's old vocabulary
// get migrated onto these names rather than accommodated by aliases.
const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-8',
        icon: 'h-9 w-9'
      }
    },
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

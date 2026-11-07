import { cva, type VariantProps } from "class-variance-authority"
import * as React from "react"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
        // Tones the catalog/settings surfaces ask for by name. Same stock box,
        // tinted ink — no new shape or spacing.
        muted: "border-transparent bg-muted text-muted-foreground",
        success: "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        warn: "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
      },
      size: {
        default: "",
        sm: "px-1.5 py-0 text-2xs",
        xs: "px-1 py-0 text-2xs",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, size, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ size, variant }), className)} data-slot="badge" {...props} />
  )
}

export { Badge, badgeVariants }

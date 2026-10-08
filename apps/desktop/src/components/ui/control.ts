import { cva, type VariantProps } from 'class-variance-authority'

// Single source of truth for non-composer form-control chrome — Input,
// Textarea, and SelectTrigger all consume this. It IS the stock shadcn input
// recipe (style: new-york); keep the base string in step with
// `src/components/ui-kit/input.tsx`.
//
// Two deliberate divergences from the registry copy:
//  - `focus-visible:border-ring` is required, not decorative. styles.css nukes
//    every Tailwind ring utility globally (`*:focus-visible { --tw-ring-shadow:
//    0 0 #0000 !important }`), so the ring classes alone would leave a focused
//    field with no affordance at all. The border-color change is what shows.
//  - Text is always `text-sm`: this is a desktop app, so shadcn's
//    `text-base md:text-sm` narrow-viewport case does not exist.
//
// Height lives in the size variants so `Textarea` can opt out — twMerge drops
// `h-9` once it adds `h-auto`.
export const controlVariants = cva(
  [
    'w-full min-w-0 rounded-md border border-input bg-transparent shadow-sm transition-colors',
    'file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground',
    'placeholder:text-muted-foreground',
    'focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
    'disabled:cursor-not-allowed disabled:opacity-50',
    'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40'
  ].join(' '),
  {
    variants: {
      size: {
        default: 'h-9 px-3 py-1 text-sm',
        // --- Plankton aliases (existing call sites) ---
        xs: 'h-7 px-2 text-xs',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-10 px-4 text-sm'
      }
    },
    defaultVariants: {
      size: 'default'
    }
  }
)

export type ControlVariantProps = VariantProps<typeof controlVariants>

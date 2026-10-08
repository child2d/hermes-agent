import { cva } from 'class-variance-authority'

// Stock shadcn input recipe (style: new-york) — the single source of truth for
// non-composer form-control chrome. Input, Textarea and SelectTrigger consume
// it. Kept in step with `src/components/ui/kit/input.tsx`'s vendored copy.
//
// DO NOT add app-specific sizing here. The fork's old `size` ladder
// (xs/sm/default/lg) is gone: call sites move onto the shadcn recipes instead of
// being accommodated by aliases.
export const controlVariants = cva(
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm'
)

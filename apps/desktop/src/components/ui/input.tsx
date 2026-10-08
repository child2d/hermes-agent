import * as React from 'react'

import { cn } from '@/lib/utils'

import { controlVariants } from './control'

// `prefix`/`suffix` are DOM string attributes on the native element; we shadow
// them with ReactNode adornments, so they're omitted from the base props.
type InputProps = Omit<React.ComponentProps<'input'>, 'size' | 'prefix' | 'suffix'> & {
  /** Leading adornment rendered inside the field (e.g. a `$` for money). */
  prefix?: React.ReactNode
  /** Trailing adornment rendered inside the field (e.g. a unit label). */
  suffix?: React.ReactNode
  /** Applied to the wrapper when an adornment promotes the field to a group. */
  containerClassName?: string
}

function Input({ className, containerClassName, prefix, suffix, type, ...props }: InputProps) {
  const grouped = prefix != null || suffix != null

  const field = (
    <input
      // Off by default for every consumer — these are code/config/search fields,
      // not prose. Callers can re-enable per-instance by passing the prop.
      autoCapitalize="off"
      autoComplete="off"
      autoCorrect="off"
      className={cn(
        // NOTE (exposed gap): shadcn has no grouped-input primitive, so the
        // adornment case is ours. When grouped, the wrapper must own the chrome
        // and the inner input goes transparent — but the stock ring then draws
        // around the transparent inner input rather than the whole box. This is
        // an unresolved design gap, not something to paper over.
        grouped
          ? 'min-w-0 flex-1 border-0 bg-transparent p-0 text-base text-foreground outline-none placeholder:text-muted-foreground md:text-sm'
          : controlVariants(),
        className
      )}
      data-slot="input"
      spellCheck={false}
      type={type}
      {...props}
    />
  )

  if (!grouped) {
    return field
  }

  return (
    <div
      className={cn(controlVariants(), 'inline-flex flex-row items-center gap-1', containerClassName)}
      data-slot="input-group"
    >
      {prefix != null && (
        <span className="pointer-events-none shrink-0 select-none text-muted-foreground">{prefix}</span>
      )}
      {field}
      {suffix != null && (
        <span className="pointer-events-none shrink-0 select-none text-muted-foreground">{suffix}</span>
      )}
    </div>
  )
}

export { Input }

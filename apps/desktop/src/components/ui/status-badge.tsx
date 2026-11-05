import './status-badge.css'

import type { HTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** The Shaoke badge taxonomy (see shaoke-shared-ui · SHAOKE_UI_SPEC `status-badge`):
 *  one entry point for every status/type marker, three variants, a fixed intent
 *  vocabulary. Colours come from this app's tokens instead of the registry's
 *  Tailwind palette, so a badge never introduces a second colour system. */
export type BadgeIntent =
  | 'active'
  | 'entity'
  | 'error'
  | 'flagged'
  | 'inactive'
  | 'info'
  | 'intercepted'
  | 'neutral'
  | 'pending'
  | 'scanned'
  | 'success'
  | 'warning'

export type BadgeVariant = 'entity' | 'meta' | 'status'

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  label?: ReactNode
  size?: 'default' | 'lg' | 'sm'
  status: BadgeIntent
  variant?: BadgeVariant
}

const INTENT_TONE: Record<BadgeIntent, string> = {
  active: 'green',
  success: 'green',
  scanned: 'green',
  warning: 'yellow',
  pending: 'yellow',
  error: 'red',
  intercepted: 'red',
  flagged: 'red',
  info: 'blue',
  entity: 'blue',
  neutral: 'grey',
  inactive: 'grey'
}

export function StatusBadge({ className, label, size = 'sm', status, variant = 'status', ...rest }: StatusBadgeProps) {
  return (
    <span
      className={cn('status-badge', `is-${variant}`, `is-${size}`, `tone-${INTENT_TONE[status]}`, className)}
      data-intent={status}
      data-variant={variant}
      {...rest}
    >
      {label ?? status}
    </span>
  )
}

'use client'

import { type ComponentPropsWithRef, forwardRef } from 'react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface TooltipIconButtonProps extends ComponentPropsWithRef<typeof Button> {
  tooltip: string
  side?: 'top' | 'bottom' | 'left' | 'right'
}

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side, className, ...rest }, ref) => {
    return (
      <Tooltip><TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          {...rest}
          aria-label={tooltip}
          className={cn('aui-button-icon', className)}
          ref={ref}
        >
          {children}
        </Button>
      </TooltipTrigger><TooltipContent side={side}>{tooltip}</TooltipContent></Tooltip>
    )
  }
)

TooltipIconButton.displayName = 'TooltipIconButton'

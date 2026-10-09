import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { ErrorBoundary } from '@/components/error-boundary'
import { TooltipProvider } from '@/components/ui/tooltip'

import { WakeIndicatorApp } from './wake-indicator-app'

export function mountWakeIndicator(): void {
  const style = document.createElement('style')
  style.textContent = 'html,body,#root{background:transparent !important;overflow:hidden;}'
  document.head.appendChild(style)

  const root = document.getElementById('root')

  if (!root) {
    return
  }

  createRoot(root).render(
    <StrictMode>
      {/* Separate React root from main.tsx: stock Radix `Tooltip` throws with no
          ancestor provider, so this window needs its own. */}
      <TooltipProvider>
        <ErrorBoundary label="wake-indicator">
          <WakeIndicatorApp />
        </ErrorBoundary>
      </TooltipProvider>
    </StrictMode>
  )
}

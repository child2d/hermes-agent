// The one floating-list look. DropdownMenu, Select, and every Popover + cmdk
// picker (`<PopoverContent>` + `<Command variant="menu">`) paint
// through these, so a list reads the same wherever it opens. Change the menu
// here, never per call site.
//
// The vocabulary is stock shadcn new-york — `bg-popover`, `rounded-md` on the
// surface and `rounded-sm` on rows, `py-1.5 text-sm` rows, `bg-accent` /
// `text-accent-foreground` for the highlight. Only the structural bits the fork
// genuinely needs stay: `dt-portal-scrollbar` and the motion set below.

// `dt-portal-scrollbar` reproduces the thin themed scrollbar from
// `.scrollbar-dt` for portaled overlays (Radix renders under document.body,
// outside #root's scope). See styles.css.
export const menuSurfaceClass = 'dt-portal-scrollbar rounded-md border bg-popover p-1 text-popover-foreground shadow-md'

export const menuMotionClass =
  'data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95'

// Row shape only. Each primitive adds its own highlight/disabled selectors:
// Radix rows take real focus (`focus:`), cmdk rows stay behind the input and
// mark `data-selected="true"`.
export const menuItemClass =
  "relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

export const menuItemFocusClass = 'focus:bg-accent focus:text-accent-foreground'

export const menuLabelClass = 'px-2 py-1.5 text-xs font-medium text-muted-foreground'

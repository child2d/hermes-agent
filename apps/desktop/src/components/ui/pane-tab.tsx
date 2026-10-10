import * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Tab strip for editor / pane layouts.
 *
 * Built on the shadcn primitives the consumer already has (button, tooltip), so
 * a strip inherits the host app's theme instead of carrying its own palette.
 *
 * NOT built on shadcn `Tabs`: that component is content switching (Radix
 * `role=tablist/tab` + `aria-controls` pointing at a tabpanel). A tab STRIP that
 * drives panes/files is not content switching, and reusing Tabs would emit
 * aria wiring for panels that do not exist.
 *
 * Theming hooks (all optional, stock defaults):
 *   --pane-tab-active-bg     surface the active tab merges into
 *   --pane-tab-strip-bg      gutter colour of inactive tabs
 *   --pane-tab-active-accent underline on the active tab
 *   --pane-tab-close-width   width of the hover close chip (default 1.5rem)
 *   --pane-tab-divider-color line between adjacent tabs (default --color-border)
 *   --pane-tab-edge-color    vertical rail's content-facing edge (default --color-border)
 *   --pane-tab-idle-fg       inactive tab label colour (default --color-muted-foreground)
 *
 * Fallbacks reference the THEME-MAPPED name (`var(--color-muted)`, not
 * `var(--muted)`). Stock shadcn and a fork both define `--color-*` via
 * `@theme inline`, but a fork that maps stock names onto its own tokens (e.g.
 * `--color-muted: var(--dt-muted)`) has no bare `--muted` at all — so a bare
 * fallback silently resolves to nothing and the surface loses its background.
 * Verified against a real fork, not assumed.
 */

/* ────────────────────────────── middle-click ─────────────────────────────── */

/** `MouseEvent.button` for the middle (wheel) button. */
const MIDDLE_BUTTON = 1;

/** ⌘-click (metaKey + primary) — the trackpad equivalent of middle-click, for
 *  Macs with no middle button. Guarded on metaKey so it never collides with
 *  left-click (activate/drag) or ⌃-click (macOS context menu). */
const isMetaClose = (event: { button: number; metaKey: boolean }) =>
  event.button === 0 && event.metaKey;

/** Where the current middle press started. One pointer holds one button, so a
 *  single slot is the whole state. */
let pressedOn: EventTarget | null = null;

/**
 * Middle-click as a gesture that survives a real three-button mouse.
 *
 * `auxclick` is the obvious event and the wrong one to build on: Windows/Linux
 * Chromium answer a middle press inside a scroller by starting the AUTOSCROLL
 * pan, and the mouseup that ends the pan is spent stopping it instead of
 * completing a click — so `auxclick` never arrives. Every surface carrying this
 * gesture is a scroller, which is why it only ever worked on macOS.
 *
 * Pointer events fire either way, so the gesture arms on pointerdown and is
 * spent on the pointerup over the SAME element — press one tab, release on
 * another and nothing happens (Chrome / VS Code semantics). mousedown's default
 * dies on every middle press, action or not, so the pan widget can't appear on a
 * surface that owns the button.
 *
 * A plain factory, not a hook: tab strips call it inside `map()`.
 */
function middleClickHandlers(action: (() => void) | undefined) {
  return {
    onMouseDown: (event: React.MouseEvent) => {
      if (event.button === MIDDLE_BUTTON) {
        event.preventDefault();
      }
    },
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button === MIDDLE_BUTTON) {
        pressedOn = action ? event.currentTarget : null;
      }
    },
    onPointerUp: (event: React.PointerEvent) => {
      if (event.button !== MIDDLE_BUTTON) {
        return;
      }

      const armed = pressedOn === event.currentTarget;
      pressedOn = null;

      if (armed) {
        action?.();
      }
    },
  };
}

/* ──────────────────────────────── labels ─────────────────────────────────── */

/** Everything the strip says out loud. English defaults; pass your own to
 *  localise. Kept as props because this registry ships source, not a locale. */
export interface PaneTabLabels {
  close: string;
  closeAll: string;
  closeOthers: string;
  closeToRight: string;
}

const DEFAULT_LABELS: PaneTabLabels = {
  close: "Close",
  closeAll: "Close All",
  closeOthers: "Close Others",
  closeToRight: "Close to the Right",
};

/** Client-facing edge of a vertical rail — the strip line the active tab cuts. */
export type PaneTabSide = "left" | "right";

/* ─────────────────────────────── PaneTab ─────────────────────────────────── */

// Surface tokens become transparent under glass; the body owns the tint.
// The close-button fade masks the label, so it needs no second surface fill.
// Font size is a THEME hook, not a baked-in utility: a host that runs its own
// typography ladder must be able to keep its tab size without fighting a
// `text-*` utility (two font-size utilities resolve by Tailwind's output order,
// not by className order). Defaults are the effective result of stock `text-xs`
// (0.75rem / 1rem), so an untouched host sees no difference.
const TAB =
  "group/tab relative flex shrink-0 items-center text-(length:--pane-tab-font-size,0.75rem) leading-(--pane-tab-line-height,1rem) font-medium";

// Full height: with the strip's rule removed there is no last-pixel row to leave
// uncovered, so tabs fill the bar and no sliver of gutter shows through. The
// divider between neighbours is horizontal-only — no bottom rule, the strip owns
// that, and a per-tab border stacked a second line over it.
const TAB_HORIZONTAL =
  "h-full min-w-0 max-w-48 not-first:border-l not-first:border-l-(--pane-tab-divider-color,var(--color-border))";

// A closeable tab's floor keeps short labels left of the close button.
// A floor, not padding — a tab already wider than it pays nothing.
// 13 on the v4 spacing scale = 3.25rem.
const TAB_CLOSEABLE = "min-w-13";

const TAB_VERTICAL =
  "w-full max-h-48 justify-center not-first:border-t not-first:border-t-(--pane-tab-divider-color,var(--color-border)) [writing-mode:vertical-rl]";

// Active merges into the pane it belongs to. On a vertical rail it also goes
// border-transparent (applied in the render body) so the tab CUTS the strip line
// instead of continuing it.
const TAB_ACTIVE = "h-full bg-(--pane-tab-active-bg,var(--color-background)) text-foreground";

// A tab riding a multi-tab selection: an accent wash over whatever surface the
// tab sits on — Chrome-style, marks every tab a drag would carry.
const TAB_SELECTED = "bg-accent text-accent-foreground";

// Inactive = gutter. Hover uses the stock accent wash so it registers against a
// background-valued strip the same way every other shadcn control does.
const TAB_IDLE =
  "text-(--pane-tab-idle-fg,var(--color-muted-foreground)) bg-(--pane-tab-strip-bg,var(--color-muted)) hover:bg-accent hover:text-accent-foreground";

export interface PaneTabProps extends React.ComponentProps<"div"> {
  active?: boolean;
  /** Unsaved-changes indicator: an amber dot that yields to the hover ✕. */
  dirty?: boolean;
  /** Close verb. Horizontal tabs reveal a hover ✕ over the label's right edge;
   *  middle-click and ⌘-click always work and stay the only gestures on
   *  vertical rails (no room for a chip ✕). Omit `onClose` for an uncloseable
   *  tab — then no ✕ affordance is shown either. */
  onClose?: () => void;
  /** Accessible name of the ✕ chip. Defaults to the English "Close". */
  closeLabel?: string;
  /** Replaces the default ✕ glyph (e.g. an icon-library component). */
  closeIcon?: React.ReactNode;
  /** Part of a multi-tab selection (⌥/Ctrl-click, Shift-click). */
  selected?: boolean;
  /** Vertical rail form (collapsed side zones). */
  vertical?: boolean;
  /** Content-facing edge of a vertical rail. */
  side?: PaneTabSide;
}

/**
 * Editor tab shell — preview rail + zone headers + collapsed vertical rails.
 *
 * Defaults need no vars: the active tab takes the app background, inactive the
 * muted gutter. Override `--pane-tab-active-bg` to change what the active tab
 * merges into, `--pane-tab-strip-bg` for a gutter unlike the bar around it.
 */
export const PaneTab = React.forwardRef<HTMLDivElement, PaneTabProps>(
  function PaneTab(
    {
      active = false,
      dirty = false,
      onClose,
      closeLabel,
      closeIcon,
      onMouseDown,
      onPointerDown,
      onPointerUp,
      onClickCapture,
      selected = false,
      vertical = false,
      side = "left",
      children,
      className,
      ...props
    },
    ref,
  ) {
    // Vertical rails only. Horizontal tabs draw no vertical edge — the strip
    // owns that rule, and a per-tab border stacked a second line over it.
    const edge = vertical ? (side === "right" ? "border-l" : "border-r") : undefined;
    const middle = middleClickHandlers(onClose);

    return (
      <div
        className={cn(
          TAB,
          vertical ? TAB_VERTICAL : TAB_HORIZONTAL,
          !vertical && onClose && TAB_CLOSEABLE,
          // Vertical rail: the content-facing edge is a line the ACTIVE tab cuts.
          vertical && edge,
          vertical && (active ? "border-transparent" : "border-(--pane-tab-edge-color,var(--color-border))"),
          active
            ? cn(
                TAB_ACTIVE,
                !vertical &&
                  "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-(--pane-tab-active-accent,var(--color-primary))",
              )
            : TAB_IDLE,
          selected && TAB_SELECTED,
          className,
        )}
        data-active={active}
        data-closeable={(onClose && !vertical) || undefined}
        data-selected={selected || undefined}
        data-slot="pane-tab"
        data-vertical={vertical || undefined}
        onClickCapture={(event) => {
          // Sites whose tab activates on the label's own onClick fire it AFTER
          // our pointerdown close — swallow that stray click in the capture
          // phase so it can't re-select the just-closed tab.
          if (onClose && isMetaClose(event)) {
            event.preventDefault();
            event.stopPropagation();
          }

          onClickCapture?.(event);
        }}
        onMouseDown={(event) => {
          middle.onMouseDown(event);
          onMouseDown?.(event);
        }}
        onPointerDown={(event) => {
          middle.onPointerDown(event);

          // ⌘-click closes. Preempt here — strips activate/drag on pointerdown,
          // so we must claim the press before the shell's own handler starts a
          // drag, and skip it entirely.
          if (onClose && isMetaClose(event)) {
            event.preventDefault();
            event.stopPropagation();
            onClose();

            return;
          }

          onPointerDown?.(event);
        }}
        onPointerUp={(event) => {
          middle.onPointerUp(event);
          onPointerUp?.(event);
        }}
        ref={ref}
        {...props}
      >
        <div
          className={cn(
            "pane-tab-content flex h-full min-w-0 max-w-full flex-1 items-center",
            vertical && "contents",
          )}
        >
          {children}
        </div>
        {dirty && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute grid size-4 place-items-center group-hover/tab:group-data-[closeable]/tab:opacity-0",
              vertical
                ? "bottom-1.5 left-1/2 -translate-x-1/2"
                : "right-1.5 top-1/2 -translate-y-1/2",
            )}
          >
            <span className="size-2 rounded-full bg-amber-500 shadow-[0_0_0_2px_var(--pane-tab-active-bg,var(--color-background)),0_1px_2px_rgba(0,0,0,0.45)] dark:bg-amber-400" />
          </span>
        )}
        {onClose && !vertical && (
          // Mask the content beneath the close button instead of painting over
          // it. Geometry stays fixed; the same fade works on solid and glass.
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity group-hover/tab:pointer-events-auto group-hover/tab:opacity-100">
            <button
              aria-label={closeLabel ?? DEFAULT_LABELS.close}
              className="grid w-(--pane-tab-close-width,1.5rem) cursor-pointer place-items-center bg-transparent text-muted-foreground outline-none hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }}
              onPointerDown={(event) => {
                // Claim a plain left press so the shell can't also activate or
                // drag the tab. Middle/⌘ presses bubble on purpose — the tab's
                // own close gestures already route them.
                if (event.button === 0 && !isMetaClose(event)) {
                  event.stopPropagation();
                }
              }}
              tabIndex={-1}
              type="button"
            >
              {closeIcon ?? <DefaultCloseIcon />}
            </button>
          </span>
        )}
      </div>
    );
  },
);

/** Default ✕ glyph, at the same optical size the icon fonts use. */
function DefaultCloseIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="0.6875rem"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.6"
      viewBox="0 0 12 12"
      width="0.6875rem"
    >
      <path d="M3 3l6 6M9 3l-6 6" />
    </svg>
  );
}

/* ───────────────────────────── PaneTabLabel ──────────────────────────────── */

export interface PaneTabLabelProps extends React.ComponentProps<"button"> {
  /** `button` when the label is the activation target (preview rail); default
   *  `span` defers to the shell (zone drag/activate). */
  as?: "button" | "span";
}

/** Truncating label inside a `PaneTab`. `className` merges into the text span
 *  (e.g. `normal-case tracking-normal` for filenames). On a closeable tab the
 *  text clips instead of ellipsizing, so the hover mask can fade its right edge. */
export const PaneTabLabel = React.forwardRef<HTMLElement, PaneTabLabelProps>(
  function PaneTabLabel({ as = "span", className, children, ...props }, ref) {
    const Comp = as as React.ElementType;

    return (
      <Comp
        className="flex h-full min-w-0 max-w-full items-center overflow-hidden px-2 text-left outline-none group-data-[vertical]/tab:h-auto group-data-[vertical]/tab:w-full group-data-[vertical]/tab:justify-center group-data-[vertical]/tab:py-2"
        ref={ref}
        {...props}
      >
        <span
          className={cn(
            "block min-w-0 truncate font-medium tracking-wide uppercase group-data-[closeable]/tab:text-clip",
            className,
          )}
        >
          {children}
        </span>
      </Comp>
    );
  },
);

/* ───────────────────────────── PaneTabStrip ──────────────────────────────── */

export interface PaneTabStripProps extends React.ComponentProps<"div"> {
  /** The scrolling tab list — receives `role="tablist"`. */
  children: React.ReactNode;
  /** Ref on the scroller itself, for scroll-into-view of the active tab. */
  listRef?: React.Ref<HTMLDivElement>;
  /** Non-scrolling trailing chrome pinned to the right (e.g. a "+" button). */
  trailing?: React.ReactNode;
  /** Top-edge panel header that shares a native window-control band
   *  (Electron). Adds the OS drag region; irrelevant in a browser. */
  titlebar?: boolean;
}

/**
 * The horizontal tab bar every strip sits in. Owns the bar's height and
 * surface, the scroll behaviour (hidden scrollbars, contained overscroll), and
 * the pinned trailing slot — so a new strip inherits all of it instead of
 * re-deriving the geometry and drifting out of alignment.
 *
 * Tabs go in `children` as `PaneTab`s; per-strip extras (drag handlers, drop
 * targets) ride on the usual div props.
 */
export const PaneTabStrip = React.forwardRef<HTMLDivElement, PaneTabStripProps>(
  function PaneTabStrip(
    { children, className, listRef, trailing, titlebar = false, ...props },
    ref,
  ) {
    return (
      <div
        className={cn(
          "group/pane-header relative flex min-w-0 shrink-0 select-none bg-(--pane-tab-strip-bg,var(--color-muted))",
          titlebar
            ? "h-full flex-1 [-webkit-app-region:drag]"
            : "h-7 [-webkit-app-region:no-drag]",
          className,
        )}
        data-slot="pane-tab-strip"
        ref={ref}
        {...props}
      >
        <div
          className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          ref={listRef}
          role="tablist"
        >
          {children}
        </div>
        {trailing}
      </div>
    );
  },
);

/* ──────────────────────────── PaneStripGlyph ─────────────────────────────── */

/** A glyph button on a tab strip: the "+" and anything a pane contributes (a
 *  preview's console / DevTools). Callers pass DATA, never classes. */
export interface PaneStripTool {
  active?: boolean;
  disabled?: boolean;
  /** Any icon node — the strip does not pick an icon library. */
  icon: React.ReactNode;
  id: string;
  /** Tooltip text and accessible name. */
  label: string;
  onSelect: () => void;
}

/**
 * Renders one `PaneStripTool` through the shared `Button` + `Tooltip`: ghost
 * variant, no active background — state reads from the glyph's own opacity,
 * with `aria-pressed` carrying it for a11y.
 *
 * Pointerdown is claimed here so a click can never also activate or drag the
 * zone behind the strip.
 */
export function PaneStripGlyph({
  active,
  disabled,
  icon,
  label,
  onSelect,
}: Omit<PaneStripTool, "id">) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={active ?? undefined}
          className={cn(
            "self-center bg-transparent select-none",
            active ? "opacity-100" : "opacity-60 hover:opacity-100",
          )}
          disabled={disabled}
          onClick={onSelect}
          onPointerDown={(event) => event.stopPropagation()}
          size="icon"
          type="button"
          variant="ghost"
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/* ──────────────────────── close verbs (data, not JSX) ────────────────────── */

/** Close-verb enablement for `paneTabCloseItems` — how many tabs each verb hits. */
export interface PaneTabCloseCounts {
  all: number;
  others: number;
  right: number;
}

export interface PaneTabCloseItem {
  disabled: boolean;
  id: "close" | "closeOthers" | "closeToRight" | "closeAll";
  label: string;
  onSelect: () => void;
}

export interface PaneTabCloseItemsOptions {
  counts: PaneTabCloseCounts;
  /** Omit to hide Close entirely (an uncloseable tab shows no dead action). */
  onClose?: () => void;
  onCloseAll: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  labels?: Partial<PaneTabLabels>;
}

/**
 * The four close verbs every tab menu offers — Close / others / to the right /
 * all — so a tab answers a right-click the same way wherever it lives.
 *
 * Returns DATA so the caller renders it with its own menu primitive (shadcn
 * `DropdownMenu` / `ContextMenu`); this registry does not ship a menu kit.
 *
 * No shortcut hint on Close: a ⌘W keybind closes the FOCUSED zone's active tab,
 * so it would be a lie on the inactive tab the user actually right-clicked.
 */
export function paneTabCloseItems({
  counts,
  onClose,
  onCloseAll,
  onCloseOthers,
  onCloseToRight,
  labels,
}: PaneTabCloseItemsOptions): PaneTabCloseItem[] {
  const l = { ...DEFAULT_LABELS, ...labels };
  const items: PaneTabCloseItem[] = [];

  if (onClose) {
    items.push({ disabled: false, id: "close", label: l.close, onSelect: onClose });
  }

  items.push(
    { disabled: !counts.others, id: "closeOthers", label: l.closeOthers, onSelect: onCloseOthers },
    { disabled: !counts.right, id: "closeToRight", label: l.closeToRight, onSelect: onCloseToRight },
    { disabled: !counts.all, id: "closeAll", label: l.closeAll, onSelect: onCloseAll },
  );

  return items;
}

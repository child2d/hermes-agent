import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { ListPane } from '@/components/list-pane'
import { StatusDot, type StatusTone } from '@/components/status-dot'
import { SearchField } from '@/components/ui/search-field'
import { TabDropdown } from '@/components/ui/tab-dropdown'
import type { MessagingPlatformInfo } from '@/hermes'
import { useI18n } from '@/i18n'
import { platformStatusTone, TONE_PILL_CLASS } from '@/lib/platform-status'
import { normalize } from '@/lib/text'
import { cn } from '@/lib/utils'
import { $messagingPairing, $messagingPlatforms } from '@/store/messaging'

import { useRouteEnumParam } from '../hooks/use-route-enum-param'

import { byPlatform } from './pairing'
import { PlatformAvatar } from './platform-icon'

// Filter order: what needs you first, then what's fine, then what's off.
const STATUS_FILTER_ORDER: StatusTone[] = ['bad', 'warn', 'good', 'muted']

function platformMatches(platform: MessagingPlatformInfo, tone: 'all' | StatusTone, query: string): boolean {
  const q = normalize(query)

  return (
    (tone === 'all' || platformStatusTone(platform) === tone) &&
    (!q ||
      [platform.id, platform.name, platform.description, platform.state]
        .filter(Boolean)
        .some(value => String(value).toLowerCase().includes(q)))
  )
}

/** 消息平台's list column: the search field and the platform roster.
 *
 *  This column IS the way in — picking a row sets the `platform` route param,
 *  and the page beside it renders that platform's detail. It used to live
 *  inside the page as a master-detail rail, which put the same list one column
 *  short of the list column the shell already keeps for the route. */
export function MessagingPlatformsPane() {
  const { t } = useI18n()
  const m = t.messaging
  const platforms = useStore($messagingPlatforms)
  const pairing = useStore($messagingPairing)
  const platformIds = useMemo(() => platforms?.map(platform => platform.id) ?? [], [platforms])
  const [selectedId, setSelectedId] = useRouteEnumParam('platform', platformIds, platformIds[0] ?? '')
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | StatusTone>('all')

  const pendingByPlatform = useMemo(() => byPlatform(pairing.pending), [pairing.pending])

  // Only tones some platform is actually in get a filter; a filter whose last
  // platform changed state falls back to All instead of an empty list.
  const presentTones = useMemo(
    () => STATUS_FILTER_ORDER.filter(tone => platforms?.some(platform => platformStatusTone(platform) === tone)),
    [platforms]
  )

  const activeStatusFilter = statusFilter !== 'all' && presentTones.includes(statusFilter) ? statusFilter : 'all'

  const visiblePlatforms = useMemo(
    () => platforms?.filter(platform => platformMatches(platform, activeStatusFilter, query)) ?? [],
    [activeStatusFilter, platforms, query]
  )

  // Picking a filter moves the detail page into it. Only on that click: a
  // platform that leaves the filter because you just enabled it stays open.
  function handleStatusFilter(next: 'all' | StatusTone) {
    setStatusFilter(next)

    const selected = platforms?.find(platform => platform.id === selectedId)

    if (selected && !platformMatches(selected, next, query)) {
      const first = platforms?.find(platform => platformMatches(platform, next, query))

      if (first) {
        setSelectedId(first.id)
      }
    }
  }

  return (
    <ListPane
      title={t.sidebar.nav.messaging}
      toolbar={
        <>
          {(platforms?.length ?? 0) > 0 && (
            <SearchField
              aria-label={m.search}
              containerClassName="w-full"
              hints={platforms?.slice(0, 5).map(platform => t.common.tryHint(platform.name.toLowerCase()))}
              onChange={setQuery}
              placeholder={m.search}
              value={query}
            />
          )}
          {presentTones.length > 1 && (
            <TabDropdown
              align="start"
              items={(['all', ...presentTones] as const).map(id => ({
                active: id === activeStatusFilter,
                id,
                label: m.statusFilter[id],
                onSelect: () => handleStatusFilter(id)
              }))}
            />
          )}
        </>
      }
    >
      {!platforms ? null : (
        <ul className="space-y-1">
          {visiblePlatforms.map(platform => (
            <li key={platform.id}>
              <PlatformRow
                active={selectedId === platform.id}
                onSelect={() => setSelectedId(platform.id)}
                pendingCount={pendingByPlatform[platform.id]?.length ?? 0}
                platform={platform}
              />
            </li>
          ))}
        </ul>
      )}
    </ListPane>
  )
}

function PlatformRow({
  active,
  onSelect,
  pendingCount,
  platform
}: {
  active: boolean
  onSelect: () => void
  pendingCount: number
  platform: MessagingPlatformInfo
}) {
  const { t } = useI18n()

  return (
    <button
      className={cn(
        'row-hover flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:text-foreground',
        active ? 'bg-(--ui-row-active-background) text-foreground' : 'text-(--ui-text-secondary)'
      )}
      onClick={onSelect}
      type="button"
    >
      <PlatformAvatar platformId={platform.id} platformName={platform.name} />
      <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
        <span className="truncate text-[length:var(--conversation-text-font-size)] font-normal">{platform.name}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {/* Someone is waiting to be let in — the only way the roster tells
              you so before you open the platform. */}
          {pendingCount > 0 && (
            <span
              aria-label={t.messaging.pendingAria(pendingCount)}
              className={cn(
                'inline-flex min-w-4 items-center justify-center rounded-full px-1 text-2xs font-medium tabular-nums',
                TONE_PILL_CLASS.warn
              )}
            >
              {pendingCount}
            </span>
          )}
          <StatusDot tone={platformStatusTone(platform)} />
        </span>
      </span>
    </button>
  )
}

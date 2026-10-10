import type * as React from 'react'
import { useCallback, useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { useContributions } from '@/contrib'
import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useI18n } from '@/i18n'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { useStoreSelector } from '@/lib/use-session-slice'
import { $gateway } from '@/store/gateway'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { PanelEmpty } from '../overlays/panel'
import { PageSearchShell } from '../page-search-shell'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { ConnectorsTab } from './connectors/connectors-tab'
import { CAPABILITIES_TABS_AREA, capabilityTabs } from './contrib'
import { PluginsTab } from './plugins/plugins-tab'
import { CapabilityScopeSelector, useCapabilityScope } from './scope-selector'
import { SKILLS_QUERY_KEY, skillSearchTerms, useSkillsQuery } from './skills/skills-data'
import { SkillsTab } from './skills/skills-tab'
import { refreshToolCalls } from './toolsets/tool-calls'
import { TOOLSETS_QUERY_KEY, toolsetSearchTerms, useToolsetsQuery, visibleToolsetCount } from './toolsets/toolsets-data'
import { ToolsetsTab } from './toolsets/toolsets-tab'

// The tabs core itself ships, in strip order. Plugin tabs
// (CAPABILITIES_TABS_AREA — e.g. the enterprise 企业技能 / 企业工具 tabs) are
// appended AFTER them, so a contributed tab never displaces a core one.
const CORE_TABS = ['skills', 'toolsets', 'connectors', 'plugins'] as const

type CoreTab = (typeof CORE_TABS)[number]

const isCoreTab = (mode: string): mode is CoreTab => (CORE_TABS as readonly string[]).includes(mode)

interface CapabilitiesViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
  /** Embedded mode (plugin dialogs — e.g. Bot Mode's Advanced section): tab
   *  state lives in local React state instead of the route's `?tab=` param,
   *  so an embedding dialog never fights the page router. */
  embedded?: boolean
  /** Pin the WHOLE view to one profile: the scope selector is hidden and
   *  every tab reads/writes THAT profile. This is the plugin door — Bot Mode
   *  renders the real Capabilities surface pinned to a bot. */
  fixedProfile?: string
  /** Pin the view to a REGISTERED gateway connection alongside `fixedProfile`:
   *  every read/write routes to that machine's backend instead of the active
   *  gateway. `''`/`'local'` mean the local pool. This is Bot Mode's
   *  remote-target door — a bot living on another registered gateway gets the
   *  live surface pointed at ITS backend. Ignored without `fixedProfile`. */
  fixedConnection?: string
}

/** The Capabilities page SHELL: tab selection, the search header, the profile /
 *  connection scope, the refresh hotkey, and the dispatch to one tab component
 *  per tab. Each tab owns its list, detail pane and writes; the two installed
 *  lists are fetched here because the tab pills count them for the tab the user
 *  is NOT on. */
export function CapabilitiesView({
  embedded = false,
  fixedConnection,
  fixedProfile,
  setStatusbarItemGroup: _setStatusbarItemGroup,
  ...props
}: CapabilitiesViewProps) {
  const { t } = useI18n()
  // Both hooks run unconditionally (rules of hooks); embedded picks the local
  // one so tab clicks inside a dialog don't rewrite the page URL.
  const tabContributions = useContributions(CAPABILITIES_TABS_AREA)
  const contributedTabs = useMemo(() => capabilityTabs(tabContributions), [tabContributions])
  // The route param accepts every tab, core or contributed — a deep link to a
  // plugin tab must survive a reload, and an unknown value still falls back.
  const modes = useMemo(() => [...CORE_TABS, ...contributedTabs.map(tab => tab.id)], [contributedTabs])
  const routeTab = useRouteEnumParam('tab', modes, 'skills')
  const localTab = useState<string>('skills')
  const [mode, setMode] = embedded ? localTab : routeTab
  const activeContributed = useMemo(() => contributedTabs.find(tab => tab.id === mode) ?? null, [contributedTabs, mode])
  // A contributed tab can vanish while it is the selected one (its plugin was
  // disabled or reloaded). The route param keeps naming it, so fall back to the
  // first core tab rather than render an empty body under a tab the strip no
  // longer shows.
  const activeMode: string = isCoreTab(mode) || activeContributed ? mode : 'skills'
  const gateway = useStoreSelector($gateway, g => (activeMode === 'connectors' ? g : null))

  const [query, setQuery] = useState('')

  const scope = useCapabilityScope({ fixedConnection, fixedProfile })

  // The two installed lists the tab pills count. They are fetched here, as a
  // pair, because the counts stay live for the tab the user is NOT on.
  const { data: skills, isError: skillsFailed, error: skillsError } = useSkillsQuery(scope.profile)
  const { data: toolsets, isError: toolsetsFailed } = useToolsetsQuery(scope.profile)

  const refreshCapabilities = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SKILLS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: TOOLSETS_QUERY_KEY })
    ])

    invalidateSlashCompletions()

    void refreshToolCalls(scope.profile)
  }, [scope.profile])

  useRefreshHotkey(refreshCapabilities)

  // Rotating placeholder nudges from the user's own data — teach that search
  // understands categories and tool names, not just titles.
  const searchHints = useMemo(() => {
    if (activeMode === 'skills' && skills?.length) {
      return skillSearchTerms(skills).map(term => t.common.tryHint(term))
    }

    if (activeMode === 'toolsets' && toolsets?.length) {
      return toolsetSearchTerms(toolsets).map(term => t.common.tryHint(term))
    }

    return undefined
  }, [activeMode, skills, t, toolsets])

  // MCP and Plugins load independently of the installed Skills/Tools lists.
  const gated = activeMode === 'toolsets' || activeMode === 'skills'
  const pending = gated && !(skills && toolsets)

  const loadGate = !pending ? null : skillsFailed || toolsetsFailed ? (
    <PanelEmpty
      action={
        <Button onClick={() => void refreshCapabilities()} size="sm">
          {t.skills.refresh}
        </Button>
      }
      description={skillsError instanceof Error ? skillsError.message : undefined}
      icon="error"
      title={t.skills.skillsLoadFailed}
    />
  ) : (
    <PageLoader label={t.skills.loading} />
  )

  const coreTabContent = {
    // The gateway instance backs ONLY the live `reload.mcp` RPC, and it is the
    // ACTIVE gateway's socket — for a scope pinned to a different backend that
    // (config edits still apply on that backend's next session).
    connectors: () => (
      <ConnectorsTab
        gateway={scope.crossBackend ? null : gateway}
        key={`connectors-${scope.key}`}
        profile={scope.profile}
      />
    ),
    // Agent plugins for the scoped profile (selector in the section header),
    // app-level desktop plugins, and the docs catalog picker underneath.
    plugins: () => (
      <PluginsTab
        key={`plugins-${scope.key}`}
        profile={scope.profile}
        scopeLabel={scope.label}
        scopeSelector={scope.options.length > 1 ? <CapabilityScopeSelector compact scope={scope} /> : undefined}
      />
    ),
    skills: () => (
      <SkillsTab
        key={`skills-${scope.key}`}
        onRefresh={() => void refreshCapabilities()}
        profile={scope.profile}
        query={query}
        skills={skills ?? []}
      />
    ),
    toolsets: () => (
      <ToolsetsTab key={`toolsets-${scope.key}`} profile={scope.profile} query={query} toolsets={toolsets ?? []} />
    )
  } satisfies Record<CoreTab, () => React.ReactNode>

  return (
    <PageSearchShell
      {...props}
      activeTab={activeMode}
      onSearchChange={setQuery}
      onTabChange={setMode}
      // The Connectors directory and Plugins own their search field; a
      // contributed tab owns its own chrome end to end.
      searchHidden={activeMode === 'connectors' || activeMode === 'plugins' || activeContributed !== null}
      searchHints={searchHints}
      searchPlaceholder={activeMode === 'skills' ? t.skills.searchSkills : t.skills.searchToolsets}
      searchValue={query}
      tabs={[
        { id: 'skills', label: t.skills.tabSkills, meta: skills?.length ?? null },
        { id: 'toolsets', label: t.skills.tabToolsets, meta: toolsets ? visibleToolsetCount(toolsets) : null },
        { id: 'connectors', label: t.connectorsPage.title },
        { id: 'plugins', label: t.skills.tabPlugins },
        // No `meta`: `null` means "still loading" in the tab strip and renders a
        // pulsing skeleton chip. A contributed tab reports no count of its own —
        // its own body carries the counts it cares about.
        ...contributedTabs.map(tab => ({ id: tab.id, label: tab.label }))
      ]}
    >
      <div className="flex h-full flex-col">
        {activeMode !== 'plugins' && <CapabilityScopeSelector scope={scope} />}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {loadGate ??
              (activeContributed ? (
                // The blast wall stays between plugin code and the page: a
                // throwing tab degrades to an inline error in ITS body.
                <ContribBoundary id={activeContributed.id}>
                  <ContribRender render={activeContributed.render} />
                </ContribBoundary>
              ) : (
                isCoreTab(activeMode) && coreTabContent[activeMode]()
              ))}
          </div>
        </div>
      </div>
    </PageSearchShell>
  )
}

// Feature-detection flag for plugins (Bot Mode): TRUE means this build's
// CapabilitiesView routes `fixedConnection` to the pinned connection's backend.
// Older builds export CapabilitiesView WITHOUT the prop — passing it there would
// silently read/write the ACTIVE gateway under the remote bot's profile name,
// which is exactly the wrong-machine bug the prop exists to prevent. A static
// property is probe-able without rendering.
CapabilitiesView.supportsFixedConnection = true as const

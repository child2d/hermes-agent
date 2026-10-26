import { useStore } from '@nanostores/react'
import type * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { StatusDot, type StatusTone } from '@/components/status-dot'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { ErrorBanner } from '@/components/ui/error-state'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip'
import {
  approvePairing,
  type MessagingEnvVarInfo,
  type MessagingPlatformInfo,
  type PairingUser,
  revokePairing,
  type TelegramOnboardingApplyResponse,
  updateMessagingPlatform
} from '@/hermes'
import { type Translations, useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { AlertTriangle, ExternalLink, RefreshCw, Save, Trash2 } from '@/lib/icons'
import { platformStatusTone, TONE_PILL_CLASS } from '@/lib/platform-status'
import { cn } from '@/lib/utils'
import { $changeEventsAvailable, $pairingChangeTick, $platformsChangeTick } from '@/store/live-sync'
import {
  $messagingPairing,
  $messagingPlatforms,
  refreshMessagingPairing,
  refreshMessagingPlatforms,
  setMessagingPairing,
  updateMessagingPlatforms
} from '@/store/messaging'
import { notify, notifyError } from '@/store/notifications'
import { $settingsRequestProfile } from '@/store/settings-scope'
import { $gatewayRestarting, runGatewayRestart, watchGatewayRestartOutcome } from '@/store/system-actions'

import { useRefreshHotkey } from '../hooks/use-refresh-hotkey'
import { useRouteEnumParam } from '../hooks/use-route-enum-param'
import { DetailColumn } from '../master-detail'
import { CREDENTIAL_CONTROL_CLASS } from '../settings/credential-key-ui'
import { credentialPreview } from '../settings/helpers'
import { ListRow } from '../settings/primitives'
import { SettingsProfileScope } from '../settings/profile-scope'
import type { SetStatusbarItemGroup } from '../shell/statusbar-controls'

import { byPlatform, pairingKey, pairingLabel } from './pairing'
import { PlatformAvatar } from './platform-icon'
import { TelegramQrSetup } from './telegram-qr-setup'

interface MessagingViewProps extends React.ComponentProps<'section'> {
  setStatusbarItemGroup?: SetStatusbarItemGroup
}

type EditMap = Record<string, Record<string, string>>

const stateLabel = (state: null | string | undefined, m: Translations['messaging']) =>
  state ? m.states[state] || state.replace(/_/g, ' ') : m.unknown

const trimEdits = (edits: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(edits)
      .map(([k, v]) => [k, v.trim()])
      .filter(([, v]) => v)
  )

const FIELD_COPY: Record<string, { advanced?: boolean }> = {
  TELEGRAM_PROXY: { advanced: true },
  DISCORD_REPLY_TO_MODE: { advanced: true },
  DISCORD_ALLOW_ALL_USERS: { advanced: true },
  DISCORD_HOME_CHANNEL: { advanced: true },
  DISCORD_HOME_CHANNEL_NAME: { advanced: true },
  BLUEBUBBLES_ALLOW_ALL_USERS: { advanced: true },
  MATTERMOST_ALLOW_ALL_USERS: { advanced: true },
  MATTERMOST_HOME_CHANNEL: { advanced: true },
  QQ_ALLOW_ALL_USERS: { advanced: true },
  QQBOT_HOME_CHANNEL: { advanced: true },
  QQBOT_HOME_CHANNEL_NAME: { advanced: true },
  WHATSAPP_ENABLED: { advanced: true },
  WHATSAPP_MODE: { advanced: true }
}

function fieldCopy(field: MessagingEnvVarInfo, m: Translations['messaging']) {
  const copy = FIELD_COPY[field.key] || {}
  const localized = m.fieldCopy[field.key] || {}

  return {
    label: localized.label || field.prompt || field.key,
    help: localized.help || field.description,
    placeholder: localized.placeholder || field.prompt,
    advanced: Boolean(copy.advanced || field.advanced)
  }
}

export function MessagingView({ setStatusbarItemGroup: _setStatusbarItemGroup, ...props }: MessagingViewProps) {
  const { t } = useI18n()
  const m = t.messaging
  // Shared settings "Applies to" scope, request-shaped (undefined → follow
  // the active profile; the API helpers treat null as "target primary").
  const scopeProfile = useStore($settingsRequestProfile)
  // The roster is shared with the list column (see store/messaging): the pane
  // and this page read the same scoped cache, so they cannot disagree.
  const platforms = useStore($messagingPlatforms)
  const pairing = useStore($messagingPairing)
  // A saved credential/toggle only takes effect on the next gateway start, so a
  // vanishing toast is not enough: the page keeps a banner up until a restart
  // actually happens (dashboard parity). Cleared on a completed restart.
  const [restartNeeded, setRestartNeeded] = useState(false)
  const gatewayRestarting = useStore($gatewayRestarting)

  const [approving, setApproving] = useState<null | string>(null)
  const [pendingRevoke, setPendingRevoke] = useState<null | PairingUser>(null)
  const [edits, setEdits] = useState<EditMap>({})
  const [saving, setSaving] = useState<string | null>(null)
  const platformIds = useMemo(() => platforms?.map(p => p.id) ?? [], [platforms])
  const [selectedId, setSelectedId] = useRouteEnumParam('platform', platformIds, platformIds[0] ?? '')

  // The scope-tagged cache in store/messaging is the other half of the page's
  // data story: a response is dropped unless the scope it was issued for is
  // still the rendered one, and a scope switch hides the previous snapshot in
  // the render it is switched in (#96542).
  const refreshAll = useCallback(
    async (silent = false) => {
      await Promise.all([refreshMessagingPlatforms(scopeProfile, silent), refreshMessagingPairing(scopeProfile)])
    },
    [scopeProfile]
  )

  // Latest-callback ref: the deferred post-restart refresh must not capture a
  // stale scope closure from before a profile switch.
  const refreshAllRef = useRef(refreshAll)

  refreshAllRef.current = refreshAll

  const restartGatewayNow = useCallback(async () => {
    // runGatewayRestart never rejects: it toasts the failure and settles the
    // statusbar indicator; the banner stays if the restart did not complete.
    const ok = await runGatewayRestart()

    if (ok) {
      setRestartNeeded(false)
      window.setTimeout(() => void refreshAllRef.current(true), 4000)
    }
  }, [])

  // A multiplexed named profile is re-served from its new config at once (`hot_served`): no restart
  // banner; re-read status once the adapter had a moment to connect. Anything else needs a restart.
  const settleAfterUpdate = useCallback((hotServed: boolean | undefined) => {
    if (hotServed) {
      window.setTimeout(() => void refreshAllRef.current(true), 4000)

      return
    }

    setRestartNeeded(true)
  }, [])

  useRefreshHotkey(() => void refreshAll())

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  // Scope switch: an in-flight editor's typed credentials belong to the profile
  // they were typed for. This must run during render, not in an effect: passive
  // effects fire after paint, and that first painted frame would show the
  // previous profile's edits under the new profile's scope for the ~1s until
  // the fetch lands (#96542). The platforms/pairing caches blank themselves
  // through their scope tag, in this same render.
  const [prevScope, setPrevScope] = useState(scopeProfile)

  if (prevScope !== scopeProfile) {
    setPrevScope(scopeProfile)
    setEdits({})
  }

  const changeEventsAvailable = useStore($changeEventsAvailable)
  const platformsChangeTick = useStore($platformsChangeTick)
  const pairingChangeTick = useStore($pairingChangeTick)

  // A new pending request (or a grant from another surface) moves the pairing
  // store on disk; the change watcher turns that into pairing.changed. Pairing
  // has its OWN signal on purpose: platforms.changed tracks connect/disconnect
  // health via gateway_state.json, which a new request never moves — riding it
  // would leave a pending row invisible until something unrelated reconnected.
  useEffect(() => {
    if (!changeEventsAvailable || pairingChangeTick === 0 || document.hidden) {
      return
    }

    void refreshMessagingPairing(scopeProfile)
  }, [changeEventsAvailable, pairingChangeTick, scopeProfile])

  // Connection status updates without a manual "check" click. platforms.changed
  // (the gateway persisting connect/disconnect/health to gateway_state.json)
  // drives the refresh on event-capable backends — no timer; older backends
  // keep the legacy visible-tab poll.
  useEffect(() => {
    if (!changeEventsAvailable || platformsChangeTick === 0 || document.hidden) {
      return
    }

    void refreshMessagingPlatforms(scopeProfile, true)
  }, [changeEventsAvailable, platformsChangeTick, scopeProfile])

  useEffect(() => {
    if (changeEventsAvailable) {
      return
    }

    let cancelled = false

    function tick() {
      if (cancelled || document.hidden) {
        return
      }

      void refreshAllRef.current(true)
    }

    const id = window.setInterval(tick, 6000)

    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [changeEventsAvailable])

  const selected = useMemo(() => {
    if (!platforms) {
      return null
    }

    return platforms.find(platform => platform.id === selectedId) || platforms[0] || null
  }, [platforms, selectedId])

  const pendingByPlatform = useMemo(() => byPlatform(pairing.pending), [pairing.pending])
  const approvedByPlatform = useMemo(() => byPlatform(pairing.approved), [pairing.approved])

  async function handleToggle(platform: MessagingPlatformInfo, enabled: boolean) {
    setSaving(`enabled:${platform.id}`)

    try {
      const result = await updateMessagingPlatform(platform.id, { enabled }, scopeProfile)
      updateMessagingPlatforms(scopeProfile, current =>
        current.map(row =>
          row.id === platform.id
            ? {
                ...row,
                enabled,
                state: enabled ? (row.configured ? 'pending_restart' : 'not_configured') : 'disabled'
              }
            : row
        )
      )
      settleAfterUpdate(result.hot_served)
      notify({
        kind: 'success',
        title: enabled ? m.platformEnabled(platform.name) : m.platformDisabled(platform.name),
        message: result.hot_served ? m.appliedLive : m.restartToApply
      })
    } catch (err) {
      notifyError(err, m.failedUpdate(platform.name))
    } finally {
      setSaving(null)
    }
  }

  async function handleSave(platform: MessagingPlatformInfo) {
    const env = trimEdits(edits[platform.id] || {})

    if (Object.keys(env).length === 0) {
      return
    }

    setSaving(`env:${platform.id}`)

    try {
      const result = await updateMessagingPlatform(platform.id, { env }, scopeProfile)
      setEdits(current => ({ ...current, [platform.id]: {} }))
      await refreshMessagingPlatforms(scopeProfile)
      settleAfterUpdate(result.hot_served)
      notify({
        kind: 'success',
        title: m.setupSaved(platform.name),
        message: result.hot_served ? m.connectingLive : m.restartToReconnect
      })
    } catch (err) {
      notifyError(err, m.failedSave(platform.name))
    } finally {
      setSaving(null)
    }
  }

  async function handleClear(platform: MessagingPlatformInfo, key: string) {
    setSaving(`clear:${key}`)

    try {
      const result = await updateMessagingPlatform(platform.id, { clear_env: [key] }, scopeProfile)
      setEdits(current => ({
        ...current,
        [platform.id]: {
          ...(current[platform.id] || {}),
          [key]: ''
        }
      }))
      await refreshMessagingPlatforms(scopeProfile)
      settleAfterUpdate(result.hot_served)
      notify({ kind: 'success', title: m.keyCleared(key), message: m.setupUpdated(platform.name) })
    } catch (err) {
      notifyError(err, m.failedClear(key))
    } finally {
      setSaving(null)
    }
  }

  // QR onboarding wrote the token + allowlist and asked the backend to restart
  // the gateway. restart_started only means the child spawned; watch its exit
  // so a failed restart lands in the banner instead of a silent "stopped".
  async function handleTelegramApplied(result: TelegramOnboardingApplyResponse) {
    await refreshMessagingPlatforms(scopeProfile, true)

    if (result.restart_started) {
      const connectedBot = result.bot_username ? `${m.states.connected}: @${result.bot_username}` : null

      notify({
        kind: 'success',
        title: m.setupSaved('Telegram'),
        message: [connectedBot, m.telegramQr.savedRestarting].filter(Boolean).join(' · ')
      })
      setRestartNeeded(false)
      const ok = await watchGatewayRestartOutcome()

      if (!ok) {
        setRestartNeeded(true)
        notify({
          kind: 'error',
          title: m.restartFailedManual,
          message: m.restartFailedManualDetail,
          action: { label: m.restartAgain, onClick: () => void runGatewayRestart() },
          secondaryAction: {
            label: m.openLogs,
            onClick: () => void window.hermesDesktop?.revealLogs?.().catch(() => undefined)
          }
        })
      }

      void refreshMessagingPlatforms(scopeProfile, true)

      return
    }

    if (result.needs_restart) {
      // Backend could not spawn the restart (or is too old to try): fall back
      // to the app's own restart action, same as the manual-save path.
      await restartGatewayNow()

      if (result.restart_error) {
        notifyError(new Error(result.restart_error), m.telegramQr.savedRestartFailed(`: ${result.restart_error}`))
        setRestartNeeded(true)
      }
    }
  }

  // Approve/revoke paint from a snapshot immediately, then let the
  // authoritative refresh have the last word. A failed write restores the
  // snapshot so the row never silently disappears on an error.
  async function handleApprove(user: PairingUser) {
    if (!user.request_id) {
      return
    }

    const key = pairingKey(user)
    const snapshot = pairing
    setApproving(key)
    setMessagingPairing(scopeProfile, {
      approved: pairing.approved,
      pending: pairing.pending.filter(row => pairingKey(row) !== key)
    })

    try {
      await approvePairing(user.platform, user.request_id, scopeProfile)
      notify({ kind: 'success', title: m.approvedUser(pairingLabel(user)), message: m.approvedHint })
      await refreshMessagingPairing(scopeProfile)
    } catch (err) {
      setMessagingPairing(scopeProfile, snapshot)
      // 429 is the code path's brute-force lockout — a distinct condition the
      // operator can only wait out, so it gets its own message.
      const lockedOut = err instanceof Error && err.message.includes('429')
      notifyError(err, lockedOut ? m.pairingLockedOut : m.failedApprove(pairingLabel(user)))
    } finally {
      setApproving(null)
    }
  }

  // ConfirmDialog owns the pending → done → close beat and shows an inline
  // error when onConfirm throws, so this rethrows instead of swallowing.
  async function handleRevoke(user: PairingUser) {
    const key = pairingKey(user)
    const snapshot = pairing
    setMessagingPairing(scopeProfile, {
      approved: pairing.approved.filter(row => pairingKey(row) !== key),
      pending: pairing.pending
    })

    try {
      await revokePairing(user.platform, user.user_id, scopeProfile)
      notify({ kind: 'success', title: m.revokedUser(pairingLabel(user)), message: user.platform })
      await refreshMessagingPairing(scopeProfile)
    } catch (err) {
      setMessagingPairing(scopeProfile, snapshot)
      throw err
    }
  }

  return (
    <>
      <section
        {...props}
        className={cn(
          'flex h-full min-w-0 flex-col overflow-hidden bg-(--ui-chat-surface-background)',
          props.className
        )}
      >
        {!platforms ? (
          <PageLoader label={m.loading} />
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            {/* Which profile's gateway this page configures (hidden for
                single-profile users). */}
            <SettingsProfileScope className="border-b border-(--ui-stroke-secondary) px-3 py-2" />
            <DetailColumn
              actionBar={
                selected && (
                  <PlatformActionBar
                    hasEdits={Object.keys(trimEdits(edits[selected.id] || {})).length > 0}
                    onSave={() => void handleSave(selected)}
                    onToggle={enabled => void handleToggle(selected, enabled)}
                    platform={selected}
                    saving={saving}
                  />
                )
              }
              className="flex-1"
            >
              {restartNeeded && (
                <Alert variant="destructive">
                  <AlertTriangle />
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                    <span>{m.restartNeeded}</span>
                    <Button
                      disabled={gatewayRestarting}
                      onClick={() => void restartGatewayNow()}
                      size="sm"
                      variant="secondary"
                    >
                      <RefreshCw className={gatewayRestarting ? 'animate-spin' : undefined} />
                      {gatewayRestarting ? m.restarting : m.restartNow}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {selected && (
                <PlatformDetail
                  approved={approvedByPlatform[selected.id] ?? []}
                  approving={approving}
                  edits={edits[selected.id] || {}}
                  onApprove={user => void handleApprove(user)}
                  onClear={key => void handleClear(selected, key)}
                  onEdit={(key, value) =>
                    setEdits(current => ({
                      ...current,
                      [selected.id]: {
                        ...(current[selected.id] || {}),
                        [key]: value
                      }
                    }))
                  }
                  onRevoke={setPendingRevoke}
                  onTelegramApplied={result => void handleTelegramApplied(result)}
                  pending={pendingByPlatform[selected.id] ?? []}
                  platform={selected}
                  saving={saving}
                  scopeProfile={scopeProfile}
                />
              )}
            </DetailColumn>
          </div>
        )}
      </section>

      <ConfirmDialog
        busyLabel={m.revoking}
        cancelLabel={t.common.cancel}
        confirmLabel={m.revoke}
        description={pendingRevoke ? m.revokeDesc(pairingLabel(pendingRevoke)) : null}
        destructive
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => (pendingRevoke ? handleRevoke(pendingRevoke) : undefined)}
        open={Boolean(pendingRevoke)}
        title={m.revokeTitle}
      />
    </>
  )
}

function PlatformDetail({
  approved,
  approving,
  edits,
  onApprove,
  onClear,
  onEdit,
  onRevoke,
  onTelegramApplied,
  pending,
  platform,
  saving,
  scopeProfile
}: {
  approved: PairingUser[]
  approving: null | string
  edits: Record<string, string>
  onApprove: (user: PairingUser) => void
  onClear: (key: string) => void
  onEdit: (key: string, value: string) => void
  onRevoke: (user: PairingUser) => void
  onTelegramApplied: (result: TelegramOnboardingApplyResponse) => void
  pending: PairingUser[]
  platform: MessagingPlatformInfo
  saving: string | null
  scopeProfile: string | undefined
}) {
  const { t } = useI18n()
  const m = t.messaging
  const [showAdvanced, setShowAdvanced] = useState(false)

  const requiredFields = platform.env_vars.filter(field => field.required)
  const optionalFields = platform.env_vars.filter(field => !field.required && !fieldCopy(field, m).advanced)
  const advancedFields = platform.env_vars.filter(field => !field.required && fieldCopy(field, m).advanced)
  const hiddenCount = advancedFields.length

  return (
    <>
      <header className="flex items-start gap-3">
        <PlatformAvatar platformId={platform.id} platformName={platform.name} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-base font-semibold tracking-tight">{platform.name}</h3>
            <StatePill tone={platformStatusTone(platform)}>{stateLabel(platform.state, m)}</StatePill>
            {/* Resting states earn no pill — only actionable ones. */}
            {!platform.configured && <SetupPill active={false}>{m.needsSetup}</SetupPill>}
            {/* The state pill already reads "gateway stopped" when that is the
                platform's whole story; only add the hint when it is not. */}
            {!platform.gateway_running && platform.state !== 'gateway_stopped' && (
              <SetupPill active={false}>{m.gatewayStopped}</SetupPill>
            )}
          </div>
          <p className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
            {platform.description}
          </p>
          <PlatformHint platform={platform} />
        </div>
      </header>

      {platform.error_message && <ErrorBanner>{platform.error_message}</ErrorBanner>}

      {/* Pending pairing requests. Rendered only when someone is actually
          waiting — an empty-state card here would be permanent chrome on a
          page that is usually about credentials, not approvals. */}
      {pending.length > 0 && (
        <section>
          <SectionTitle>{m.pendingRequests(pending.length)}</SectionTitle>
          <div className="mt-1 grid gap-1">
            {pending.map(user => {
              const busy = approving === pairingKey(user)
              const waited = typeof user.age_minutes === 'number' ? m.waitingSince(user.age_minutes) : null

              return (
                <ListRow
                  action={
                    <Button
                      disabled={busy || !user.request_id}
                      onClick={() => onApprove(user)}
                      size="sm"
                      variant="secondary"
                    >
                      {busy ? m.approving : m.approve}
                    </Button>
                  }
                  // An unnamed requester is only a user id — showing it as
                  // both title and description just repeats itself.
                  description={[user.user_name ? user.user_id : null, waited].filter(Boolean).join(' · ')}
                  key={pairingKey(user)}
                  title={pairingLabel(user)}
                />
              )
            })}
          </div>
        </section>
      )}

      {approved.length > 0 && (
        <section>
          <SectionTitle>{m.approvedUsers(approved.length)}</SectionTitle>
          <div className="mt-1 grid gap-1">
            {approved.map(user => (
              <ListRow
                action={
                  <Button
                    aria-label={m.revokeAria(pairingLabel(user))}
                    onClick={() => onRevoke(user)}
                    size="sm"
                    variant="ghost"
                  >
                    {m.revoke}
                  </Button>
                }
                description={user.user_name ? user.user_id : undefined}
                key={pairingKey(user)}
                title={pairingLabel(user)}
              />
            ))}
          </div>
        </section>
      )}

      {platform.id === 'telegram' && (
        <section>
          <SectionTitle>{m.telegramQr.quickSetup}</SectionTitle>
          <div className="mt-3">
            <TelegramQrSetup onApplied={onTelegramApplied} platform={platform} scopeProfile={scopeProfile} />
          </div>
        </section>
      )}

      <section>
        <SectionTitle>{m.getCredentials}</SectionTitle>
        <p className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {introCopy(platform, m)}
        </p>
        {platform.docs_url && (
          <div className="mt-3">
            <Button asChild size="sm" variant="link">
              <a
                href={platform.docs_url}
                onClick={event => {
                  // Route through the validated external opener instead of
                  // letting Electron resolve the anchor. A packaged build's
                  // empty/relative href resolves to the app's own
                  // index.html file path, which shell.openPath then fails to
                  // open ("file not found"). Plugin platforms (Teams, etc.)
                  // ship no docs_url, so this guard + handler keeps the
                  // button from ever pointing at a local bundle path.
                  event.preventDefault()
                  openExternalLink(platform.docs_url)
                }}
                rel="noreferrer"
                target="_blank"
              >
                {m.openSetupGuide}
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          </div>
        )}
      </section>

      <section>
        <SectionTitle>{m.required}</SectionTitle>
        <div className="mt-3 grid gap-1">
          {requiredFields.length > 0 ? (
            requiredFields.map(field => (
              <MessagingField
                edits={edits}
                field={field}
                key={field.key}
                onClear={onClear}
                onEdit={onEdit}
                saving={saving}
              />
            ))
          ) : (
            <p className="text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
              {m.noTokenNeeded}
            </p>
          )}
        </div>
      </section>

      {optionalFields.length > 0 && (
        <section>
          <SectionTitle>{m.recommended}</SectionTitle>
          <div className="mt-3 grid gap-1">
            {optionalFields.map(field => (
              <MessagingField
                edits={edits}
                field={field}
                key={field.key}
                onClear={onClear}
                onEdit={onEdit}
                saving={saving}
              />
            ))}
          </div>
        </section>
      )}

      {hiddenCount > 0 && (
        <section>
          <button
            className="flex w-full items-center justify-between gap-2 py-0.5 text-left text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setShowAdvanced(value => !value)}
            type="button"
          >
            <span>{m.advanced(hiddenCount)}</span>
            <DisclosureCaret open={showAdvanced} size="0.875rem" />
          </button>
          {showAdvanced && (
            <div className="mt-3 grid gap-1">
              {advancedFields.map(field => (
                <MessagingField
                  edits={edits}
                  field={field}
                  key={field.key}
                  onClear={onClear}
                  onEdit={onEdit}
                  saving={saving}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </>
  )
}

function PlatformActionBar({
  hasEdits,
  onSave,
  onToggle,
  platform,
  saving
}: {
  hasEdits: boolean
  onSave: () => void
  onToggle: (enabled: boolean) => void
  platform: MessagingPlatformInfo
  saving: string | null
}) {
  const { t } = useI18n()
  const m = t.messaging
  const isSavingEnv = saving === `env:${platform.id}`

  return (
    <>
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Switch
          aria-label={platform.enabled ? m.disableAria(platform.name) : m.enableAria(platform.name)}
          checked={platform.enabled}
          disabled={saving === `enabled:${platform.id}`}
          onCheckedChange={onToggle}
        />
        {platform.enabled ? m.enabled : m.disabled}
      </label>

      <div className="ml-auto flex items-center gap-2">
        {hasEdits && <span className="text-xs text-muted-foreground">{m.unsavedChanges}</span>}
        <Button disabled={!hasEdits || isSavingEnv} onClick={onSave} size="sm">
          <Save />
          {isSavingEnv ? m.saving : m.saveChanges}
        </Button>
      </div>
    </>
  )
}

const PLATFORM_INTRO: Record<string, string> = {
  telegram:
    'In Telegram, talk to @BotFather, run /newbot, and copy the token it gives you. Then grab your numeric user ID from @userinfobot.',
  discord:
    'Open the Discord Developer Portal, create an application, add a Bot, then copy its token. Invite the bot to your server with the right scopes.',
  slack:
    'Create a Slack app, enable Socket Mode, install it to your workspace, then copy the bot token and app-level token.',
  mattermost:
    'On your Mattermost server, create a bot account or personal access token, then paste the server URL and token here.',
  matrix: 'Sign in to your homeserver with the bot account, then copy the access token, user ID, and homeserver URL.',
  signal:
    'Run a signal-cli REST bridge somewhere reachable, then point Hermes at the URL and the registered phone number.',
  whatsapp:
    'Start the WhatsApp bridge that ships with Hermes, scan the QR code on first run, then enable the platform.',
  bluebubbles:
    'Run BlueBubbles Server on a Mac with iMessage, expose its API, then point Hermes at the URL with the server password.',
  homeassistant:
    'In Home Assistant, open your profile and create a long-lived access token. Paste it here along with your HA URL.',
  email:
    'Use a dedicated mailbox. For Gmail/Workspace, create an app password and use imap.gmail.com / smtp.gmail.com.',
  sms: 'Get your Twilio Account SID and Auth Token from the Twilio console, plus a phone number that can send SMS.',
  dingtalk: 'Create a DingTalk app in the developer console, then copy the Client ID (App key) and Client Secret here.',
  feishu:
    'Create a Feishu / Lark app, configure the bot capability, and copy the App ID, App secret, and event encryption keys.',
  wecom:
    'Add a group robot in WeCom and copy its webhook key as WECOM_BOT_ID. Send-only — use the WeCom (app) option for two-way.',
  wecom_callback:
    'Set up a WeCom self-built app, expose its callback URL, and provide the corp ID, secret, agent ID, and AES key.',
  weixin:
    "Run `hermes gateway setup`, select Weixin, then scan and confirm the QR code with a personal WeChat account. Hermes connects through Tencent's iLink Bot API and saves the credentials.",
  qqbot: 'Register an app on the QQ Open Platform (q.qq.com) and copy the App ID and Client Secret.',
  api_server:
    'Expose Hermes as an OpenAI-compatible API. Set an auth key, then point Open WebUI / LobeChat / etc. at the host:port.',
  webhook:
    'Run an HTTP server that other tools (GitHub, GitLab, custom apps) can POST to. Use the secret to verify signatures.'
}

const introCopy = (platform: MessagingPlatformInfo, m: Translations['messaging']) =>
  m.platformIntro[platform.id] || PLATFORM_INTRO[platform.id] || platform.description

function MessagingField({
  edits,
  field,
  onClear,
  onEdit,
  saving
}: {
  edits: Record<string, string>
  field: MessagingEnvVarInfo
  onClear: (key: string) => void
  onEdit: (key: string, value: string) => void
  saving: string | null
}) {
  const { t } = useI18n()
  const m = t.messaging
  const copy = fieldCopy(field, m)
  const fieldId = `messaging-field-${field.key}`

  return (
    <ListRow
      action={
        <div className="flex w-full items-center gap-2 @2xl:w-88">
          <Input
            className={CREDENTIAL_CONTROL_CLASS}
            id={fieldId}
            onChange={event => onEdit(field.key, event.target.value)}
            placeholder={field.is_set ? credentialPreview(field.redacted_value) || m.replaceValue : copy.placeholder}
            type={field.is_password ? 'password' : 'text'}
            value={edits[field.key] || ''}
          />
          {field.url && (
            <Tooltip><TooltipTrigger asChild>
              <Button asChild className="size-8 shrink-0" variant="ghost">
                <a href={field.url} rel="noreferrer" target="_blank">
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            </TooltipTrigger><TooltipContent>{m.openDocs}</TooltipContent></Tooltip>
          )}
          {field.is_set && (
            <Tooltip><TooltipTrigger asChild>
              <Button
                className="size-8 shrink-0"
                disabled={saving === `clear:${field.key}`}
                onClick={() => onClear(field.key)}
                variant="ghost"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </TooltipTrigger><TooltipContent>{m.clearField(field.key)}</TooltipContent></Tooltip>
          )}
        </div>
      }
      description={copy.help}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <label htmlFor={fieldId}>{copy.label}</label>
          {field.is_set && <span className="text-2xs font-medium text-primary">{m.saved}</span>}
        </span>
      }
    />
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{children}</h4>
}

function PlatformHint({ platform }: { platform: MessagingPlatformInfo }) {
  const { t } = useI18n()

  // A served secondary's api_server/webhook live on the shared gateway listener under
  // /p/<profile>/: the state pill says connected, this line says where to point the client.
  if (platform.ingress_url) {
    return (
      <p className="mt-2 text-xs leading-5 text-muted-foreground break-all">
        {t.messaging.sharedListenerUrl}{' '}
        <code className="font-mono text-foreground" data-slot="ingress-url">
          {platform.ingress_url}
        </code>
      </p>
    )
  }

  if (!platform.enabled || platform.state === 'connected') {
    return null
  }

  const hint =
    platform.state === 'pending_restart'
      ? t.messaging.hintPendingRestart
      : platform.gateway_running
        ? null
        : t.messaging.hintGatewayStopped

  return hint ? <p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p> : null
}

function StatePill({ children, tone }: { children: string; tone: StatusTone }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium',
        TONE_PILL_CLASS[tone]
      )}
    >
      <StatusDot tone={tone} />
      {children}
    </span>
  )
}

function SetupPill({ active, children }: { active: boolean; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium',
        TONE_PILL_CLASS[active ? 'good' : 'muted']
      )}
    >
      {children}
    </span>
  )
}

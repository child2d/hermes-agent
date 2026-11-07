import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { getSkillContent, type ProfileScope, profileScopeKey, setSkillLocked } from '@/hermes'
import { useI18n } from '@/i18n'
import { Lock, LockOpen } from '@/lib/icons'
import { queryClient } from '@/lib/query-client'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import type { SkillInfo } from '@/types/hermes'

import { PanelPill } from '../../overlays/panel'
import { asText, prettyName } from '../../settings/helpers'
import { DetailHeader } from '../primitives'

import { parseFrontmatter } from './frontmatter'
import { isEditableProvenance } from './skill-provenance'
import { categoryFor, skillsQueryKey } from './skills-data'

export function SkillDetail({
  onArchive,
  onEdit,
  profile,
  skill
}: {
  onArchive: () => void
  onEdit: () => void
  profile?: ProfileScope
  skill: SkillInfo
}) {
  const { t } = useI18n()
  // Origin only, never mutability: external mounts stay editable in place —
  // see ./skill-provenance (commit 8c8fc6c1ec).
  const editable = isEditableProvenance(skill.provenance)

  // The FULL skill — frontmatter metadata + complete SKILL.md body — for any
  // provenance, scoped to the Capabilities profile selector. The row list only
  // carries name/description; the pane shows the whole thing.
  const contentQuery = useQuery({
    queryKey: ['skill-content', skill.name, profileScopeKey(profile)],
    queryFn: () => getSkillContent(skill.name, profile),
    staleTime: 60_000
  })

  // Lock is a user declaration against AGENT edits — offered for every provenance
  // (bundled/hub/external can be locked too) and never blocks the user's own edits.
  const locked = Boolean(skill.locked)
  const [lockPending, setLockPending] = useState(false)

  const setLocked = (name: string, next: boolean) =>
    queryClient.setQueryData<SkillInfo[]>(skillsQueryKey(profile), current =>
      current?.map(row => (row.name === name ? { ...row, locked: next } : row))
    )

  const toggleLock = async () => {
    if (lockPending) {
      return
    }

    const { name } = skill
    const next = !locked
    setLockPending(true)
    await queryClient.cancelQueries({ queryKey: skillsQueryKey(profile), exact: true })
    setLocked(name, next)

    try {
      await setSkillLocked(name, next, profile)
    } catch (err) {
      setLocked(name, !next)
      notifyError(err, t.skills.failedToUpdate(name))
    } finally {
      setLockPending(false)
      void queryClient.invalidateQueries({ queryKey: skillsQueryKey(profile), exact: true })
    }
  }

  const parsed = useMemo(
    () => (contentQuery.data ? parseFrontmatter(contentQuery.data.content) : null),
    [contentQuery.data]
  )

  return (
    <>
      <DetailHeader
        description={asText(skill.description) || t.skills.noDescription}
        pills={
          <>
            <PanelPill>{prettyName(categoryFor(skill))}</PanelPill>
            {(skill.provenance === 'agent' || skill.provenance === 'hub') && (
              <PanelPill tone={skill.provenance === 'agent' ? 'good' : 'muted'}>
                {t.skills.provenance[skill.provenance]}
              </PanelPill>
            )}
          </>
        }
        title={skill.name}
      />
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          {editable && (
            <>
              <Button onClick={onEdit} size="sm" variant="link">
                {t.skills.edit}
              </Button>
              <Button className="text-destructive hover:text-destructive" onClick={onArchive} size="sm" variant="link">
                {t.skills.archive}
              </Button>
            </>
          )}
          <Button
            aria-pressed={locked}
            className={cn(locked && 'text-foreground')}
            data-slot="skill-lock-toggle"
            disabled={lockPending}
            onClick={() => void toggleLock()}
            size="sm"
            variant="link"
          >
            {locked ? <Lock /> : <LockOpen />}
            {locked ? t.skills.locked : t.skills.lock}
          </Button>
        </div>
        <p className="text-xs text-(--ui-text-tertiary)">{locked ? t.skills.lockHint : t.skills.unlockedHint}</p>
      </div>
      {parsed && parsed.meta.length > 0 && (
        <div className="grid gap-1 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3">
          {parsed.meta.map(([key, value]) => (
            <div className="flex gap-2 text-2xs leading-4" key={key}>
              <span className="w-24 shrink-0 font-medium text-(--ui-text-tertiary)">{key}</span>
              <span className="min-w-0 whitespace-pre-wrap break-words text-(--ui-text-secondary)">{value}</span>
            </div>
          ))}
        </div>
      )}
      {contentQuery.isLoading ? (
        <PageLoader className="h-40" label={t.skills.loading} />
      ) : parsed ? (
        <pre
          className="overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-3 font-mono text-2xs leading-relaxed"
          data-selectable-text="true"
        >
          {parsed.body.trim() || t.skills.noDescription}
        </pre>
      ) : null}
    </>
  )
}

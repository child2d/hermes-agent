import { compactNumber } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ArchiveSkillConfirmDialog } from '@/app/learning/archive-skill-confirm-dialog'
import { CodeEditor } from '@/components/chat/code-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardGrid, EntityCard } from '@/components/ui/entity-card'
import { Switch } from '@/components/ui/switch'
import { editLearningNode, getLearningNode, type ProfileScope, profileScopeKey, setSkillEnabled } from '@/hermes'
import { useI18n } from '@/i18n'
import { Codecs, persistentAtom } from '@/lib/persisted'
import { queryClient } from '@/lib/query-client'
import { invalidateSlashCompletions } from '@/lib/slash-completion-cache'
import { cn } from '@/lib/utils'
import { notify, notifyError } from '@/store/notifications'
import type { SkillInfo } from '@/types/hermes'

import {
  DetailColumn,
  DetailPane,
  ListStrip,
  ListStripMenu,
  type ListStripMenuToggle
} from '../../master-detail'
import { prettyName } from '../../settings/helpers'
import { CapabilityEmpty, SortButton } from '../primitives'

import { SkillDetail } from './skill-detail'
import { categoryFor, filteredSkills, skillsQueryKey, usageOf } from './skills-data'

// The "more below" hint for the card band — a scroll container that clips a
// whole row of cards. Fades the last 2rem ONLY while something is still below
// the fold, so a short list never dims its own last row (same maskImage idea as
// the profile switcher's scroll mask; see the plugin's BAND_FADE twin).
const BAND_FADE = 'linear-gradient(to bottom, #000 calc(100% - 2rem), transparent)'

// Sort direction for the Skills list — persisted so the tab remembers
// most/least-used across navigations and restarts.
const $skillsSortDesc = persistentAtom('hermes.desktop.capabilities.skillsSortDesc', true, Codecs.bool)

// Card chips: category, with non-default origins badged.
function skillBadges(skill: SkillInfo): ReactNode {
  const category = prettyName(categoryFor(skill))
  const provenance = skill.provenance

  return (
    <>
      <span className="truncate text-2xs text-muted-foreground/50">{category}</span>
      {provenance === 'agent' && (
        <Badge className="shrink-0 normal-case" variant="default">
          learned
        </Badge>
      )}
      {provenance === 'hub' && (
        <Badge className="shrink-0 normal-case" variant="secondary">
          hub
        </Badge>
      )}
    </>
  )
}

interface SkillsTabProps {
  /** The scope's skill list, straight from the shell's query. */
  skills: SkillInfo[]
  /** Every read and write targets this connection/profile pair. */
  profile: ProfileScope
  query: string
  /** The page shell owns the search field; accepted from the shared tab
   *  contract but not rendered here. */
  onQueryChange?: (value: string) => void
  installedPending?: boolean
  installedError?: unknown
  onRefresh: () => void
}

/** The Skills tab: the skills installed in the scoped profile, with learned-skill
 *  editing and enable/disable. It lists what is INSTALLED and changes nothing
 *  about where skills come from — the install catalog is a separate surface
 *  (this fork's is the enterprise plugin's own tab, not a catalog rendered
 *  here). */
export function SkillsTab(props: SkillsTabProps) {
  // Remounted on scope changes so an old profile's editor, confirmation or
  // pending write cannot enter another.
  return <ScopedSkillsTab key={profileScopeKey(props.profile)} {...props} />
}

function ScopedSkillsTab({
  onRefresh,
  profile,
  query,
  skills,
  installedPending = false,
  installedError
}: SkillsTabProps) {
  const { t } = useI18n()
  const skillsSortDesc = useStore($skillsSortDesc)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)

  // Learned/local skills are editable + archivable, mirroring the memory
  // graph (same /api/learning/node endpoints — delete archives, restorable
  // via `hermes curator restore`).
  const [skillEditor, setSkillEditor] = useState<null | { name: string }>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillSaving, setSkillSaving] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<null | string>(null)

  const mounted = useRef(true)
  const mutationBusy = useRef(false)
  const editorRequest = useRef(0)
  const saving = useRef(false)

  // eslint-disable-next-line no-restricted-syntax -- lifecycle guard drops stale async completions; it does not mirror an atom
  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
      editorRequest.current += 1
    }
  }, [])

  const setSkills = useCallback(
    (fn: (cur: SkillInfo[] | undefined) => SkillInfo[] | undefined) =>
      queryClient.setQueryData<SkillInfo[]>(skillsQueryKey(profile), prev => fn(prev) ?? prev),
    [profile]
  )

  const visibleSkills = useMemo(() => filteredSkills(skills, query, skillsSortDesc), [query, skills, skillsSortDesc])

  // Keep a valid selection: fall back to the first visible row when the
  // current selection is filtered out (or nothing is selected yet).
  const activeSkill = useMemo(
    () => visibleSkills.find(s => s.name === selectedSkill) ?? visibleSkills[0] ?? null,
    [selectedSkill, visibleSkills]
  )

  // The backend saves one disabled-list config value: serialize individual and
  // bulk changes together, not merely the members of a bulk action.
  async function applyEnabled(targets: SkillInfo[], enabled: boolean, bulk = false) {
    if (mutationBusy.current || installedPending || installedError || targets.length === 0) {
      return
    }

    mutationBusy.current = true
    setBulkBusy(true)
    let done = 0

    try {
      await queryClient.cancelQueries({ queryKey: skillsQueryKey(profile), exact: true })

      for (const row of targets) {
        if (!mounted.current) {
          break
        }

        const previous =
          queryClient.getQueryData<SkillInfo[]>(skillsQueryKey(profile))?.find(skill => skill.name === row.name) ?? row

        setSkills(current => current?.map(skill => (skill.name === row.name ? { ...skill, enabled } : skill)))

        try {
          await setSkillEnabled(row.name, enabled, profile)
          done += 1
        } catch (err) {
          if (mounted.current) {
            setSkills(current =>
              current?.map(skill =>
                skill.name === row.name && skill.enabled === enabled ? { ...skill, enabled: previous.enabled } : skill
              )
            )
          }

          throw err
        }
      }

      if (bulk && mounted.current) {
        notify({ kind: 'success', title: t.skills.bulkUpdated(done), message: '' })
      }
    } catch (err) {
      if (mounted.current) {
        notifyError(err, t.skills.failedToUpdate(bulk ? t.skills.tabSkills : targets[0].name))
      }
    } finally {
      invalidateSlashCompletions()
      void queryClient.invalidateQueries({ queryKey: skillsQueryKey(profile), exact: true })
      mutationBusy.current = false

      if (mounted.current) {
        setBulkBusy(false)
      }
    }
  }

  const controlsDisabled = bulkBusy || installedPending || Boolean(installedError)

  // Bulk always means the whole profile, never just a search/filter result.
  const bulkSwitch: ListStripMenuToggle = {
    checked: skills.length > 0 && skills.every(skill => skill.enabled),
    disabled: controlsDisabled || skills.length === 0,
    label: t.skills.all,
    onToggle: checked =>
      void applyEnabled(
        skills.filter(skill => skill.enabled !== checked),
        checked,
        true
      )
  }

  // "Never used" = zero recorded activity. The pruning move for a 100+ skill
  // install: keep the workhorses, shed the noise.
  const disableUnused = () =>
    void applyEnabled(
      skills.filter(skill => skill.enabled && usageOf(skill) === 0),
      false,
      true
    )

  // The band's bottom fade, measured rather than assumed: it is on only while
  // the grid has more below the fold, so a short list (or a scrolled-to-bottom
  // one) never dims its own last row.
  const bandRef = useRef<HTMLDivElement>(null)
  const [bandMore, setBandMore] = useState(false)

  const measureBand = useCallback(() => {
    const el = bandRef.current

    if (!el) {
      return
    }

    const more = el.scrollHeight - el.scrollTop - el.clientHeight > 8

    setBandMore(current => (current === more ? current : more))
  }, [])

  useEffect(() => {
    const el = bandRef.current

    measureBand()
    el?.addEventListener('scroll', measureBand, { passive: true })
    window.addEventListener('resize', measureBand)

    return () => {
      el?.removeEventListener('scroll', measureBand)
      window.removeEventListener('resize', measureBand)
    }
    // Re-measure when the grid's own height changes (a filter, a resize of the
    // band): the element identity is stable, the content is not.
  }, [measureBand, visibleSkills.length])

  const openSkillEditor = async (name: string) => {
    if (saving.current || skillEditor?.name === name) {
      return
    }

    const request = ++editorRequest.current

    try {
      const node = await getLearningNode(name, profile)

      if (!mounted.current || request !== editorRequest.current) {
        return
      }

      setSkillEditor({ name })
      setSkillDraft(node.content)
    } catch (err) {
      if (mounted.current && request === editorRequest.current) {
        notifyError(err, name)
      }
    }
  }

  const closeSkillEditor = () => {
    editorRequest.current += 1
    setSkillEditor(null)
  }

  const saveSkillEdit = async () => {
    if (!skillEditor || saving.current) {
      return
    }

    const editor = skillEditor
    const request = editorRequest.current
    saving.current = true
    setSkillSaving(true)

    try {
      const result = await editLearningNode(editor.name, skillDraft, profile)

      if (!result.ok) {
        throw new Error(result.message)
      }

      void queryClient.invalidateQueries({ queryKey: ['skill-content', editor.name, profileScopeKey(profile)] })
      void queryClient.invalidateQueries({ queryKey: skillsQueryKey(profile), exact: true })
      invalidateSlashCompletions()

      if (!mounted.current) {
        return
      }

      notify({ kind: 'success', title: t.skills.skillUpdated, message: t.skills.appliesToNewSessions(editor.name) })

      if (request === editorRequest.current) {
        setSkillEditor(null)
      }

      onRefresh()
    } catch (err) {
      if (mounted.current) {
        notifyError(err, editor.name)
      }
    } finally {
      saving.current = false

      if (mounted.current) {
        setSkillSaving(false)
      }
    }
  }

  const skillEditorPane = skillEditor && (
    <DetailPane
      actions={
        <Button disabled={skillSaving} onClick={() => void saveSkillEdit()} size="sm">
          {skillSaving ? t.common.saving : t.common.save}
        </Button>
      }
      id="skill-editor"
      onClose={closeSkillEditor}
      title={<span className="text-2xs font-normal text-muted-foreground/60">{skillEditor.name}/SKILL.md</span>}
    >
      <CodeEditor
        disabled={skillSaving}
        filePath="SKILL.md"
        initialValue={skillDraft}
        key={skillEditor.name}
        onCancel={closeSkillEditor}
        onChange={setSkillDraft}
        onSave={() => void saveSkillEdit()}
      />
    </DetailPane>
  )

  if (visibleSkills.length === 0) {
    return <CapabilityEmpty noun="skills" query={query} />
  }

  return (
    <>
      {/* Top/Bottom, never left/right. A card grid needs WIDTH (columns) where a
          record needs the reading measure, so the grid takes a 40% band ABOVE
          the detail instead of a rail beside it. The SKILL.md editor
          (`skillEditorPane`) still docks at the very bottom, exactly as it did
          in the `pane` slot of `MasterDetail`. */}
      <div className="flex h-full min-h-0 flex-col">
        {/* One gutter, three edges: the strip's own pl-2 + this pl-3 lands the
            strip text at 20px, the grid's p-2 lands every card BOX at the same
            20px, and `DetailColumn width="full"` puts the record's text there
            too. Before this the strip sat at 16px, the cards at 8px and the
            detail at 20px — three different left edges in one stack. */}
        <div className="flex min-h-0 shrink-0 basis-2/5 flex-col border-b border-(--ui-stroke-tertiary) py-2 pr-3 pl-3">
          <ListStrip
            left={<SortButton desc={skillsSortDesc} onFlip={() => $skillsSortDesc.set(!$skillsSortDesc.get())} />}
            right={
              <ListStripMenu
                items={[
                  {
                    disabled: controlsDisabled || !skills.some(skill => skill.enabled && usageOf(skill) === 0),
                    label: t.skills.disableUnused,
                    onSelect: disableUnused
                  }
                ]}
                label={t.skills.tabSkills}
                toggle={bulkSwitch}
              />
            }
          />
          {/* px-2 on top of the container's pl-3 lands every card BOX at 20px,
              the same left edge as the strip text above it and the record's text
              below it. */}
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 [scrollbar-gutter:stable]"
            ref={bandRef}
            style={bandMore ? { maskImage: BAND_FADE } : undefined}
          >
            <CardGrid>
              {visibleSkills.map(skill => (
                <EntityCard
                  actions={
                    <Switch
                      aria-label={skill.name}
                      checked={skill.enabled}
                      className={cn('cursor-pointer', !skill.enabled && 'opacity-60')}
                      disabled={controlsDisabled}
                      onCheckedChange={enabled => void applyEnabled([skill], enabled)}
                      title={skill.name}
                    />
                  }
                  active={activeSkill?.name === skill.name}
                  badges={skillBadges(skill)}
                  className={cn(!skill.enabled && 'opacity-70')}
                  description={skill.description}
                  key={skill.name}
                  meta={usageOf(skill) > 0 ? `×${compactNumber(usageOf(skill))}` : undefined}
                  onSelect={() => setSelectedSkill(skill.name)}
                  rowKey={`skill:${skill.name}`}
                  title={skill.name}
                />
              ))}
            </CardGrid>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <DetailColumn footer={t.skills.changesApplyNewSessions} width="full">
            {activeSkill && (
              <SkillDetail
                onArchive={() => {
                  if (!saving.current) {
                    setArchiveTarget(activeSkill.name)
                  }
                }}
                onEdit={() => void openSkillEditor(activeSkill.name)}
                profile={profile}
                skill={activeSkill}
              />
            )}
          </DetailColumn>
        </div>
        {skillEditorPane}
      </div>
      {archiveTarget && (
        <ArchiveSkillConfirmDialog
          onApply={() => {
            const name = archiveTarget

            const snapshot =
              queryClient.getQueryData<SkillInfo[]>(skillsQueryKey(profile))?.find(skill => skill.name === name) ??
              skills.find(skill => skill.name === name)

            void queryClient.cancelQueries({ queryKey: skillsQueryKey(profile), exact: true })
            setSkills(current => current?.filter(skill => skill.name !== name))
            invalidateSlashCompletions()

            if (skillEditor?.name === name) {
              closeSkillEditor()
            }

            // Restore only this row; never clobber intervening toggles or installs.
            return () => {
              if (mounted.current) {
                setSkills(current =>
                  snapshot && current && !current.some(skill => skill.name === name) ? [...current, snapshot] : current
                )
              }

              void queryClient.invalidateQueries({ queryKey: skillsQueryKey(profile), exact: true })
            }
          }}
          onClose={() => setArchiveTarget(null)}
          onFailure={(err, name) => {
            if (mounted.current) {
              notifyError(err, name)
            }
          }}
          onSuccess={() => {
            void queryClient.invalidateQueries({ queryKey: skillsQueryKey(profile), exact: true })

            if (mounted.current) {
              onRefresh()
            }
          }}
          open
          profile={profile}
          skillId={archiveTarget}
          skillName={archiveTarget}
        />
      )}
    </>
  )
}

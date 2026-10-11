import { compactNumber } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ArchiveSkillConfirmDialog } from '@/app/learning/archive-skill-confirm-dialog'
import { CodeEditor } from '@/components/chat/code-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardGrid, EntityCard } from '@/components/ui/entity-card'
import { Switch } from '@/components/ui/switch'
import {
  editLearningNode,
  getLearningNode,
  type ProfileScope,
  setSkillEnabled
} from '@/hermes'
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
  /** The (connection, profile) scope every read and write routes to. */
  profile: ProfileScope
  query: string
  /** Page-level refresh: a saved skill edit reloads the same way the refresh
   *  hotkey does, counts and slash completions included. */
  onRefresh: () => void
}

/** The Skills tab: the skills installed in the scoped profile, with learned-skill
 *  editing and enable/disable. It lists what is INSTALLED and changes nothing
 *  about where skills come from — the install catalog is a separate surface
 *  (this fork's is the enterprise plugin's own tab, not a catalog rendered
 *  here). */
export function SkillsTab({ onRefresh, profile, query, skills }: SkillsTabProps) {
  const { t } = useI18n()
  const skillsSortDesc = useStore($skillsSortDesc)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null)

  // Learned/local skills are editable + archivable, mirroring the memory
  // graph (same /api/learning/node endpoints — delete archives, restorable
  // via `hermes curator restore`).
  const [skillEditor, setSkillEditor] = useState<null | { content: string; name: string }>(null)
  const [skillDraft, setSkillDraft] = useState('')
  const [skillSaving, setSkillSaving] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<null | string>(null)

  // Optimistic write-through against the scoped Skills key: toggles/bulk/
  // archive repaint instantly; the next background refetch reconciles.
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

  async function handleToggleSkill(skill: SkillInfo, enabled: boolean) {
    setSkills(current => current?.map(row => (row.name === skill.name ? { ...row, enabled } : row)) ?? current)

    try {
      await setSkillEnabled(skill.name, enabled, profile)
      // A disabled skill loses its `/name` command, so the composer's cached
      // `/` list has to be dropped along with the row repaint.
      invalidateSlashCompletions()
    } catch (err) {
      setSkills(
        current => current?.map(row => (row.name === skill.name ? { ...row, enabled: !enabled } : row)) ?? current
      )
      notifyError(err, t.skills.failedToUpdate(skill.name))
    }
  }

  // Sequential on purpose: each toggle is a config read-modify-write on the
  // backend; parallel calls would race the disabled-list save.
  async function bulkApply(targets: SkillInfo[], enabled: boolean) {
    if (bulkBusy || targets.length === 0) {
      return
    }

    setBulkBusy(true)

    let done = 0

    try {
      for (const row of targets) {
        await setSkillEnabled(row.name, enabled, profile)
        setSkills(cur => cur?.map(r => (r.name === row.name ? { ...r, enabled } : r)) ?? cur)
        done += 1
      }

      notify({ kind: 'success', title: t.skills.bulkUpdated(done), message: '' })
    } catch (err) {
      notifyError(err, t.skills.failedToUpdate(t.skills.tabSkills))
    } finally {
      invalidateSlashCompletions()
      setBulkBusy(false)
    }
  }

  // Bulk actions ("All" master switch, "Disable unused") and the master-switch
  // state target the WHOLE tab, never the search-filtered view — a tab-wide
  // control that silently scoped to the current query would be a lie.
  const allEnabled = skills.length > 0 && skills.every(s => s.enabled)

  // One switch line covering enable-all/disable-all.
  const bulkSwitch: ListStripMenuToggle = {
    checked: allEnabled,
    disabled: bulkBusy,
    label: t.skills.all,
    onToggle: checked =>
      void bulkApply(
        skills.filter(row => row.enabled !== checked),
        checked
      )
  }

  // "Never used" = zero recorded activity. The pruning move for a 100+ skill
  // install: keep the workhorses, shed the noise.
  const disableUnused = () =>
    bulkApply(
      skills.filter(skill => skill.enabled && usageOf(skill) === 0),
      false
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
    try {
      const node = await getLearningNode(name, profile)

      setSkillEditor({ content: node.content, name })
      setSkillDraft(node.content)
    } catch (err) {
      notifyError(err, name)
    }
  }

  const saveSkillEdit = async () => {
    if (!skillEditor) {
      return
    }

    setSkillSaving(true)

    try {
      await editLearningNode(skillEditor.name, skillDraft, profile)
      notify({
        kind: 'success',
        title: t.skills.skillUpdated,
        message: t.skills.appliesToNewSessions(skillEditor.name)
      })
      setSkillEditor(null)
      onRefresh()
    } catch (err) {
      notifyError(err, skillEditor.name)
    } finally {
      setSkillSaving(false)
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
      onClose={() => setSkillEditor(null)}
      title={<span className="text-2xs font-normal text-muted-foreground/60">{skillEditor.name}/SKILL.md</span>}
    >
      <CodeEditor
        filePath="SKILL.md"
        initialValue={skillEditor.content}
        key={skillEditor.name}
        onCancel={() => setSkillEditor(null)}
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
                    disabled: bulkBusy,
                    label: t.skills.disableUnused,
                    onSelect: () => void disableUnused()
                  }
                ]}
                label={t.skills.tabSkills}
                toggle={bulkSwitch}
              />
            }
          />
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
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
                      disabled={bulkBusy}
                      onCheckedChange={enabled => void handleToggleSkill(skill, enabled)}
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
                onArchive={() => setArchiveTarget(activeSkill.name)}
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
            const snapshot = skills

            setSkills(current => current?.filter(skill => skill.name !== name) ?? current)
            invalidateSlashCompletions()

            if (skillEditor?.name === name) {
              setSkillEditor(null)
            }

            return () => setSkills(() => snapshot)
          }}
          onClose={() => setArchiveTarget(null)}
          onFailure={(err, name) => notifyError(err, name)}
          open
          profile={profile}
          skillId={archiveTarget}
          skillName={archiveTarget}
        />
      )}
    </>
  )
}

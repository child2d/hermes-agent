import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useSearchParams } from 'react-router'

import { type BaymaxScene, fetchProjects } from './api'

export const PROJECT_STORAGE_KEY = 'hermes.desktop.baymax.projectId'
export const SCENES: BaymaxScene[] = ['ALL_TODO', 'DUE_SOON', 'MY_CREATED', 'MY_PROCESSING']
export const FOCUSES = ['all', 'overdue', 'today', 'undated'] as const
export type Focus = (typeof FOCUSES)[number]

/** The URL owns all navigation state. Storage only seeds a new visit. */
export function useBaymaxRoute() {
  const [params, setParams] = useSearchParams()

  const projects = useQuery({
    queryKey: ['baymax', 'projects'],
    queryFn: fetchProjects,
    retry: false,
    staleTime: 300_000
  })

  const requested = params.get('project') ?? globalThis.localStorage?.getItem(PROJECT_STORAGE_KEY) ?? ''
  const project = projects.data?.find(item => item.id === requested)?.id ?? projects.data?.[0]?.id ?? ''
  const scene = SCENES.find(value => value === params.get('scene')) ?? 'ALL_TODO'
  const focus = FOCUSES.find(value => value === params.get('focus')) ?? 'all'
  const search = params.get('q') ?? ''
  // A project disappearing must not attach its issue id to the fallback project.
  const selectedId = params.get('project') === project ? params.get('issue') : null

  useEffect(() => {
    if (!projects.data || !project || params.get('project') === project) {
      return
    }

    setParams(
      previous => {
        const next = new URLSearchParams(previous)
        next.set('project', project)
        next.delete('issue')

        return next
      },
      { replace: true }
    )
  }, [project, projects.data, params, setParams])

  const change = (values: Record<string, string | null>, replace = false) => {
    setParams(
      previous => {
        const next = new URLSearchParams(previous)

        for (const [key, value] of Object.entries(values)) {
          if (value) {
            next.set(key, value)
          } else {
            next.delete(key)
          }
        }

        return next
      },
      { replace }
    )
  }

  return {
    projects,
    project,
    scene,
    focus,
    search,
    selectedId,
    change,
    pickProject: (id: string) => {
      globalThis.localStorage?.setItem(PROJECT_STORAGE_KEY, id)
      change({ project: id, scene: null, focus: null, q: null, issue: null })
    }
  }
}

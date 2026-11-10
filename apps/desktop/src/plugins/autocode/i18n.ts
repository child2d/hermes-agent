import { type PluginLocaleBundles, type PluginTranslate, usePluginI18n } from '@hermes/plugin-sdk'
import { useMemo } from 'react'

import { ID } from './shared'

type AutoCodeMessages = {
  nav: string
  title: string
  openExternal: string
  retry: string
  offlineTitle: string
  offlineBody: string
  offlineHint: string
  loading: string
}

const EN: AutoCodeMessages = {
  nav: 'AutoCode',
  title: 'AutoCode',
  openExternal: 'Open in browser',
  retry: 'Retry',
  offlineTitle: 'AutoCode is not running',
  offlineBody: 'Start the AutoCode frontend (default http://127.0.0.1:5173), then retry.',
  offlineHint: 'From D:\\codeup\\autoCode run .\\scripts\\start.ps1',
  loading: 'Connecting to AutoCode…'
}

export const AUTOCODE_LOCALES: PluginLocaleBundles = {
  en: EN,
  zh: {
    ...EN,
    nav: 'AutoCode',
    title: 'AutoCode',
    openExternal: '在浏览器打开',
    retry: '重试',
    offlineTitle: 'AutoCode 未启动',
    offlineBody: '请先启动 AutoCode 前端（默认 http://127.0.0.1:5173），然后重试。',
    offlineHint: '在 D:\\codeup\\autoCode 运行 .\\scripts\\start.ps1',
    loading: '正在连接 AutoCode…'
  },
  'zh-hant': {
    ...EN,
    nav: 'AutoCode',
    title: 'AutoCode',
    openExternal: '在瀏覽器開啟',
    retry: '重試',
    offlineTitle: 'AutoCode 未啟動',
    offlineBody: '請先啟動 AutoCode 前端（預設 http://127.0.0.1:5173），然後重試。',
    offlineHint: '在 D:\\codeup\\autoCode 執行 .\\scripts\\start.ps1',
    loading: '正在連線 AutoCode…'
  }
}

export function useAutoCode() {
  const t = usePluginI18n(ID) as PluginTranslate

  return useMemo(
    () => ({
      loading: t('loading'),
      nav: t('nav'),
      offlineBody: t('offlineBody'),
      offlineHint: t('offlineHint'),
      offlineTitle: t('offlineTitle'),
      openExternal: t('openExternal'),
      retry: t('retry'),
      title: t('title')
    }),
    [t]
  )
}

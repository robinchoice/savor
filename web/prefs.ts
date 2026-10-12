import { useEffect, useState } from 'preact/hooks'
import type { PanelId, Rect, Split } from './Layout'

// How Savor looks on this device.
export type Theme = 'system' | 'light' | 'dark'
export type Density = 'normal' | 'compact'
export type Device = 'fit' | 'desktop' | 'phone'
export interface Prefs {
  theme: Theme
  conversations: Density
  messages: Density
  // What a conversation in the list shows besides its title.
  show: { label: boolean; agent: boolean; date: boolean; count: boolean }
  feedbackButton: boolean
  // The floating bug button and where it was dragged to, null for its default spot.
  bugButton: boolean
  bugAt: { x: number; y: number } | null
  // The size the page beside the chat is drawn in.
  previewDevice: Device
  // Workflow groups marked as “Not a duplicate” in All projects.
  notDuplicates: string[]
  // The project the All board last showed alone, null for all of them.
  boardProject: string | null
  // The terminal panel below the project.
  terminalOpen: boolean
  terminalMax: boolean
  // Where the panels are docked, null for the default; with free windows, where each window is.
  layout: Split | null
  freeWindows: boolean
  windows: Partial<Record<PanelId, Rect>> | null
  // Action → key, see Shortcuts.tsx. Empty until set.
  shortcuts: Record<string, string>
}

const KEY = 'savor-prefs'
let prefs: Prefs = {
  conversations: 'normal',
  messages: 'normal',
  show: { label: true, agent: true, date: true, count: true },
  feedbackButton: true,
  bugButton: false,
  bugAt: null,
  previewDevice: 'fit',
  notDuplicates: [],
  boardProject: null,
  terminalOpen: false,
  terminalMax: false,
  layout: null,
  freeWindows: false,
  windows: null,
  shortcuts: {},
  ...JSON.parse(localStorage.getItem(KEY) ?? '{}'),
  theme: (localStorage.getItem('savor-theme') as Theme | null) ?? 'system',
}
const listeners = new Set<(p: Prefs) => void>()
const systemDark = matchMedia('(prefers-color-scheme: dark)')

function apply() {
  const root = document.documentElement
  root.dataset.theme = prefs.theme === 'system' ? (systemDark.matches ? 'dark' : 'light') : prefs.theme
  root.dataset.messages = prefs.messages
}
systemDark.addEventListener('change', apply)
apply()

export const currentPrefs = () => prefs

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch }
  const { theme, ...rest } = prefs
  localStorage.setItem('savor-theme', theme)
  localStorage.setItem(KEY, JSON.stringify(rest))
  apply()
  listeners.forEach((l) => l(prefs))
}

export function usePrefs() {
  const [value, setValue] = useState(prefs)
  useEffect(() => {
    listeners.add(setValue)
    return () => void listeners.delete(setValue)
  }, [])
  return value
}

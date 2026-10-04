import { useEffect, useState } from 'preact/hooks'

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
  // Browser mode: how wide the chat beside the page is, and the size the page is drawn in.
  chatWidth: number
  previewDevice: Device
}

const KEY = 'savor-prefs'
let prefs: Prefs = {
  conversations: 'normal',
  messages: 'normal',
  show: { label: true, agent: true, date: true, count: true },
  feedbackButton: true,
  chatWidth: 420,
  previewDevice: 'fit',
  ...JSON.parse(localStorage.getItem(KEY) ?? '{}'),
  theme: (localStorage.getItem('savor-theme') as Theme | null) ?? 'dark',
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

import { useEffect, useRef, useState } from 'preact/hooks'
import { Keyboard, X } from 'lucide-preact'
import { currentPrefs, setPrefs, usePrefs } from './prefs'

// What a key can do. Each device starts without any keys; the setup and the dialog offer STANDARD.
export const ACTIONS = {
  new: 'New conversation',
  next: 'Next conversation that needs you',
  previous: 'Back to where Next came from',
  composer: 'Focus the composer',
  voice: 'Start or stop voice input',
  stop: 'Stop the agent',
  finish: 'Finish the conversation',
  conversations: 'Conversations',
  files: 'Files',
  workflows: 'Workflows',
  browser: 'Switch between chat and browser',
  terminal: 'Open or close the terminal',
  project1: 'Project tab 1',
  project2: 'Project tab 2',
  project3: 'Project tab 3',
  project4: 'Project tab 4',
  project5: 'Project tab 5',
  project6: 'Project tab 6',
  project7: 'Project tab 7',
  project8: 'Project tab 8',
  project9: 'Project tab 9',
  shortcuts: 'Show the shortcuts',
}
export type Action = keyof typeof ACTIONS

export const STANDARD: Record<string, string> = {
  new: 'C',
  next: 'J',
  previous: 'K',
  composer: '/',
  voice: 'V',
  stop: 'Ctrl+.',
  finish: 'E',
  conversations: 'Shift+C',
  files: 'Shift+F',
  workflows: 'Shift+W',
  browser: 'B',
  terminal: 'Ctrl+`',
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`project${n}`, `Alt+${n}`])),
  shortcuts: '?',
}

// A key as it is stored and shown, e.g. "J", "Shift+C", "Ctrl+`" or "?". Null for a modifier alone.
function comboOf(e: KeyboardEvent) {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return null
  let key = e.key === ' ' ? 'Space' : e.key
  if (/^[a-z0-9]$/i.test(key)) key = key.toUpperCase()
  // On a Mac, Alt turns letters into other characters.
  else if (e.altKey) key = /^(?:Key|Digit)(.)$/.exec(e.code)?.[1] ?? key
  // Shift is already in a character like ? or /.
  const shift = e.shiftKey && (/^[A-Z0-9]$/.test(key) || e.key.length > 1)
  return [e.ctrlKey && 'Ctrl', e.metaKey && 'Meta', e.altKey && 'Alt', shift && 'Shift', key].filter(Boolean).join('+')
}

export const keyLabel = (combo: string) => combo.replace('Meta', '⌘')
export const useKey = (action: Action) => usePrefs().shortcuts[action]

// The views on screen register what an action does there; the one mounted last wins.
type Handler = { current: (() => void) | false | undefined }
const handlers = new Map<Action, Handler[]>()
export function useShortcut(action: Action, run: (() => void) | false | undefined) {
  const ref = useRef(run)
  ref.current = run
  useEffect(() => {
    const list = handlers.get(action) ?? []
    handlers.set(action, list)
    list.push(ref)
    return () => void list.splice(list.indexOf(ref), 1)
  }, [action])
}

// The dialog takes the next key for itself while it records one.
let recorder: ((combo: string | null) => void) | null = null

// Captured, so keys reach Savor before the terminal or the composer take them.
addEventListener(
  'keydown',
  (e) => {
    if (e.isComposing) return
    const combo = comboOf(e)
    if (!combo) return
    if (recorder) {
      e.preventDefault()
      e.stopPropagation()
      recorder(combo === 'Escape' ? null : combo)
      recorder = null
      return
    }
    const keys = Object.entries(currentPrefs().shortcuts)
    const find = (c: string) => keys.find(([, k]) => k === c)?.[0] as Action | undefined
    // Keys without Ctrl, ⌘ or Alt type in a field or the preview; they also work with Alt, there too.
    const typing = (e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable], img.screen')
    let action = find(combo)
    if (typing && action && !/^(Ctrl|Meta|Alt)\+/.test(combo) && !/^F\d+$/.test(combo)) action = undefined
    if (!action && e.altKey && !e.ctrlKey && !e.metaKey) action = find(combo.replace('Alt+', ''))
    const run = action && [...(handlers.get(action) ?? [])].reverse().find((h) => h.current)?.current
    if (!run) return
    e.preventDefault()
    e.stopPropagation()
    run()
  },
  true,
)

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { shortcuts } = usePrefs()
  const [recording, setRecording] = useState<Action | null>(null)
  useEffect(() => () => void (recorder = null), [])
  const set = (action: Action, combo: string | null) => {
    const next = Object.fromEntries(Object.entries(currentPrefs().shortcuts).filter(([a, k]) => a !== action && k !== combo))
    setPrefs({ shortcuts: combo ? { ...next, [action]: combo } : next })
  }
  const record = (action: Action) => {
    setRecording(action)
    recorder = (combo) => {
      setRecording(null)
      if (combo) set(action, combo)
    }
  }
  return (
    <div class="overlay" onClick={onClose}>
      <div class="dialog shortcuts-dialog" onClick={(e) => e.stopPropagation()}>
        <header class="dialog-head">
          <Keyboard size={18} />
          <div class="dialog-title">
            <b>Keyboard shortcuts</b>
          </div>
          <button class="icon-btn" title="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div class="dialog-body">
          <p class="muted small">Click a key and press the new one, Esc cancels. A key used elsewhere moves here. Keys without Ctrl, ⌘ or Alt also work with Alt, and need it in a text field.</p>
          {(Object.keys(ACTIONS) as Action[]).map((a) => (
            <div key={a} class="setting">
              <span>{ACTIONS[a]}</span>
              <button class={`key ${recording === a ? 'recording' : ''}`} onClick={() => record(a)}>
                {recording === a ? 'Press a key…' : shortcuts[a] ? <kbd>{keyLabel(shortcuts[a])}</kbd> : <span class="muted">Not set</span>}
              </button>
              <button class="icon-btn" title="Remove" disabled={!shortcuts[a]} onClick={() => set(a, null)}>
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
        <footer class="dialog-foot">
          <div class="row">
            <button class="ghost" onClick={() => setPrefs({ shortcuts: STANDARD })}>
              Use Savor's suggestions
            </button>
            <button class="ghost" disabled={!Object.keys(shortcuts).length} onClick={() => setPrefs({ shortcuts: {} })}>
              Clear all
            </button>
          </div>
          <button class="primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}

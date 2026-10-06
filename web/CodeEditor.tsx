import { useEffect, useRef } from 'preact/hooks'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { oneDark } from '@codemirror/theme-one-dark'

const nonce = document.querySelector('meta[name="csp-nonce"]')?.getAttribute('content') ?? ''
const base = EditorView.theme({ '&': { fontSize: '13px' }, '.cm-scroller': { fontFamily: "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, monospace", lineHeight: '1.55' } })
const themeFor = () => (document.documentElement.dataset.theme === 'light' ? [] : oneDark)

// CodeMirror for project files. The language comes from the file name and loads on demand; the
// theme follows the app theme. Loaded as its own chunk (see Files.tsx).
export default function CodeEditor({ value, path, line, onChange, onSave }: { value: string; path: string; line?: number; onChange: (v: string) => void; onSave?: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<EditorView>()
  const change = useRef(onChange)
  const save = useRef(onSave)
  change.current = onChange
  save.current = onSave

  useEffect(() => {
    const theme = new Compartment()
    const lang = new Compartment()
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          EditorView.cspNonce.of(nonce),
          basicSetup,
          keymap.of([{ key: 'Mod-s', run: () => (save.current?.(), true) }, indentWithTab]),
          base,
          theme.of(themeFor()),
          lang.of([]),
          EditorView.updateListener.of((u) => u.docChanged && change.current(u.state.doc.toString())),
        ],
      }),
    })
    editor.current = view
    LanguageDescription.matchFilename(languages, path)
      ?.load()
      .then((support) => view.dispatch({ effects: lang.reconfigure(support) }))
    const observer = new MutationObserver(() => view.dispatch({ effects: theme.reconfigure(themeFor()) }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      observer.disconnect()
      view.destroy()
    }
  }, [path])

  // A line asked for in the route gets the caret and is scrolled into the middle.
  useEffect(() => {
    const view = editor.current
    if (!view || !line) return
    const at = view.state.doc.line(Math.min(line, view.state.doc.lines)).from
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
    view.focus()
  }, [path, line])

  return <div class="code-editor" ref={host} />
}

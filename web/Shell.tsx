import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { api, type Project } from './api'
import { transport } from './transport'
import type { ShellHost } from './Terminal'

const THEME = { background: '#0a0a0c', foreground: '#d7d7dc', cursor: '#d7d7dc', selectionBackground: '#3a3a42' }
const FONT = "'Geist Mono Variable', ui-monospace, 'SF Mono', Menlo, monospace"
// Links open in the browser; the desktop app hands every new window to the system's.
const openLink = (_: MouseEvent, uri: string) => window.open(uri, '_blank', 'noreferrer')

const KEYS: [string, string][] = [
  ['esc', '\x1b'],
  ['tab', '\t'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['←', '\x1b[D'],
  ['→', '\x1b[C'],
  ['|', '|'],
  ['~', '~'],
  ['/', '/'],
  ['-', '-'],
]

// One shell of a project's terminal panel, which is the `host`.
export default function Shell({ project, id, restart, host }: { project: Project; id: string; restart: { current: () => void }; host: ShellHost }) {
  const ref = useRef<HTMLDivElement>(null)
  // Phone keyboards lack these keys, so touch screens get a row of them.
  const touch = useMemo(() => matchMedia('(pointer: coarse)').matches, [])
  const [ctrl, setCtrl] = useState(false)
  const ctrlRef = useRef(false)
  ctrlRef.current = ctrl
  const send = useRef<(data: string) => void>(() => {})

  useEffect(() => {
    const base = `/projects/${project.id}/terminal`
    const term = new XTerm({ fontFamily: FONT, fontSize: 13, cursorBlink: true, scrollback: 5000, theme: THEME, allowProposedApi: true, linkHandler: { activate: openLink } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Emoji and other wide characters take the width the shell's programs expect, as on the server.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon(openLink))
    // Programs may copy to the clipboard (OSC 52), but not read it.
    term.loadAddon(new ClipboardAddon(undefined, { readText: () => '', writeText: (_, text) => navigator.clipboard.writeText(text) }))
    const size = () => ({ id, cols: term.cols, rows: term.rows })
    const open = () => api('POST', `${base}/open`, size()).catch((e: Error) => term.write(`\r\n${e.message}\r\n`))
    restart.current = () => api('POST', `${base}/restart`, size()).catch((e: Error) => term.write(`\r\n${e.message}\r\n`))

    // Keystrokes go out one request at a time, so they arrive in order.
    let running = false
    let pending = ''
    let sending = false
    const flush = async () => {
      if (sending || !pending) return
      sending = true
      const data = pending
      pending = ''
      await api('POST', `${base}/input`, { id, data }).catch(() => {})
      sending = false
      flush()
    }
    const run = async (command: string) => {
      if (!running) await open()
      // Several lines are pasted for review, not run: the shell would run each line on its own.
      const data = command.includes('\n') ? `\x1b[200~${command}\x1b[201~` : `${command}\r`
      await api('POST', `${base}/input`, { id, data }).catch((e: Error) => term.write(`\r\n${e.message}\r\n`))
      term.focus()
    }
    send.current = (data) => {
      if (!running) return void open()
      pending += data
      flush()
    }
    // Keys typed while the clipboard is read follow the paste.
    let held: string[] | null = null
    term.onData((data) => {
      if (ctrlRef.current && data.length === 1) {
        data = String.fromCharCode(data.toUpperCase().charCodeAt(0) & 31)
        setCtrl(false)
      }
      if (held) held.push(data)
      else send.current(data)
    })
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true
      // Ctrl+Shift+C copies the selection, as in other terminals on Linux and Windows.
      if (e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection())
        e.preventDefault()
        return false
      }
      // Ctrl+V pastes text. Without text in the clipboard it goes to the program, which may paste an
      // image from there itself, as Claude Code does.
      if (!e.shiftKey && e.code === 'KeyV') {
        e.preventDefault()
        if (held) return false
        held = []
        navigator.clipboard
          .readText()
          .catch(() => '')
          .then((text) => {
            const keys = held!
            held = null
            if (text) term.paste(text)
            else send.current('\x16')
            keys.forEach((data) => send.current(data))
          })
        return false
      }
      return true
    })
    let resizing: ReturnType<typeof setTimeout>
    term.onResize(() => {
      clearTimeout(resizing)
      resizing = setTimeout(() => running && api('POST', `${base}/resize`, size()).catch(() => {}), 100)
    })

    const onData = (raw: string) => {
      const m = JSON.parse(raw)
      if (m.reset) term.reset()
      if (m.o) term.write(m.o)
      if ('running' in m) running = m.running
      if ('exit' in m) {
        running = false
        term.write('\r\n\x1b[2m[Shell exited. Press any key to start a new one.]\x1b[0m\r\n')
      }
    }
    const observer = new ResizeObserver(() => fit.fit())
    let closed = false
    let stop = () => {}
    // The cell size is measured on open, so the font has to be there first.
    document.fonts.load(`13px ${FONT}`).finally(() => {
      if (closed) return
      term.open(ref.current!)
      // The GPU draws lines and box characters without gaps. Automated browsers keep the DOM renderer,
      // whose rows tests read.
      if (!navigator.webdriver)
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => webgl.dispose())
          term.loadAddon(webgl)
        } catch {}
      fit.fit()
      observer.observe(ref.current!)
      if (host.focus()) term.focus()
      stop = transport.stream(`/api${base}/stream?id=${id}`, onData)
      const command = host.attach(run)
      if (command) run(command)
      else open()
    })
    return () => {
      closed = true
      host.detach(run)
      stop()
      observer.disconnect()
      clearTimeout(resizing)
      term.dispose()
    }
  }, [project.id, id])

  return (
    <>
      <div class="terminal-screen" ref={ref} />
      {touch && (
        <div class="terminal-keys">
          <button class={ctrl ? 'on' : ''} onClick={() => setCtrl(!ctrl)}>
            ctrl
          </button>
          {KEYS.map(([label, data]) => (
            <button key={label} onClick={() => send.current(data)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

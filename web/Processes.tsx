import { useEffect, useRef, useState } from 'preact/hooks'
import { ExternalLink, ScrollText, Square } from 'lucide-preact'
import { api, useApi, type Proc, type Project } from './api'
import { transport } from './transport'

export function ProcessesPopover({ project, close }: { project: Project; close: () => void }) {
  const base = `/projects/${project.id}/processes`
  const [procs] = useApi<Proc[]>(base, (e) => e.type === 'processes' && e.projectId === project.id)
  const [log, setLog] = useState<{ pid: number; text: string } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const on = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close()
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [])

  const showLog = async (pid: number) => setLog({ pid, text: (await transport.request('GET', `/api${base}/${pid}/log`)).body })
  const kill = (p: Proc) => confirm(`Stop ${p.name} (PID ${p.pid})?`) && api('POST', `${base}/${p.pid}/kill`)

  return (
    <div class="menu right procs" ref={ref}>
      <div class="menu-label">Background processes</div>
      {procs && !procs.length && <p class="muted small pad">Nothing running. Agents register dev servers and watchers here.</p>}
      {procs?.map((p) => (
        <div key={p.pid} class="proc">
          <div class="proc-main">
            <b>{p.name}</b> <span class="muted small">PID {p.pid}</span>
            <div class="mono small muted">{p.command}</div>
            <a class="small" href={`#/p/${project.id}/t/${p.threadId}`} onClick={close}>
              Open conversation
            </a>
          </div>
          <div class="row">
            {p.url && (
              <a class="icon-btn" href={p.url} target="_blank" rel="noreferrer" title={p.url}>
                <ExternalLink size={15} />
              </a>
            )}
            {p.log && (
              <button class="icon-btn" title="Log" onClick={() => showLog(p.pid)}>
                <ScrollText size={15} />
              </button>
            )}
            <button class="icon-btn danger" title="Stop" onClick={() => kill(p)}>
              <Square size={14} />
            </button>
          </div>
        </div>
      ))}
      {log && <pre class="log">{log.text || '(empty)'}</pre>}
    </div>
  )
}

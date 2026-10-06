import { Fragment } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Gauge } from 'lucide-preact'
import { api, type Usage } from './api'

const SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

// The last answer, so a menu shows the limits as soon as it opens.
let last: Usage[] = []

// How much of the Claude and Codex subscription limits is used, refreshed every minute. Stale values
// are asked for again every few seconds until the agents have answered.
export function useUsage() {
  const [usage, setUsage] = useState(last)
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout>
    const load = () => {
      clearTimeout(retry)
      if (document.visibilityState !== 'visible') return
      api<Usage[]>('GET', '/usage').then((u) => {
        setUsage((last = u))
        if (u.some((x) => x.stale)) retry = setTimeout(load, 3000)
      }, () => {})
    }
    load()
    const timer = setInterval(load, 60_000)
    addEventListener('visibilitychange', load)
    return () => (clearInterval(timer), clearTimeout(retry), removeEventListener('visibilitychange', load))
  }, [])
  return usage
}

const UPDATING = 'Updating, the values shown are from earlier'

// How much of each limit is used, as segmented bars.
export function UsageBars({ usage }: { usage: Usage }) {
  return (
    <div class={`usage-bars ${usage.stale ? 'stale' : ''}`} title={usage.stale ? UPDATING : undefined}>
      {usage.stale && (
        <div class="row muted">
          <span class="spinner small" /> Updating…
        </div>
      )}
      {usage.windows.map((w) => (
        <div key={w.label} title={w.resets ? `Resets ${w.resets}` : undefined}>
          <div class="row">
            <span>{w.label}</span>
            <span class="spacer" />
            <span class="muted">{w.percent}% used</span>
          </div>
          <div class={`segments ${w.percent >= 90 ? 'high' : ''}`}>
            {Array.from({ length: 20 }, (_, i) => (
              <i key={i} class={i < Math.round(w.percent / 5) ? 'on' : ''} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function UsageMeter() {
  const usage = useUsage()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const on = (e: MouseEvent) => !e.composedPath().includes(ref.current!) && setOpen(false)
    setTimeout(() => addEventListener('click', on))
    return () => removeEventListener('click', on)
  }, [open])
  if (!usage.length) return null
  const stale = usage.some((u) => u.stale)
  return (
    <div class="menu-anchor wide-only" ref={ref}>
      <button class={`pill usage-pill ${stale ? 'stale' : ''}`} title={stale ? UPDATING : 'Subscription limits'} onClick={() => setOpen(!open)}>
        {stale ? <span class="spinner small" /> : <Gauge size={15} />}
        {usage.map((u) => {
          const top = Math.max(...u.windows.map((w) => w.percent))
          return (
            <span key={u.provider} class={top >= 90 ? 'high' : ''}>
              {SHORT[u.provider] ?? u.name} {top}%
            </span>
          )
        })}
      </button>
      {open && (
        <div class="menu right usage">
          {usage.map((u) => (
            <Fragment key={u.provider}>
              <div class="menu-label">
                {u.name}
                {u.stale && <span class="muted"> · Updating…</span>}
              </div>
              {u.windows.map((w) => (
                <div key={w.label} class={`usage-row ${u.stale ? 'stale' : ''}`}>
                  <div class="row">
                    <span>{w.label}</span>
                    <span class="spacer" />
                    <b>{w.percent}%</b>
                  </div>
                  <div class="usage-bar">
                    <i class={w.percent >= 90 ? 'high' : ''} style={{ width: `${Math.min(w.percent, 100)}%` }} />
                  </div>
                  {w.resets && <small>Resets {w.resets}</small>}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

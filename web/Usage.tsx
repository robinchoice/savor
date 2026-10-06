import { Fragment } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Gauge } from 'lucide-preact'
import { api, type Usage } from './api'

const SHORT: Record<string, string> = { claude: 'Claude', codex: 'Codex' }

// The last answer, so a menu shows the limits as soon as it opens.
let last: Usage[] = []

// How much of the Claude and Codex subscription limits is used, refreshed every minute.
export function useUsage() {
  const [usage, setUsage] = useState(last)
  useEffect(() => {
    const load = () => document.visibilityState === 'visible' && api<Usage[]>('GET', '/usage').then((u) => setUsage((last = u)), () => {})
    load()
    const timer = setInterval(load, 60_000)
    addEventListener('visibilitychange', load)
    return () => (clearInterval(timer), removeEventListener('visibilitychange', load))
  }, [])
  return usage
}

// What is left of each limit, as segmented bars.
export function UsageLeft({ usage }: { usage: Usage }) {
  return (
    <div class="usage-left">
      {usage.windows.map((w) => {
        const left = Math.max(0, 100 - w.percent)
        return (
          <div key={w.label} title={w.resets ? `Resets ${w.resets}` : undefined}>
            <div class="row">
              <span>{w.label}</span>
              <span class="spacer" />
              <span class="muted">{left}% left</span>
            </div>
            <div class={`segments ${left <= 10 ? 'low' : ''}`}>
              {Array.from({ length: 20 }, (_, i) => (
                <i key={i} class={i < Math.round(left / 5) ? 'on' : ''} />
              ))}
            </div>
          </div>
        )
      })}
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
  return (
    <div class="menu-anchor wide-only" ref={ref}>
      <button class="pill usage-pill" title="Subscription limits" onClick={() => setOpen(!open)}>
        <Gauge size={15} />
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
              <div class="menu-label">{u.name}</div>
              {u.windows.map((w) => (
                <div key={w.label} class="usage-row">
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

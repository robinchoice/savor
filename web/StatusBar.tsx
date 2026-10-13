import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { X } from 'lucide-preact'
import { api, useApi } from './api'
import { UsageStatus } from './Usage'

interface LiveRun { id: number; projectId: string; project: string; workflow: string; number: number; url: string; status: string; failed: boolean; startedAt: string; done: number; total: number; typicalMs: number | null }

// m:ss, or h:mm:ss for long runs.
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const mm = `${Math.floor(s / 60) % 60}`
  const ss = `${s % 60}`.padStart(2, '0')
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

// One line at the bottom: the subscription limits on the left, the running GitHub Actions runs of all
// projects on the right.
export function StatusBar() {
  return (
    <footer class="statusbar">
      <UsageStatus />
      <CiStatus />
    </footer>
  )
}

// Pixels per second the runs scroll by when they don't fit, and the space before they start again.
const SPEED = 40
const GAP = 40

// Per run: project, number, workflow, finished steps and how long it runs, with the time a run of this
// workflow usually still needs. A failed run stays until it is dismissed. When the runs don't fit, they
// scroll through as two copies in a row, so the second one follows the first without a gap.
function CiStatus() {
  const [runs] = useApi<LiveRun[]>('/ci', (e) => e.type === 'ci' || e.type === 'connected')
  const [now, setNow] = useState(Date.now())
  const running = runs?.some((r) => !r.failed)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  const box = useRef<HTMLDivElement>(null)
  const copy = useRef<HTMLDivElement>(null)
  // Seconds for one pass, rounded so a ticking clock doesn't change the speed; 0 while the runs fit.
  const [secs, setSecs] = useState(0)
  const shown = !!runs?.length
  useLayoutEffect(() => {
    if (!shown) return
    const measure = () => {
      const width = copy.current!.offsetWidth - parseFloat(getComputedStyle(copy.current!).paddingRight)
      setSecs(width > box.current!.clientWidth ? Math.ceil((width + GAP) / SPEED / 5) * 5 : 0)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(box.current!)
    observer.observe(copy.current!)
    return () => observer.disconnect()
  }, [shown])
  if (!runs?.length) return null
  // A function, since Preact can't mount the same elements twice.
  const items = () =>
    runs.map((r, i) => {
      const elapsed = now - Date.parse(r.startedAt)
      const rest = r.typicalMs && !r.failed ? r.typicalMs - elapsed : null
      return (
        <span key={r.id} class={`ci-run ${r.failed ? 'failed' : ''}`}>
          {i > 0 && runs[i - 1].project === r.project ? <span class="muted">·</span> : <span>{r.project}</span>}
          <a href={r.url} target="_blank" rel="noreferrer" title={`${r.workflow} #${r.number}: ${r.failed ? 'failed' : r.status.replace('_', ' ')}. Open on GitHub`}>
            #{r.number} <span class="muted">{r.workflow}</span>
            {r.failed ? (
              ' failed'
            ) : (
              <>
                {r.total > 0 && <span class="muted"> {r.done}/{r.total}</span>}
                <span class="elapsed"> +{clock(elapsed)}</span>
                {rest !== null && rest > 0 && <span class="muted" title="Left, after the median of the last successful runs"> ~{clock(rest)}</span>}
              </>
            )}
          </a>
          {r.failed && (
            <button class="ci-dismiss" title="Dismiss" onClick={() => api('POST', '/ci/dismiss', { id: r.id })}>
              <X size={12} />
            </button>
          )}
        </span>
      )
    })
  return (
    <div class="status-ci">
      <span class="muted">CI</span>
      <div class="ci-ticker" ref={box}>
        <div class={`ci-track ${secs ? 'moving' : ''}`} style={{ '--ticker-s': `${secs}s` }}>
          <div class="ci-runs" ref={copy}>{items()}</div>
          {secs > 0 && <div class="ci-runs" aria-hidden="true">{items()}</div>}
        </div>
      </div>
    </div>
  )
}

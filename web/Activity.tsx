import { useEffect, useRef, useState } from 'preact/hooks'
import { Brain, ChevronDown, ChevronRight, Pencil, Terminal, Wrench } from 'lucide-preact'
import { duration, formatTime, PROVIDER_NAMES, type ActivityEvent, type Message } from './api'
import { plural, t } from './i18n'

const ICONS = { thinking: Brain, command: Terminal, edit: Pencil, note: Wrench }
type Filter = 'all' | ActivityEvent['type']
const filters = (): [Filter, string][] => [
  ['all', t('All')],
  ['command', t('Commands')],
  ['edit', t('Edits')],
  ['note', t('Other')],
  ['thinking', t('Thoughts')],
]

interface Step { e: ActivityEvent; start: number; end: number }
interface Turn { input?: Message; steps: Step[]; start: number; end: number }

const exact = (n: number) => (n < 1000 ? `${n} ms` : n < 60_000 ? `${(n / 1000).toFixed(1)} s` : duration(n))

// Each step belongs to the input before the moment it was logged, so a turn shows what the agent did for one request.
// Thinking and text arrive complete and span the time since the step before, which may lie in an earlier turn: they start with their turn.
function turns(events: ActivityEvent[], messages: Message[], now: number): Turn[] {
  const inputs = messages.filter((m) => m.kind === 'user' && m.delivered !== false)
  const out: Turn[] = []
  for (const e of events) {
    const end = e.finishedAt ? Date.parse(e.finishedAt) : now
    const logged = e.type === 'thinking' || e.type === 'note' ? (e.finishedAt ?? e.time) : e.time
    const input = inputs.filter((m) => m.ts <= logged).at(-1)
    let turn = out.at(-1)
    if (!turn || turn.input !== input) out.push((turn = { input, steps: [], start: Infinity, end: 0 }))
    const start = Math.min(end, Math.max(Date.parse(e.time), input ? Date.parse(input.ts) : 0))
    turn.steps.push({ e, start, end })
    turn.start = Math.min(turn.start, start)
    turn.end = Math.max(turn.end, end)
  }
  return out
}

// The agent's activity as a timeline per request: how long each step took, where in the turn it ran, and the whole of it on click.
export function ActivityLog({ events, messages }: { events: ActivityEvent[]; messages: Message[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<number | null>(null)
  useEffect(() => ref.current?.scrollTo({ top: ref.current.scrollHeight }), [events.length])
  if (!events.length) return <p class="muted center">{t('No activity yet.')}</p>
  const now = Date.now()
  const all = turns(events, messages, now)
  return (
    <div class="activity" ref={ref}>
      <div class="segmented activity-filter">
        {filters().map(([id, label]) => (
          <button key={id} class={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>
      {all.map((turn, i) => {
        const key = turn.input?.id ?? `before-${i}`
        const isOpen = open[key] ?? i === all.length - 1
        const span = Math.max(1, turn.end - turn.start)
        const shown = turn.steps.filter((s) => filter === 'all' || s.e.type === filter)
        const count = (type: ActivityEvent['type']) => turn.steps.filter((s) => s.e.type === type).length
        const agent = turn.input?.modelInfo
        const Chevron = isOpen ? ChevronDown : ChevronRight
        return (
          <section key={key} class="activity-turn">
            <button class="activity-turn-head" onClick={() => setOpen({ ...open, [key]: !isOpen })}>
              <Chevron size={13} />
              <span class="activity-label">{turn.input?.text?.split('\n')[0] || t('Earlier activity')}</span>
              <span class="muted small">{span >= 1000 ? duration(span) : ''}</span>
            </button>
            {isOpen && (
              <>
                <div class="activity-turn-meta muted small">
                  {[
                    agent && [PROVIDER_NAMES[agent.provider], agent.model].filter(Boolean).join(' · '),
                    formatTime(new Date(turn.start).toISOString()),
                    count('command') && plural(count('command'), '{n} command', '{n} commands'),
                    count('edit') && plural(count('edit'), '{n} edit', '{n} edits'),
                  ].filter(Boolean).join(' · ')}
                </div>
                {shown.map(({ e, start, end }) => {
                  const Icon = ICONS[e.type]
                  const took = end - start
                  const left = ((start - turn.start) / span) * 100
                  return (
                    <div key={e.id} class={`activity-row ${e.type} ${e.finishedAt ? '' : 'running'} ${expanded === e.id ? 'expanded' : ''}`} onClick={() => setExpanded(expanded === e.id ? null : e.id)}>
                      <span class="activity-bar" style={{ left: `${left}%`, width: `${Math.max(0.5, Math.min(100 - left, (took / span) * 100))}%` }} />
                      <Icon size={14} />
                      <span class="activity-label" title={e.label}>
                        {e.label}
                        {expanded === e.id && (
                          <span class="activity-detail muted">
                            {formatTime(new Date(start).toISOString())} · {e.finishedAt ? exact(took) : t('Running')}
                          </span>
                        )}
                      </span>
                      <span class="muted small">{!e.finishedAt ? <span class="spinner small" /> : took >= 1000 ? duration(took) : ''}</span>
                    </div>
                  )
                })}
              </>
            )}
          </section>
        )
      })}
    </div>
  )
}

import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { go, type Project, type Thread } from './api'
import { t } from './i18n'

type Axis = 'x' | 'y'

// Follows one pointer from pointerdown: locks to an axis after 8px and reports distance and speed (px/ms) on release.
// Moves are read from the window, so a finger that leaves the element keeps dragging.
function track(e: PointerEvent, on: { move?: (dx: number, dy: number, axis: Axis) => void; end: (dx: number, dy: number, vx: number, vy: number, axis: Axis | null) => void }) {
  const [x0, y0] = [e.clientX, e.clientY]
  let axis: Axis | null = null
  let [lx, ly, lt, vx, vy] = [x0, y0, e.timeStamp, 0, 0]
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return
    const [dx, dy] = [ev.clientX - x0, ev.clientY - y0]
    if (!axis && Math.hypot(dx, dy) > 8) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
    const dt = Math.max(1, ev.timeStamp - lt)
    ;[vx, vy, lx, ly, lt] = [(ev.clientX - lx) / dt, (ev.clientY - ly) / dt, ev.clientX, ev.clientY, ev.timeStamp]
    if (axis) on.move?.(dx, dy, axis)
  }
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', up)
    removeEventListener('pointercancel', up)
    on.end(ev.clientX - x0, ev.clientY - y0, vx, vy, ev.type === 'pointerup' ? axis : null)
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
  addEventListener('pointercancel', up)
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
// The click that ends a drag must not open what was dragged.
const swallowClick = (el: HTMLElement) => {
  const stop = (ev: Event) => {
    ev.preventDefault()
    ev.stopPropagation()
  }
  el.addEventListener('click', stop, { capture: true })
  setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 400)
}

// The order the bar walks through is the list's when a conversation was opened from it. Reading one moves it within
// For you, and its neighbours must not change under the thumb. New conversations join at the end.
let walk: string[] = []
export const resetWalk = () => (walk = [])

// iOS gives an installed web app no back gesture, so the left edge leads back to the list there. Elsewhere the
// browser or Android already uses that edge.
const ownEdge = matchMedia('(display-mode: standalone)').matches && 'standalone' in navigator

// Below the chat on a phone: swipe sideways for the previous or next conversation of the project, up for all of them.
export function ThumbBar({ project, threadId, siblings, children }: { project: Project; threadId: string; siblings: Thread[]; children: ComponentChildren }) {
  const ids = siblings.map((t) => t.id)
  if (!walk.includes(threadId)) walk = ids
  walk = [...walk.filter((id) => ids.includes(id)), ...ids.filter((id) => !walk.includes(id))]
  const at = walk.indexOf(threadId)
  const byId = new Map(siblings.map((t) => [t.id, t]))
  const [prev, next] = [byId.get(walk[at - 1]), byId.get(walk[at + 1])]
  const [peek, setPeek] = useState(false)
  const [sheet, setSheet] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)

  const layout = () => bar.current!.closest<HTMLElement>('.thread-layout')!
  const slide = (x: number, animate = false) => {
    const el = layout()
    el.style.transition = animate ? 'transform 0.25s ease-out' : ''
    el.style.transform = x ? `translateX(${x}px)` : ''
  }
  const open = (path: string, x: number) => {
    if (reduced()) return go(path)
    slide(x, true)
    setTimeout(() => go(path), 250)
  }
  const step = (dir: 1 | -1) => {
    const t = dir > 0 ? next : prev
    if (!t) return
    setPeek(true)
    open(`/p/${project.id}/t/${t.id}`, -dir * layout().offsetWidth)
  }

  // The titles fill most of the bar, so a swipe may start on them; it just doesn't count as a tap then.
  const onBar = (e: PointerEvent) => {
    setPeek(true)
    track(e, {
      move: (dx, dy, axis) => {
        if (axis === 'y') return bar.current!.classList.toggle('lifting', dy < -20)
        // Past the first or last conversation the view only gives a little.
        slide((dx > 0 ? prev : next) ? dx : dx / 4)
      },
      end: (dx, dy, vx, vy, axis) => {
        bar.current!.classList.remove('lifting')
        if (axis) swallowClick(bar.current!)
        if (axis === 'y' && (dy < -30 || vy < -0.4)) setSheet(true)
        const w = layout().offsetWidth
        const dir = axis !== 'x' ? 0 : (dx < -w / 4 || vx < -0.5) && next ? 1 : (dx > w / 4 || vx > 0.5) && prev ? -1 : 0
        if (dir) step(dir)
        else slide(0, axis === 'x')
      },
    })
  }

  const onEdge = (e: PointerEvent) =>
    track(e, {
      move: (dx, _dy, axis) => axis === 'x' && slide(Math.max(0, dx)),
      end: (dx, _dy, vx, _vy, axis) => {
        if (axis === 'x' && (dx > layout().offsetWidth / 3 || vx > 0.5)) open(`/p/${project.id}`, layout().offsetWidth)
        else slide(0, true)
      },
    })

  const onGrabber = (e: PointerEvent) =>
    track(e, {
      move: (_dx, dy, axis) => {
        if (axis === 'y') sheetRef.current!.style.transform = `translateY(${Math.max(0, dy)}px)`
      },
      end: (_dx, dy, _vx, vy, axis) => {
        sheetRef.current!.style.transform = ''
        if (!axis || dy > 80 || vy > 0.5) setSheet(false)
      },
    })

  useEffect(() => {
    if (!sheet) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSheet(false)
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [sheet])

  const peekOf = (t: Thread | undefined, side: string) =>
    peek && t && (
      <div class={`peek ${side}`} aria-hidden="true">
        <h1>{t.summary ?? t.title}</h1>
      </div>
    )

  return (
    <>
      {peekOf(prev, 'prev')}
      {peekOf(next, 'next')}
      {ownEdge && <div class="edge-back" onPointerDown={onEdge} />}
      <div class="thumb-bar" ref={bar} onPointerDown={onBar}>
        <button class="thumb-prev" disabled={!prev} onClick={() => step(-1)} title={prev && (prev.summary ?? prev.title)}>
          {prev && `‹ ${prev.summary ?? prev.title}`}
        </button>
        <button class="thumb-grab" title={t('All conversations of the project')} onClick={() => setSheet(true)}>
          <i />
          {at + 1} / {walk.length}
        </button>
        <button class="thumb-next" disabled={!next} onClick={() => step(1)} title={next && (next.summary ?? next.title)}>
          {next && `${next.summary ?? next.title} ›`}
        </button>
      </div>
      {sheet && (
        <div class="thumb-sheet-wrap" onClick={(e) => e.target === e.currentTarget && setSheet(false)}>
          <div class="thumb-sheet" ref={sheetRef} role="dialog" aria-label={t('Conversations')}>
            <div class="thumb-grabber" onPointerDown={onGrabber}>
              <i />
            </div>
            <div class="cards" onClick={(e) => (e.target as HTMLElement).closest('a') && setSheet(false)}>
              {children}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// Swiping a result to the right finishes it. Touch only: a mouse drags links and selects text.
export function swipeToFinish(e: PointerEvent, finish: () => Promise<unknown>) {
  if (e.pointerType !== 'touch') return
  const card = e.currentTarget as HTMLElement
  const row = card.parentElement!
  track(e, {
    move: (dx, _dy, axis) => {
      if (axis !== 'x') return
      row.classList.add('swiping')
      card.style.transform = `translateX(${Math.max(0, dx)}px)`
    },
    end: (dx, _dy, vx, _vy, axis) => {
      if (axis === 'x') swallowClick(card)
      const done = axis === 'x' && (dx > card.offsetWidth * 0.35 || vx > 0.6)
      card.style.transition = 'transform 0.2s ease-out'
      card.style.transform = done ? 'translateX(100%)' : ''
      const reset = () => {
        card.style.transform = card.style.transition = ''
        row.classList.remove('swiping')
      }
      if (done) finish().catch(reset)
      else setTimeout(reset, 200)
    },
  })
}

type Undo = { text: string; undo: () => void; ms: number }
let offer: ((u: Undo) => void) | undefined
export const offerUndo = (text: string, undo: () => void, ms = 5000) => offer?.({ text, undo, ms })

export function UndoToast() {
  const [undo, setUndo] = useState<Undo | null>(null)
  useEffect(() => {
    offer = setUndo
    return () => (offer = undefined)
  }, [])
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), undo.ms)
    return () => clearTimeout(timer)
  }, [undo])
  return (
    undo && (
      <div class="undo-toast" role="status">
        <span>{undo.text}</span>
        <button
          onClick={() => {
            undo.undo()
            setUndo(null)
          }}
        >
          {t('Undo')}
        </button>
      </div>
    )
  )
}

import { createContext, type ComponentChildren } from 'preact'
import { createPortal } from 'preact/compat'
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { GripVertical, PanelsTopLeft } from 'lucide-preact'
import { setPrefs, usePrefs } from './prefs'

// On a computer the project's panels sit in a dock: the conversation list, the main view (a conversation's chat
// or the current page), the stage beside the chat (preview or changes) and the terminal. Each panel renders through
// a portal into a box that is created once and never moves in the DOM, so an iframe or a terminal keeps running
// while the panels are resized or rearranged; only the position of its leaf changes. On a phone panels render in
// place, as before.

export type PanelId = 'list' | 'main' | 'stage' | 'terminal'
export interface Split { dir: 'row' | 'col'; children: Node[]; sizes: number[] }
export type Node = PanelId | Split
export interface Rect { x: number; y: number; w: number; h: number }

const IDS: PanelId[] = ['list', 'main', 'stage', 'terminal']
const NAMES: Record<PanelId, string> = { list: 'Conversations', main: 'Chat', stage: 'Preview', terminal: 'Terminal' }
// In each split one panel takes the room that is left, the first of these it contains; the others keep their size.
const GROWS: PanelId[] = ['stage', 'main', 'list', 'terminal']
// The layout as it was before panels could move: list, chat and stage side by side, the terminal below all of them.
export const DEFAULT_LAYOUT: Split = { dir: 'col', sizes: [0, 300], children: [{ dir: 'row', sizes: [330, 420, 0], children: ['list', 'main', 'stage'] }, 'terminal'] }
const GAP = 1
const MIN = 160
const HEAD = 28
const GRID = 8

// Phones and narrow windows, where panels do not fit side by side.
export function useNarrow() {
  const query = useMemo(() => matchMedia('(max-width: 860px)'), [])
  const [narrow, setNarrow] = useState(query.matches)
  useEffect(() => {
    const change = () => setNarrow(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return narrow
}

// ---- which panels are there ----

const shown = new Map<PanelId, { owner: object; title: string }>()
const hidden = new Set<PanelId>()
let arranging = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((l) => l())
function useStore() {
  const [, rerender] = useState(0)
  useLayoutEffect(() => {
    const l = () => rerender((n) => n + 1)
    listeners.add(l)
    // Panels below announced themselves before this listened.
    l()
    return () => void listeners.delete(l)
  }, [])
}
export const setArranging = (on: boolean) => {
  arranging = on
  notify()
}

const Docked = createContext(false)
const boxes = new Map<PanelId, HTMLElement>()
const box = (id: PanelId) => boxes.get(id) ?? boxes.set(id, document.createElement('div')).get(id)!

export function Panel({ id, title = NAMES[id], class: cls = '', children }: { id: PanelId; title?: string; class?: string; children: ComponentChildren }) {
  const docked = useContext(Docked)
  const owner = useMemo(() => ({}), [])
  useLayoutEffect(() => {
    if (!docked) return
    shown.set(id, { owner, title })
    notify()
  }, [docked, title])
  // A panel that takes over the id, like the next conversation's chat, may mount before this one goes.
  useLayoutEffect(
    () => () => {
      if (shown.get(id)?.owner !== owner) return
      shown.delete(id)
      notify()
    },
    [],
  )
  if (!docked) return <>{children}</>
  const el = box(id)
  el.className = `dock-box ${cls}`
  return createPortal(<>{children}</>, el)
}

// Keeps a panel out of view while `hide` holds, as the conversation list beside a preview. Arranging shows it.
export function useHidePanel(id: PanelId, hide: boolean) {
  useLayoutEffect(() => {
    if (!hide) return
    hidden.add(id)
    notify()
    return () => {
      hidden.delete(id)
      notify()
    }
  }, [hide])
}

export const resetLayout = () => setPrefs({ layout: null, windows: null })

// ---- the tree ----

const leaves = (n: Node): PanelId[] => (typeof n === 'string' ? [n] : n.children.flatMap(leaves))
const valid = (n: Split | null) => !!n && leaves(n).sort().join() === [...IDS].sort().join()
const rank = (n: Node, visible: Set<PanelId>) => Math.min(...leaves(n).map((id) => (visible.has(id) ? GROWS.indexOf(id) : 99)))
const at = (tree: Split, path: number[]) => path.reduce<Split>((n, i) => n.children[i] as Split, tree)

interface Gutter { path: number[]; a: number; b: number; grows: 'a' | 'b' | null; row: boolean; rect: Rect; lens: [number, number] }

function place(node: Node, r: Rect, visible: Set<PanelId>, rects: Partial<Record<PanelId, Rect>>, gutters: Gutter[], path: number[] = []) {
  if (typeof node === 'string') return void (rects[node] = r)
  const kids = node.children.map((c, i) => ({ c, i })).filter(({ c }) => leaves(c).some((id) => visible.has(id)))
  if (!kids.length) return
  const row = node.dir === 'row'
  const total = (row ? r.w : r.h) - (kids.length - 1) * GAP
  const flex = kids.reduce((best, k) => (rank(k.c, visible) < rank(best.c, visible) ? k : best))
  const fixed = kids.filter((k) => k !== flex).reduce((s, k) => s + node.sizes[k.i], 0)
  // When the window is too small for the fixed panels, they shrink alike and the growing one keeps a minimum.
  const scale = fixed > total - MIN ? Math.max(0, total - MIN) / fixed : 1
  const lens = kids.map((k) => (k === flex ? total - fixed * scale : node.sizes[k.i] * scale))
  let pos = row ? r.x : r.y
  kids.forEach((k, j) => {
    const len = lens[j]
    place(k.c, row ? { x: pos, y: r.y, w: len, h: r.h } : { x: r.x, y: pos, w: r.w, h: len }, visible, rects, gutters, [...path, k.i])
    pos += len
    if (j === kids.length - 1) return
    const next = kids[j + 1]
    gutters.push({ path, a: k.i, b: next.i, grows: k === flex ? 'a' : next === flex ? 'b' : null, row, rect: row ? { x: pos, y: r.y, w: GAP, h: r.h } : { x: r.x, y: pos, w: r.w, h: GAP }, lens: [len, lens[j + 1]] })
    pos += GAP
  })
}

// Removing a panel and merging what is left: a split with one child becomes that child, a split inside one of the same
// direction joins it.
function normalize(n: Node): Node {
  if (typeof n === 'string') return n
  const children: Node[] = []
  const sizes: number[] = []
  n.children.map(normalize).forEach((c, i) => {
    if (typeof c !== 'string' && c.dir === n.dir) {
      children.push(...c.children)
      sizes.push(...c.sizes)
    } else {
      children.push(c)
      sizes.push(n.sizes[i])
    }
  })
  return children.length === 1 ? children[0] : { dir: n.dir, children, sizes }
}
function remove(n: Node, id: PanelId): Node {
  if (typeof n === 'string') return n
  const i = n.children.findIndex((c) => c === id)
  if (i >= 0) return { ...n, children: n.children.filter((_, j) => j !== i), sizes: n.sizes.filter((_, j) => j !== i) }
  return { ...n, children: n.children.map((c) => remove(c, id)) }
}
type Side = 'left' | 'right' | 'top' | 'bottom' | 'center'
function dock(tree: Split, id: PanelId, target: PanelId, side: Side, rect: Rect): Split {
  if (side === 'center') {
    const swap = (n: Node): Node => (typeof n === 'string' ? (n === target ? id : n === id ? target : n) : { ...n, children: n.children.map(swap) })
    return swap(tree) as Split
  }
  const dir = side === 'left' || side === 'right' ? 'row' : 'col'
  const half = Math.round((dir === 'row' ? rect.w : rect.h) / 2)
  const pair = side === 'left' || side === 'top' ? [id, target] : [target, id]
  const put = (n: Node): Node => {
    if (typeof n === 'string') return n === target ? { dir, children: pair, sizes: [half, half] } : n
    return { ...n, children: n.children.map(put) }
  }
  const next = normalize(put(normalize(remove(tree, id))))
  return typeof next === 'string' ? { dir: 'row', children: [next], sizes: [0] } : next
}

// ---- pointer drags ----

function drag(e: PointerEvent, move: (dx: number, dy: number, ev: PointerEvent) => void, done: (ev: PointerEvent) => void) {
  e.preventDefault()
  e.stopPropagation()
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const onMove = (ev: PointerEvent) => move(ev.clientX - e.clientX, ev.clientY - e.clientY, ev)
  const onUp = (ev: PointerEvent) => {
    el.removeEventListener('pointermove', onMove)
    el.removeEventListener('pointerup', onUp)
    done(ev)
  }
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
}
const snap = (v: number) => Math.round(v / GRID) * GRID

// ---- the dock ----

// `children` render out of sight; what they put in a Panel shows in the dock.
export function Dock({ children }: { children: ComponentChildren }) {
  useStore()
  const prefs = usePrefs()
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }))
    observer.observe(ref.current!)
    return () => observer.disconnect()
  }, [])
  // While a border is dragged the tree lives here, and goes to the prefs when it is let go.
  const [draft, setDraft] = useState<Split | null>(null)
  const [drop, setDrop] = useState<{ id: PanelId; target: PanelId; side: Side } | null>(null)
  const [order, setOrder] = useState<PanelId[]>(IDS)
  const [moving, setMoving] = useState<Partial<Record<PanelId, Rect>> | null>(null)
  const free = prefs.freeWindows
  const editing = arranging && !free
  useEffect(() => {
    if (!editing) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setArranging(false)
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [editing])

  const tree = draft ?? (valid(prefs.layout) ? prefs.layout! : DEFAULT_LAYOUT)
  let visible = new Set(IDS.filter((id) => shown.has(id) && (editing || !hidden.has(id))))
  if (prefs.terminalMax && visible.has('terminal')) visible = new Set(['terminal'])
  const rects: Partial<Record<PanelId, Rect>> = {}
  const gutters: Gutter[] = []
  place(tree, { x: 0, y: 0, w: size.w, h: size.h }, visible, rects, gutters)
  if (prefs.terminalMax) rects.terminal = { x: 0, y: 0, w: size.w, h: size.h }

  const resize = (e: PointerEvent, g: Gutter) => {
    const t = structuredClone(tree)
    const split = at(t, g.path)
    const [la, lb] = g.lens
    drag(
      e,
      (dx, dy) => {
        const d = Math.max(120 - la, Math.min(lb - 120, g.row ? dx : dy))
        if (g.grows !== 'a') split.sizes[g.a] = Math.round(la + d)
        if (g.grows !== 'b') split.sizes[g.b] = Math.round(lb - d)
        setDraft({ ...t })
      },
      () => {
        setPrefs({ layout: t })
        setDraft(null)
      },
    )
  }

  // Arranging: a panel dropped on the edge of another docks beside it there, on its middle the two swap places.
  const arrange = (e: PointerEvent, id: PanelId) => {
    const dockRect = ref.current!.getBoundingClientRect()
    let hit: typeof drop = null
    drag(
      e,
      (_dx, _dy, ev) => {
        const x = ev.clientX - dockRect.left
        const y = ev.clientY - dockRect.top
        const target = [...visible].find((t) => t !== id && rects[t] && x >= rects[t]!.x && x < rects[t]!.x + rects[t]!.w && y >= rects[t]!.y && y < rects[t]!.y + rects[t]!.h)
        if (!target) hit = null
        else {
          const r = rects[target]!
          const fx = (x - r.x) / r.w
          const fy = (y - r.y) / r.h
          hit = { id, target, side: fx < 0.25 ? 'left' : fx > 0.75 ? 'right' : fy < 0.3 ? 'top' : fy > 0.7 ? 'bottom' : 'center' }
        }
        setDrop(hit)
      },
      () => {
        setDrop(null)
        if (hit) setPrefs({ layout: dock(tree, id, hit.target, hit.side, rects[hit.target]!) })
      },
    )
  }

  // Free windows start where the panels are docked; the first move keeps all of them where they are. They stay
  // inside the window, also when it gets smaller.
  const clamp = (r: Rect): Rect => {
    const w = Math.min(r.w, size.w)
    const h = Math.min(r.h, size.h)
    return { w, h, x: Math.max(0, Math.min(size.w - w, r.x)), y: Math.max(0, Math.min(size.h - h, r.y)) }
  }
  const windowOf = (id: PanelId) => moving?.[id] ?? prefs.windows?.[id] ?? rects[id]
  const raise = (id: PanelId) => setOrder([...order.filter((o) => o !== id), id])
  const moveWindow = (e: PointerEvent, id: PanelId, how: 'move' | 'size') => {
    raise(id)
    const all: Partial<Record<PanelId, Rect>> = { ...prefs.windows }
    for (const v of visible) all[v] ??= rects[v]
    const from = windowOf(id)!
    drag(
      e,
      (dx, dy) => {
        const r = how === 'move' ? { ...from, x: snap(from.x + dx), y: snap(from.y + dy) } : { ...from, w: Math.max(MIN, snap(from.w + dx)), h: Math.max(HEAD * 3, snap(from.h + dy)) }
        all[id] = clamp(r)
        setMoving({ ...all })
      },
      () => {
        setPrefs({ windows: all })
        setMoving(null)
      },
    )
  }

  const zone = drop && rects[drop.target]
  const zoneRect = zone && {
    left: { ...zone, w: zone.w / 2 },
    right: { ...zone, x: zone.x + zone.w / 2, w: zone.w / 2 },
    top: { ...zone, h: zone.h / 2 },
    bottom: { ...zone, y: zone.y + zone.h / 2, h: zone.h / 2 },
    center: zone,
  }[drop.side]
  const px = (r: Rect) => ({ left: r.x, top: r.y, width: r.w, height: r.h })
  const title = (id: PanelId) => shown.get(id)?.title ?? NAMES[id]

  return (
    <div class={`dock ${free ? 'free' : ''} ${editing ? 'arranging' : ''} ${draft ? 'resizing' : ''}`} ref={ref}>
      {IDS.map((id) => {
        const r = free && !prefs.terminalMax ? windowOf(id) : rects[id]
        const on = visible.has(id) && r
        return (
          <div key={id} class={`dock-leaf ${free ? 'window' : ''}`} data-panel={id} style={on ? { ...px(free ? clamp(r) : r), zIndex: free ? order.indexOf(id) + 1 : undefined } : { display: 'none' }} onPointerDown={free ? () => raise(id) : undefined}>
            {free && (
              <div class="window-head" onPointerDown={(e) => moveWindow(e, id, 'move')}>
                {title(id)}
              </div>
            )}
            <div
              class="dock-slot"
              ref={(el) => {
                if (el && box(id).parentElement !== el) el.appendChild(box(id))
              }}
            />
            {free && <div class="window-size" title="Resize" onPointerDown={(e) => moveWindow(e, id, 'size')} />}
            {editing && on && (
              <div class={`arrange-cover ${drop?.id === id ? 'dragging' : ''}`} onPointerDown={(e) => arrange(e, id)}>
                <span>
                  <GripVertical size={16} /> {title(id)}
                </span>
              </div>
            )}
          </div>
        )
      })}
      {!free && gutters.map((g) => <div key={`${g.path.join('.')}:${g.a}`} class={`dock-gutter ${g.row ? 'row' : 'col'}`} style={px(g.rect)} onPointerDown={(e) => resize(e, g)} />)}
      {zoneRect && <div class="drop-zone" style={px(zoneRect)} />}
      {editing && (
        <div class="arrange-bar">
          <span>Drag a panel onto the edge of another to dock it there, or onto its middle to swap them.</span>
          <button class="ghost" onClick={resetLayout}>
            Reset layout
          </button>
          <button class="primary" onClick={() => setArranging(false)}>
            Done
          </button>
        </div>
      )}
      <div class="dock-source">
        <Docked.Provider value={true}>{children}</Docked.Provider>
      </div>
    </div>
  )
}

export function ArrangeButton() {
  useStore()
  const { freeWindows } = usePrefs()
  if (freeWindows) return null
  return (
    <button class={`icon-btn ${arranging ? 'on' : ''}`} title="Arrange panels" onClick={() => setArranging(!arranging)}>
      <PanelsTopLeft size={16} />
    </button>
  )
}

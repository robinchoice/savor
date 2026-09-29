import * as store from './store.js'
import type { Project, Proc } from './store.js'
import { emit } from './events.js'
import * as agents from './agents.js'

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sweep() {
  for (const p of store.listProjects()) {
    const procs = store.listProcs(p)
    const dead = procs.filter((pr) => !alive(pr.pid))
    if (!dead.length) continue
    store.saveProcs(p, procs.filter((pr) => !dead.includes(pr)))
    emit({ type: 'processes', projectId: p.id })
    for (const pr of dead) agents.maybeClose(p, pr.threadId)
  }
}

export const watchProcesses = () => setInterval(sweep, 5000)

export function register(p: Project, proc: Proc) {
  store.saveProcs(p, [...store.listProcs(p).filter((pr) => pr.pid !== proc.pid), proc])
  emit({ type: 'processes', projectId: p.id })
}

export function unregister(p: Project, pid: number) {
  const procs = store.listProcs(p)
  const gone = procs.find((pr) => pr.pid === pid)
  store.saveProcs(p, procs.filter((pr) => pr.pid !== pid))
  emit({ type: 'processes', projectId: p.id })
  if (gone) agents.maybeClose(p, gone.threadId)
}

export function kill(p: Project, pid: number) {
  if (alive(pid)) process.kill(pid, 'SIGTERM')
  unregister(p, pid)
}

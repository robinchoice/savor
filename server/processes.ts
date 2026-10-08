import { execFile } from 'node:child_process'
import fs from 'node:fs'
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

const cgroupOf = (pid: number | 'self') => fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8')

function tree(root: number) {
  const parents = new Map<number, number>()
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8')
      parents.set(Number(d), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]))
    } catch {}
  }
  const pids = [root]
  for (let i = 0; i < pids.length; i++) for (const [pid, parent] of parents) if (parent === pids[i]) pids.push(pid)
  return pids
}

// As a systemd service, everything Savor starts sits in the service's cgroup, and the restart after an
// update ends all of it. A registered process moves with its children into a scope of its own, so dev
// servers outlive the restart.
function detach(pid: number) {
  if (process.platform !== 'linux' || !process.env.INVOCATION_ID) return
  const own = cgroupOf('self')
  const pids = tree(pid).filter((pr) => {
    try {
      return cgroupOf(pr) === own
    } catch {
      return false
    }
  })
  if (!pids.length) return
  const props = ['PIDs', 'au', String(pids.length), ...pids.map(String), 'CollectMode', 's', 'inactive-or-failed']
  execFile('busctl', ['--user', 'call', 'org.freedesktop.systemd1', '/org/freedesktop/systemd1', 'org.freedesktop.systemd1.Manager', 'StartTransientUnit', 'ssa(sv)a(sa(sv))', `savor-process-${pid}.scope`, 'fail', '2', ...props, '0'], () => {})
}

export function register(p: Project, proc: Proc) {
  detach(proc.pid)
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
  if (!store.listProcs(p).some((pr) => pr.pid === pid)) throw new store.NotFound(`process ${pid}`)
  if (alive(pid)) process.kill(pid, 'SIGTERM')
  unregister(p, pid)
}

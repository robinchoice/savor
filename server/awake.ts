import { spawn, type ChildProcess } from 'node:child_process'

// Keeps the computer from sleeping so paired devices can reach it.
let inhibitor: ChildProcess | null = null

export const isAwake = () => !!inhibitor

export function setAwake(on: boolean) {
  if (!on) {
    inhibitor?.kill()
    inhibitor = null
    return
  }
  if (inhibitor) return
  if (process.platform === 'win32') throw new Error('Keep awake is not supported on Windows yet.')
  const [cmd, ...args] =
    process.platform === 'darwin'
      ? ['caffeinate', '-dims']
      : ['systemd-inhibit', '--what=idle:sleep', '--who=Savor', '--why=Keep agents reachable', 'sleep', 'infinity']
  const child = spawn(cmd, args, { stdio: 'ignore' })
  child.on('exit', () => inhibitor === child && (inhibitor = null))
  child.on('error', () => inhibitor === child && (inhibitor = null))
  inhibitor = child
}

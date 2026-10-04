import { spawn, type ChildProcess } from 'node:child_process'

// Keeps the computer from sleeping so paired devices can reach it.
let inhibitor: ChildProcess | null = null

// Windows has no inhibitor command. PowerShell holds the execution state (ES_CONTINUOUS |
// ES_SYSTEM_REQUIRED) for as long as it runs.
const WINDOWS_INHIBITOR = `
$power = Add-Type -Name Power -Namespace Savor -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
[void]$power::SetThreadExecutionState([uint32]2147483649)
Wait-Process -Id ${process.pid}
`

export const isAwake = () => !!inhibitor

export function setAwake(on: boolean) {
  if (!on) {
    inhibitor?.kill()
    inhibitor = null
    return
  }
  if (inhibitor) return
  // Every inhibitor waits for the daemon's own process, so it ends with the daemon however that stops.
  const [cmd, ...args] =
    process.platform === 'darwin'
      ? ['caffeinate', '-dims', '-w', String(process.pid)]
      : process.platform === 'win32'
        ? ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_INHIBITOR, 'utf16le').toString('base64')]
        : ['systemd-inhibit', '--what=idle:sleep', '--who=Savor', '--why=Keep agents reachable', 'tail', `--pid=${process.pid}`, '-f', '/dev/null']
  const child = spawn(cmd, args, { stdio: 'ignore' })
  child.on('exit', () => inhibitor === child && (inhibitor = null))
  child.on('error', () => inhibitor === child && (inhibitor = null))
  inhibitor = child
}

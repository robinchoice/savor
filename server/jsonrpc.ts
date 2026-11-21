// Newline-delimited JSON-RPC 2.0 over a child process's stdio, as Codex's app-server and ACP agents speak it.
import type { ChildProcess } from 'node:child_process'
import readline from 'node:readline'

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message)
  }
}

// The agent did not answer in time: it hangs, so asking it something else instead would hang too.
export class RpcTimeout extends RpcError {}

// How long an agent may take to answer the requests that start it. One that hangs there would keep its turn working forever.
export const START_MS = Number(process.env.SAVOR_AGENT_START_MS ?? 120_000)

interface Handlers {
  notification(method: string, params: any): void
  request(method: string, params: any): Promise<unknown>
}

export class Rpc {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private stderr = ''
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

  constructor(private child: ChildProcess, private handlers: Handlers) {
    readline.createInterface({ input: child.stdout! }).on('line', (l) => {
      // A message Savor can't handle ends this agent's session, never the daemon. SIGKILL, so the
      // session doesn't take the exit for a stop.
      try {
        this.onLine(l)
      } catch (e) {
        console.error('Agent session failed on a message:', e)
        this.stderr += `\nSavor could not handle a message from the agent: ${(e as Error).message}`
        child.kill('SIGKILL')
      }
    })
    child.stderr?.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)))
    // An agent that exits right away closes its stdin; the exit then rejects what is pending.
    child.stdin?.on('error', (e) => (this.stderr += e.message))
    // A process that is gone answers nothing anymore, whether it exited or never started.
    const fail = (how: string) => {
      for (const p of this.pending.values()) p.reject(new RpcError(`agent ${how}: ${this.stderr.trim()}`))
      this.pending.clear()
    }
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        fail(`exited with ${signal ?? code}`)
        resolve({ code, signal })
      })
      child.on('error', (e) => {
        this.stderr += e.message
        fail('could not run')
        resolve({ code: null, signal: null })
      })
    })
  }

  get stderrTail() {
    return this.stderr.trim()
  }

  // Close stdin so the agent exits on its own, and make sure it does.
  end() {
    this.child.stdin?.end()
    setTimeout(() => this.child.kill('SIGTERM'), 1000).unref()
  }

  kill() {
    this.child.kill('SIGTERM')
  }

  // With `timeout` (ms) the request fails when the agent has not answered by then.
  request(method: string, params: unknown, timeout?: number): Promise<any> {
    const id = this.nextId++
    const answer = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
    if (!timeout) return answer
    const timer = setTimeout(() => {
      this.pending.get(id)?.reject(new RpcTimeout(`The agent did not answer ${method} within ${Math.round(timeout / 1000)} seconds. Send your message again to start it anew.`))
      this.pending.delete(id)
    }, timeout)
    return answer.finally(() => clearTimeout(timer))
  }

  notify(method: string, params: unknown) {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(msg: unknown) {
    if (!this.child.stdin?.writable) return
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  private onLine(line: string) {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) return this.handlers.notification(msg.method, msg.params)
      this.handlers.request(msg.method, msg.params).then(
        (result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }),
        (e: Error) => this.write({ jsonrpc: '2.0', id: msg.id, error: { code: e instanceof RpcError ? e.code ?? -32000 : -32000, message: e.message } }),
      )
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    if (msg.error) p.reject(new RpcError(msg.error.message ?? JSON.stringify(msg.error), msg.error.code, msg.error.data))
    else p.resolve(msg.result)
  }
}

// Newline-delimited JSON-RPC 2.0 over a child process's stdio, as Codex's app-server and ACP agents speak it.
import type { ChildProcess } from 'node:child_process'
import readline from 'node:readline'

export class RpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message)
  }
}

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
    readline.createInterface({ input: child.stdout! }).on('line', (l) => this.onLine(l))
    child.stderr?.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)))
    this.exited = new Promise((resolve) => {
      child.on('exit', (code, signal) => {
        for (const p of this.pending.values()) p.reject(new RpcError(`agent exited with ${signal ?? code}: ${this.stderr.trim()}`))
        this.pending.clear()
        resolve({ code, signal })
      })
      child.on('error', (e) => {
        this.stderr += e.message
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

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
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
    if (msg.error) p.reject(new RpcError(msg.error.message ?? JSON.stringify(msg.error), msg.error.code))
    else p.resolve(msg.result)
  }
}

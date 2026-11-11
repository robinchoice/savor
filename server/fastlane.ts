// The fast lane: a quick answer to a question that needs no project, from a fast model without any tools, streamed as
// it is written and beside whatever the conversation's agent does. A question that needs files, tools or actions goes
// on to the agent, with what the lane answered so far (agents.handOff): a reactive lane in front of a deliberative agent.
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import * as store from './store.js'
import type { AgentConfig, Message, Project } from './store.js'
import { BIN, command } from './config.js'
import { emit } from './events.js'
import * as agents from './agents.js'

const MODEL = 'sonnet'
const EFFORT = 'low'
const HANDOFF = 'HANDOFF'
const TIMEOUT_MS = 120_000

const PROMPT = `You are Savor's fast lane: you answer the user's quick questions right away. Answer briefly, in the language of the question, from your own knowledge and the conversation below. Use Markdown sparingly.
You have no tools. You can't see the project or its files, run commands, look anything up online or change anything. When an answer needs any of that, the user asks for something to be done, or you would have to guess about the project, reply with exactly ${HANDOFF} and nothing else: Savor then passes the question on to the conversation's coding agent, which can.`

// The answer that runs per conversation; a second question waits for it, so it sees that answer. Stop ends the one
// that runs and drops those that wait (a new generation).
const running = new Map<string, { kill: () => void }>()
const queues = new Map<string, Promise<void>>()
const generations = new Map<string, number>()

export const isAnswering = (tid: string) => running.has(tid)

export function stop(tid: string) {
  generations.set(tid, (generations.get(tid) ?? 0) + 1)
  running.get(tid)?.kill()
}

export function send(p: Project, tid: string, input: agents.Input) {
  store.updateThread(p, tid, { completed: false, inputAt: store.now() })
  const msg = agents.post(p, tid, { kind: 'user', text: input.text, images: input.images, files: input.files, origin: input.origin, device: input.device, lane: 'fast' })
  // Pictures, files and commands are for the agent.
  if (input.images?.length || input.files?.length || input.text.trimStart().startsWith('/')) {
    agents.handOff(p, tid, msg.id)
    return msg
  }
  const generation = generations.get(tid) ?? 0
  const next = (queues.get(tid) ?? Promise.resolve()).then(() => ((generations.get(tid) ?? 0) === generation ? answer(p, tid, msg) : undefined))
  queues.set(tid, next)
  next.finally(() => queues.get(tid) === next && queues.delete(tid))
  return msg
}

// What was said in the conversation, as far as the user saw it, without the question and the ones that wait behind it.
// An answer to an earlier question can stand behind it.
function transcript(p: Project, tid: string, question: string) {
  const msgs = store.readMessages(p, tid)
  const at = msgs.findIndex((m) => m.id === question)
  return msgs
    .filter((m, i) => m.text && ['user', 'ack', 'update', 'conclusion'].includes(m.kind) && (i < at || m.kind !== 'user'))
    .slice(-20)
    .map((m) => `[${m.kind === 'user' ? 'user' : m.lane ? 'fast lane' : 'agent'}] ${m.text!.slice(0, 1500)}`)
    .join('\n\n')
}

function answer(p: Project, tid: string, msg: Message) {
  return new Promise<void>((resolve) => {
    const thread = store.getThread(p, tid)
    const history = transcript(p, tid, msg.id)
    const prompt = `Today is ${new Date().toDateString()}. Project: ${p.name}.\n\n${history ? `The conversation so far:\n${history}\n\n` : ''}Question:\n${msg.text}`
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence']
    // No tools, MCP servers, hooks, CLAUDE.md or skills: nothing to act with, and a small context that answers fast.
    args.push('--safe-mode', '--strict-mcp-config', '--tools', '', '--system-prompt', PROMPT, '--model', MODEL, '--effort', EFFORT)
    const child = spawn(...command(BIN.claude, args), { cwd: store.cwdOf(p, thread), stdio: ['pipe', 'pipe', 'pipe'] })
    let text = ''
    let stderr = ''
    let stopped = false
    let done = false
    const modelInfo = (model: string): AgentConfig => ({ ...thread.agent, provider: 'claude', model, reasoning: EFFORT, fast: false, ultracode: false })
    let info = modelInfo(MODEL)
    const finish = (r: { text?: string; error?: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      running.delete(tid)
      child.kill('SIGTERM')
      try {
        if (stopped) agents.setDraft(p, tid, null, 'fast')
        // A lane that failed hands over too: the agent still answers, only slower.
        else if (r.error || !r.text?.trim() || r.text.trim().startsWith(HANDOFF)) {
          if (r.error) console.error(`The fast lane of ${tid} failed:`, r.error)
          agents.setDraft(p, tid, null, 'fast')
          agents.handOff(p, tid, msg.id)
        } else agents.post(p, tid, { kind: 'conclusion', text: r.text.trim(), lane: 'fast', modelInfo: info })
      } catch (e) {
        // The conversation was deleted meanwhile.
        if (!(e instanceof store.NotFound)) throw e
      }
      emit({ type: 'status', projectId: p.id, threadId: tid })
      resolve()
    }
    const timer = setTimeout(() => finish({ error: 'The fast lane took too long.' }), TIMEOUT_MS)
    running.set(tid, { kill: () => ((stopped = true), finish({})) })
    emit({ type: 'status', projectId: p.id, threadId: tid })
    readline.createInterface({ input: child.stdout! }).on('line', (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        return
      }
      if (ev.type === 'assistant' && ev.message?.model) info = modelInfo(ev.message.model)
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        text += ev.event.delta.text ?? ''
        const shown = text.trimStart()
        // Held back while it could still become the handoff.
        if (!HANDOFF.startsWith(shown) && !shown.startsWith(HANDOFF)) agents.setDraft(p, tid, { kind: 'conclusion', text: shown, lane: 'fast', modelInfo: info })
      }
      if (ev.type === 'result') finish(ev.is_error ? { error: ev.result || ev.subtype } : { text: ev.result || text })
    })
    child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)))
    child.on('error', (e) => finish({ error: e.message }))
    child.on('exit', (code) => finish({ error: `claude exited with ${code}: ${stderr.trim()}` }))
    child.stdin!.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n')
  })
}

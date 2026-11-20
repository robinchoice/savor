// The JSON-RPC connection to an agent process: a request gets an answer or an error, never neither.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const { Rpc } = await import('../server/jsonrpc.ts')
const handlers = { notification() {}, request: async () => ({}) }

test('regression: a request to an agent that could not be run fails instead of waiting forever', async () => {
  const rpc = new Rpc(spawn('/no/such/agent', [], { stdio: ['pipe', 'pipe', 'pipe'] }), handlers)
  await assert.rejects(rpc.request('initialize', {}), /agent could not run: .*ENOENT/)
  assert.deepEqual(await rpc.exited, { code: null, signal: null })
})

test('a request with a time limit fails when the agent does not answer by then', async () => {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const rpc = new Rpc(child, handlers)
  await assert.rejects(rpc.request('initialize', {}, 1000), /did not answer initialize within 1 seconds/)
  rpc.kill()
  await rpc.exited
})

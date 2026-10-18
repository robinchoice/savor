// The agent process server/acp.ts starts for each ACP agent.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-acp-'))
process.env.SAVOR_HOME = HOME
const { acpCommand } = await import('../server/acp.ts')
after(() => fs.rmSync(HOME, { recursive: true, force: true }))

test("Grok Build's Always approve mode is a flag of its agent process", () => {
  assert.deepEqual(acpCommand('grok', 'p', 't', 'default').args, ['--no-auto-update', 'agent', '--no-leader', 'stdio'])
  assert.deepEqual(acpCommand('grok', 'p', 't', 'always-approve').args, ['--no-auto-update', 'agent', '--always-approve', '--no-leader', 'stdio'])
  assert.deepEqual(acpCommand('opencode', 'p', 't', 'always-approve').args, ['acp'])
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test("throwaway repos commit unsigned with the tests' own name, whatever the user's git config says", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'savor-git-env-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim()
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', 'init')
  assert.equal(git('log', '-1', '--format=%an <%ae> %G?'), 'Test <t@test> N')
  fs.rmSync(dir, { recursive: true, force: true })
})

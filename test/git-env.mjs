// Loaded before every test file (see the test script in package.json): the throwaway repos the tests and
// the daemons they start create get a git config of their own instead of the user's, so a global
// commit.gpgsign or hook doesn't make them wait for a key agent. Written under another name and renamed,
// so test files starting in parallel never read it half-written.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const file = path.join(os.tmpdir(), 'savor-test.gitconfig')
fs.writeFileSync(`${file}.${process.pid}`, '[user]\n\tname = Test\n\temail = t@test\n')
fs.renameSync(`${file}.${process.pid}`, file)
process.env.GIT_CONFIG_GLOBAL = file
process.env.GIT_CONFIG_NOSYSTEM = '1'

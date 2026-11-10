#!/usr/bin/env node
// Stand-in for the GitHub CLI used by the end-to-end tests, reading what the test wrote to $FAKE_AGENT_LOG.gh.json:
// - `gh run list --commit <sha> --json …` prints the runs for that commit, or none. A commit listed as
//   "logged-out" fails the way gh does without a login. The folder it ran in goes to $FAKE_AGENT_LOG.gh.cwd.
// - `gh run list` without a commit prints the runs under "live", `gh run view <id> --json jobs` the jobs under "jobs".
// With $FAKE_GH_LOGIN set, it is signed in once that file exists:
// - `gh auth login` shows a one-time code and signs in a moment later, `gh auth setup-git` does nothing.
// - `gh api user` prints the account, `gh repo list` two repositories and `gh repo clone <repo> <dir>` makes
//   <dir> a git repository with a README.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const login = process.env.FAKE_GH_LOGIN
if (login) {
  const signedIn = fs.existsSync(login)
  const cmd = args.slice(0, 2).join(' ')
  if (cmd === 'auth login') {
    console.error('! One-time code (FA4E-C0DE) copied to clipboard\nOpen this URL to continue in your web browser: https://github.com/login/device')
    setTimeout(() => (fs.writeFileSync(login, 'octo'), console.error('✓ Logged in as octo')), 1500)
  } else if (cmd === 'auth setup-git') process.exit(0)
  else if (!signedIn) {
    console.error('To get started with GitHub CLI, please run:  gh auth login')
    process.exit(4)
  } else if (cmd === 'api user') console.log('octo')
  else if (cmd === 'repo list')
    console.log(JSON.stringify([
      { nameWithOwner: 'octo/old-site', description: null, isPrivate: false, pushedAt: '2025-01-01T00:00:00Z' },
      { nameWithOwner: 'octo/shop', description: 'The online shop', isPrivate: true, pushedAt: '2026-11-01T00:00:00Z' },
    ]))
  else if (cmd === 'repo clone') {
    const dir = args[3]
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${args[2]}\n`)
    execFileSync('git', ['init', '-q'], { cwd: dir })
  }
  if (cmd !== 'auth login') process.exit(0)
} else {
  const file = process.env.FAKE_AGENT_LOG + '.gh.json'
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  if (args[1] === 'view') {
    console.log(JSON.stringify({ jobs: data.jobs?.[args[2]] ?? [] }))
    process.exit(0)
  }
  if (!args.includes('--commit')) {
    console.log(JSON.stringify(data.live ?? []))
    process.exit(0)
  }
  fs.appendFileSync(process.env.FAKE_AGENT_LOG + '.gh.cwd', process.cwd() + '\n')
  const runs = data[args[args.indexOf('--commit') + 1]] ?? []
  if (runs === 'logged-out') {
    console.error('To get started with GitHub CLI, please run:  gh auth login')
    process.exit(4)
  }
  console.log(JSON.stringify(runs))
}

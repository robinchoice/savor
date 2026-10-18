#!/usr/bin/env node
// Stand-in for the GitHub CLI used by the end-to-end tests, reading what the test wrote to $FAKE_AGENT_LOG.gh.json:
// - `gh run list --commit <sha> --json …` prints the runs for that commit, or none. A commit listed as
//   "logged-out" fails the way gh does without a login. The folder it ran in goes to $FAKE_AGENT_LOG.gh.cwd.
// - `gh run list` without a commit prints the runs under "live", `gh run view <id> --json jobs` the jobs under "jobs".
import fs from 'node:fs'

const args = process.argv.slice(2)
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

#!/usr/bin/env node
// Stand-in for the GitHub CLI used by the end-to-end tests: `gh run list --commit <sha> --json …` prints
// the runs the test wrote for that commit to $FAKE_AGENT_LOG.gh.json, or none. A commit listed as
// "logged-out" fails the way gh does without a login.
import fs from 'node:fs'

const args = process.argv.slice(2)
const sha = args[args.indexOf('--commit') + 1]
const file = process.env.FAKE_AGENT_LOG + '.gh.json'
const runs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))[sha] ?? [] : []
if (runs === 'logged-out') {
  console.error('To get started with GitHub CLI, please run:  gh auth login')
  process.exit(4)
}
console.log(JSON.stringify(runs))

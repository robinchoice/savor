// GitHub Actions runs of a commit, read with the GitHub CLI, for agents that wait for CI.
import { execFile } from 'node:child_process'
import { BIN, command } from './config.js'

export interface Run { databaseId: number; name: string; workflowName: string; status: string; conclusion: string; url: string }

export function runsOf(cwd: string, sha: string) {
  return new Promise<Run[]>((resolve, reject) => {
    const args = ['run', 'list', '--commit', sha, '--json', 'databaseId,name,workflowName,status,conclusion,url', '--limit', '50']
    execFile(...command(BIN.gh, args), { cwd, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gh run list failed: ${(stderr || err.message).trim()}`))
      resolve(JSON.parse(stdout))
    })
  })
}

export const finished = (runs: Run[]) => runs.length > 0 && runs.every((r) => r.status === 'completed')
export const failed = (runs: Run[]) => runs.filter((r) => !['success', 'skipped', 'neutral'].includes(r.conclusion))

export function report(sha: string, runs: Run[]) {
  const bad = failed(runs)
  return [
    `CI for ${sha.slice(0, 7)}: ${bad.length ? `${bad.length} of ${runs.length} runs failed` : `all ${runs.length} runs passed`}.`,
    ...runs.map((r) => `- ${r.workflowName}${r.name && r.name !== r.workflowName ? ` · ${r.name}` : ''}: ${r.conclusion} ${r.url}`),
    ...(bad.length ? [`The log of a failed run: gh run view ${bad[0].databaseId} --log-failed`] : []),
  ].join('\n')
}

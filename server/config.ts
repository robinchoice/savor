import { state } from './store.js'

export const PORT = Number(process.env.SAVOR_PORT ?? 4317)
export const HOST = process.env.SAVOR_HOST ?? '127.0.0.1'
export const PUBLIC_URL = process.env.SAVOR_PUBLIC_URL ?? `http://localhost:${PORT}`

export const BIN = {
  claude: process.env.SAVOR_CLAUDE_BIN ?? 'claude',
  codex: process.env.SAVOR_CODEX_BIN ?? 'codex',
  opencode: process.env.SAVOR_OPENCODE_BIN ?? 'opencode',
  grok: process.env.SAVOR_GROK_BIN ?? 'grok',
  antigravity: process.env.SAVOR_ANTIGRAVITY_BIN ?? 'antigravity',
}

export const mcpUrl = (projectId: string, threadId: string) =>
  `http://127.0.0.1:${PORT}/mcp/${state().mcpToken}?project=${projectId}&thread=${threadId}`

export const appUrl = (route: string) => `${PUBLIC_URL}/#${route}`

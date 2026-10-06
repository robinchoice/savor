import fs from 'node:fs'
import path from 'node:path'

export const PORT = Number(process.env.SAVOR_PORT ?? 4317)
export const HOST = process.env.SAVOR_HOST ?? '127.0.0.1'
export const PUBLIC_URL = process.env.SAVOR_PUBLIC_URL ?? `http://localhost:${PORT}`
export const VERSION = '0.6.8'

export const BIN = {
  claude: process.env.SAVOR_CLAUDE_BIN ?? 'claude',
  codex: process.env.SAVOR_CODEX_BIN ?? 'codex',
  opencode: process.env.SAVOR_OPENCODE_BIN ?? 'opencode',
  grok: process.env.SAVOR_GROK_BIN ?? 'grok',
  antigravity: process.env.SAVOR_ANTIGRAVITY_BIN ?? 'agy',
  whisper: process.env.SAVOR_WHISPER_BIN ?? 'whisper-cli',
}

// On Windows, npm installs CLIs as .cmd shims. Node can only start those through cmd.exe, which
// cannot pass multi-line arguments, so this starts what the shim starts: node with the CLI's script.
export function command(bin: string, args: string[]): [string, string[]] {
  if (process.platform !== 'win32') return [bin, args]
  const name = path.basename(bin)
  for (const dir of name === bin ? (process.env.PATH ?? '').split(path.delimiter).filter(Boolean) : [path.dirname(bin)]) {
    const file = path.join(dir, name)
    if (fs.existsSync(file + '.exe') || fs.existsSync(file + '.com')) break
    const shim = /\.cmd$/i.test(file) ? file : file + '.cmd'
    const target = fs.existsSync(shim) && fs.readFileSync(shim, 'utf8').match(/"%~?dp0%?\\([^"]+)"\s+%\*/)?.[1]
    if (!target) continue
    const script = path.join(dir, target)
    if (/\.exe$/i.test(script)) return [script, args]
    const node = path.join(dir, 'node.exe')
    return [fs.existsSync(node) ? node : 'node', [script, ...args]]
  }
  return [bin, args]
}

// Voice input: a whisper.cpp model name (downloaded on first use) or the path of a ggml model file.
export const WHISPER_MODEL = process.env.SAVOR_WHISPER_MODEL ?? 'small-q5_1'

// Agents send the MCP token as a bearer token. It never goes into a URL or onto a command line,
// which every user on the machine can read.
export const mcpUrl = (projectId: string, threadId: string) => `http://127.0.0.1:${PORT}/mcp?project=${projectId}&thread=${threadId}`

export const appUrl = (route: string) => `${PUBLIC_URL}/#${route}`

# Savor

A local-first workspace for CLI coding agents. Savor runs Claude Code, Codex or OpenCode in your project folders. You use it through a web UI (installable as a PWA) on your desktop or phone.

- **Projects & conversations**: every conversation is its own agent session and can be resumed later.
- **Message protocol over MCP**: agents send acknowledgements, results, blocking questions, follow-up suggestions and commit hashes. Their raw output stays in a collapsible trace.
- **Approvals**: Claude Code permission prompts appear in the conversation as Allow/Deny.
- **Documents**: markdown files that both you and the agents can edit.
- **Workflows**: saved prompts, optionally on a cron schedule. Each run starts a new conversation.
- **Background processes**: agents register the dev servers they start. Savor watches the PIDs, shows logs and can stop them.
- **Product preview**: agents open the app they built in a headless Chromium and drive it (inspect, click, fill, screenshot). You see it next to the chat, either live or as the agent sees it.
- **Remote access**: the same UI works from your phone.

Everything lives in plain files: `~/.savor/state.json` holds the project list and access tokens, and each project gets a `.savor/` directory.

## Quick start

Requirements: Node ≥ 18, at least one agent CLI (`claude`, `codex` or `opencode`) that is logged in, and Chromium or Chrome for the preview.

```sh
git clone <repo> savor && cd savor
npm install          # also builds the web UI
npm start
```

Open the printed `http://localhost:4317/?token=…` link once. It sets a cookie, and after that `http://localhost:4317` is enough.

## Phone / remote access

Savor binds to `127.0.0.1` by default. For access from other devices, use a private network such as [Tailscale](https://tailscale.com) or WireGuard instead of exposing the port publicly:

```sh
SAVOR_HOST=0.0.0.0 SAVOR_PUBLIC_URL=http://my-desktop.tailnet.ts.net:4317 npm start
```

Open the token link on the phone and use "Add to Home Screen". Your desktop has to stay awake.

## Configuration

| Variable | Default | |
|---|---|---|
| `SAVOR_PORT` | `4317` | HTTP port |
| `SAVOR_HOST` | `127.0.0.1` | Bind address |
| `SAVOR_PUBLIC_URL` | `http://localhost:$SAVOR_PORT` | Base for links agents post |
| `SAVOR_HOME` | `~/.savor` | Global state |
| `SAVOR_CHROMIUM` | auto-detect | Browser for the product preview |
| `SAVOR_CLAUDE_BIN` / `SAVOR_CODEX_BIN` / `SAVOR_OPENCODE_BIN` | `claude` / `codex` / `opencode` | Agent binaries |

You set the agent, model and permission mode per project under **Settings**.

## How it works

```
server/
  index.ts      HTTP API, SSE events, static UI, MCP endpoint
  agents.ts     agent adapters + the protocol prompt
  mcp.ts        MCP tools the agents call (messages, docs, workflows, processes, browser, approvals)
  store.ts      file storage
  scheduler.ts  cron workflows (croner)
  processes.ts  PID watcher
  browser.ts    headless preview (playwright-core)
web/            Preact PWA
```

- **Claude Code** runs as one long-lived `claude -p --input-format stream-json` process per conversation. Savor attaches its own MCP server and routes permission prompts through `--permission-prompt-tool`. The process stays alive while the conversation owns background processes and closes 5 minutes after the last activity.
- **Codex** (`codex exec --json`) and **OpenCode** (`opencode run --format json`) run once per turn and resume their session afterwards. These adapters are experimental.

Project layout:

```
<project>/.savor/
  project.json
  threads/<id>/thread.json, messages.jsonl
  documents/<id>.md
  workflows/<id>.json
  processes.json
```

## Status

Early MVP. Known gaps:
- The live preview is an iframe of the app URL. From a phone, `localhost` URLs only work in the "Agent view" tab (screenshots).
- The Codex and OpenCode adapters have not been tested against the real CLIs yet.
- There is no multi-user support: one token grants full access.

## License

AGPL-3.0-or-later

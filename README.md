# Savor

A local-first workspace for CLI coding agents. Savor runs Claude Code, Codex, OpenCode, Grok Build or Antigravity in your project folders. You use it from a desktop window, a browser tab or your phone.

- **Projects as tabs**, each with its own color. Badges show which agents are working and which conversations need you.
- **Conversations**: every task gets its own agent session. You get search, filters (All / Needs you / Working / Unread), colored labels, "Mark as completed" and a "Show completed" toggle.
- **Message protocol over MCP**: agents send acknowledgements, results, blocking questions, "potential next actions" and commit hashes. Their raw output goes to an activity log (thinking, commands, edits, tool calls, with durations).
- **Questions**: questions become decision records with options and a free-text answer. You answer them all in one reply.
- **Agent picker per conversation**: agent, model, reasoning level, fast mode and permissions. You can switch agents mid-conversation, and the new agent gets the visible history handed over.
- **Image attachments** by picker, paste or drag-and-drop. **@-mentions** for files and workflows. A **git branch switcher**.
- **Approvals**: Claude Code permission prompts appear in the conversation as Allow/Deny.
- **Files**: a project file browser and editor, plus markdown documents that both you and the agents write.
- **Workflows**: saved prompts on a cron schedule, which can be chained. Each run starts a new conversation.
- **Project settings**: `ROLE.md` instructions for every agent, verbosity, pause (skips scheduled runs), color and default agent.
- **Background processes**: agents register the dev servers they start. Savor watches the PIDs, shows logs and can stop them.
- **Live preview**: the app the agent built runs in a headless Chromium next to the chat. You see exactly the page the agent controls, and your clicks, typing and scrolling are forwarded to it. The picker lets you point at an element ("make this bigger"), and its selector and styles go along with your next message.
- **Devices**: pair a phone or another computer with a QR code. Each device has its own revocable key. Requests from devices are marked *remote*, and agents treat them with extra care.
- **Keep awake** toggle, dark and light theme.

Everything lives in plain files: `~/.savor/state.json` holds projects, tokens and devices, and each project gets a `.savor/` directory.

## Quick start

Requirements: Node ≥ 18, at least one logged-in agent CLI, and Chromium or Chrome for the preview.

```sh
git clone <repo> savor && cd savor
npm install          # also builds the web UI
npm start
```

Open the printed `http://localhost:4317/?token=…` link once. It sets a cookie, and after that `http://localhost:4317` is enough.

Desktop window (Electron, needs Node ≥ 22.12 to install):

```sh
cd desktop && npm install && npm start
```

The window starts its own daemon unless one is already running on `SAVOR_PORT`, and stops that daemon again when you close it. On Ubuntu 24.04 and later, Electron aborts with a `chrome-sandbox` error. Either run `sudo chown root:root node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 node_modules/electron/dist/chrome-sandbox`, or start it with `npm start -- --no-sandbox`.

## Phone / remote access

Savor binds to `127.0.0.1` by default. Use a private network such as [Tailscale](https://tailscale.com) or WireGuard instead of exposing the port publicly:

```sh
SAVOR_HOST=0.0.0.0 SAVOR_PUBLIC_URL=http://my-desktop.tailnet.ts.net:4317 npm start
```

Then go to **Devices & remote access** (avatar menu), click **Pair a device** and scan the QR code. Use "Add to Home Screen" on the phone. Your desktop has to stay awake, which the coffee-cup toggle takes care of.

## Configuration

| Variable | Default | |
|---|---|---|
| `SAVOR_PORT` | `4317` | HTTP port |
| `SAVOR_HOST` | `127.0.0.1` | Bind address |
| `SAVOR_PUBLIC_URL` | `http://localhost:$SAVOR_PORT` | Base for links agents post and pairing links |
| `SAVOR_HOME` | `~/.savor` | Global state |
| `SAVOR_CHROMIUM` | auto-detect | Browser for the preview |
| `SAVOR_CLAUDE_BIN`, `SAVOR_CODEX_BIN`, `SAVOR_OPENCODE_BIN`, `SAVOR_GROK_BIN`, `SAVOR_ANTIGRAVITY_BIN` | CLI name | Agent binaries |

Grok Build and Antigravity run a configurable command, because their headless interfaces aren't stable yet. Set it in `~/.savor/state.json` with `"providers": { "grok": { "command": ["grok", "-p", "{prompt}"] } }`. Their stdout becomes the result, and `SAVOR_MCP_URL` points them at Savor's MCP server.

## How it works

```
server/
  index.ts      HTTP API, SSE events, static UI, MCP endpoint
  agents.ts     agent adapters, protocol prompt, activity log
  mcp.ts        MCP tools the agents call
  store.ts      file storage
  devices.ts    owner token, device pairing, request origin
  scheduler.ts  cron workflows and chains (croner)
  processes.ts  PID watcher
  browser.ts    shared headless preview with screencast (playwright-core)
  files.ts      project file access
  awake.ts      keep-awake inhibitor
web/            Preact PWA
desktop/        Electron shell
```

- **Claude Code** runs as one long-lived `claude -p --input-format stream-json` process per conversation. Savor attaches its own MCP server and routes permission prompts through `--permission-prompt-tool`. The process stays alive while the conversation owns background processes and closes 5 minutes after the last activity. A change of model, effort, fast mode or permissions restarts it with `--resume`.
- **Codex** (`codex exec --json`) and **OpenCode** (`opencode run --format json`) run once per turn and resume their own session.

Project layout:

```
<project>/.savor/
  project.json, ROLE.md, processes.json
  threads/<id>/thread.json, messages.jsonl, activity.jsonl, attachments/
  decisions/<id>.json
  documents/<id>.md
  workflows/<id>.json
```

## Status

Early. Known gaps:
- Remote traffic is only encrypted in transit if you use Tailscale, WireGuard or HTTPS. There is no relay with end-to-end encryption.
- The OpenCode, Grok Build and Antigravity adapters haven't been tested against the real CLIs.
- The preview shows one headless page per conversation; logins inside the preview don't persist across daemon restarts.

## License

AGPL-3.0-or-later

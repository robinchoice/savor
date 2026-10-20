# Savor

## Purpose & links

- Local workspace for coding agents: Node server, web UI, Electron desktop app (`desktop/`), relay for paired remote devices (`relay/`). Setup, architecture and the development commands are in README.md.
- Landing page: https://savor.pleasance.org from `site/`, Coolify on VPS 1, project `pleasance-savor`.
- Relay: https://savor.diespaetzles.lol, Coolify on VPS 3, project `privat-savor`, application `savor-relay`.
- The bug button sends reports through the daemon's `POST /api/feedback` to `POST https://api.pleasance.org/savor/feedback` (repo `pleasance`, `api/`), which files them as issues in the private repo `robinchoice/savor-feedback`. Tests replace it with `SAVOR_FEEDBACK_URL`.
- Robin's own instance runs as the systemd user service `savor.service` on `127.0.0.1:4317`, from the AppImage of the last release.

## Checks

`npm run build && npm run typecheck && npm test`

`node scripts/upstream-check.mjs` runs Savor against the newest Claude Code, Codex, OpenCode, Grok Build and Antigravity with this computer's logins, nightly as the Savor workflow "Upstream check"; agents not signed in are skipped, and names as arguments (`… upstream-check.mjs grok`) check only those. It is not part of the checks above: each run costs a few real agent turns.

`scripts/upstream-preflight.mjs` is the preflight of "Upstream check" and "Agent-Features übernehmen" (`.workflow-checks/upstream.json`, `features.json`): work when npm or agy has a newer version than the last results of `upstream-check.mjs` (`~/.local/state/savor-upstream-check/last-run.json`) or the versions under „Zuletzt geprüft“ in the document "Claude/Codex-Abgleich", pending for a FAIL there or items under „Neu prüfen beim nächsten Lauf“ and „Als Auftrag gestartet“. Keep those headings. `scripts/savor-upstream-preflight.timer` runs it every 10 minutes, linked into `~/.config/systemd/user`.

## Deploy

- A push to `main` runs `ci.yml`. If it touches `site/`, Coolify deploys the landing page through a repo webhook. Verify: `curl -sI https://savor.pleasance.org`.
- Every push on every branch also runs `secrets.yml`, a gitleaks scan of the new commits. Catch false positives narrowly: by fingerprint in `.gitleaksignore` or by path and rule in `.gitleaks.toml`, never switch off a whole rule. The repo and its CI logs are public, so a real finding is already out: tell Robin to rotate the secret, removing it from code or history is not enough.
- The app and the relay ship only with a release, see below. `release.yml` builds the desktop app, publishes the GitHub release and deploys the relay image `ghcr.io/robinchoice/savor-relay:<version>`.

## Pitfalls

- Robin works in Savor while you change it. Changes reach `savor.service` only through a release and an update. Test against a dev server and don't restart `savor.service`: your own session may run inside it.
- When you show a UI change in a dev instance in the preview, say that it runs with test data and only shows the change: everything else looks different from Robin's instance.
- The e2e tests start `dist/server/index.mjs` when it exists, not `server/`. Without a fresh `npm run build` they test an old server and fail on new features.
- The service worker is `web/sw.ts`, bundled by esbuild into `dist/web/sw.js` during `npm run build` (it answers questions from notifications through the relay tunnel). `npm run dev:web` doesn't serve it.
- `npm test` holds `flock /tmp/savor-test.lock`, so test runs from parallel sessions and worktrees queue instead of overloading the CPU. A run that seems stuck before its first test is waiting for another one.
- Voice input runs transcribe.cpp (npm `transcribe-cpp` with `koffi`) in `dist/server/voice-worker.mjs`, a process of its own. Its native builds are one npm package per platform, and npm installs only the current machine's: `desktop/package.json` copies the one matching each build, and `release.yml` adds the x64 macOS packages on the arm64 runner. When you bump `transcribe-cpp`, also check the speech model revisions in `server/voice.ts`.
- Headless `agy` cannot ask for approval: a command without an allow rule ends the turn, a denied one only fails. Its rules in `~/.gemini/antigravity-cli/settings.json` hold for every project and match a command by its first words (`command(git)`, `command(git status)`; no wildcards). Academic writing projects add the commands their setup and export need and deny the git commands that throw work away (`server/antigravity.ts`), and the agent is told the list. The MCP bridge runs through `sh`, so Antigravity in Savor does not work on Windows yet.
- The web UI speaks English and German. Every text goes through `t('English text')` from `web/i18n.ts` (`plural()` for counts) with its German entry in `web/de.ts`; `test/i18n.test.mjs` fails on a text without one. Texts the daemon sends with values in them (health warnings, export checks) are translated in the UI by `tx()` with the patterns in `de.ts`. Browser tests pin `locale: 'en-US'`, so on a German machine they still see English.
- `site/llms.txt` is the landing page for agents (llmstxt.org), English and German, written by hand. When the landing page's content changes, update it in the same commit. It links `releases/latest` instead of a version, because `release.yml` rewrites only `site/index.html`. `site/studium/` is `noindex` and stays out of it.

## Releases

- Release only when asked to, never as a side effect of other work. A run of Robin's "Feierabend" workflow counts as being asked.
- `npm run release -- --check` shows the next version, the commits since the last tag and the CI status of `main`. Show that output before releasing and point out commits from other sessions.
- Then run `npm run release` in the main checkout. It refuses unless local `main` equals `origin/main` and CI on it is green, then bumps the version, commits, creates the signed tag `vX.Y.Z` and pushes `main` and the tag atomically. Don't bump or tag by hand.
- Bump the patch version by default; use `--minor` only when asked.
- The version lives in `package.json` and `desktop/package.json`, and the server reads it from there. Don't hard-code it anywhere else.
- Pushed tags are final. If a release fails, delete its draft, fix the cause and release the next patch version. Never delete or move a tag.
- After each release, `release.yml` pushes fresh screenshots and the landing page's download links to `main`, so fetch before the next push.
- Release files carry the version in their names. electron-updater overwrites an AppImage without a version in its name in place (like the one Robin's service starts) and renames a versioned one to the new version.

## New features

- Before a feature goes into Savor's code, check whether it works as a workflow, `ROLE.md` instructions, a project type template or a plain file in `.savor/`. Build it into the core only when it doesn't.

## Deviations from the standard

- starter builds `/llms.txt`, `/llms-full.txt` and a Markdown version of each page from `publicPages` in its API. `site/` is one static English page on nginx without a build step, so it has only a hand-written `site/llms.txt` that already holds the whole page's content. No `llms-full.txt`, no `.md` pages and no `Accept: text/markdown`.

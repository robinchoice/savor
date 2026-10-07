# Savor

## Purpose & links

- Local workspace for coding agents: Node server, web UI, Electron desktop app (`desktop/`), relay for paired remote devices (`relay/`). Setup, architecture and the development commands are in README.md.
- Landing page: https://savor.pleasance.org from `site/`, Coolify on VPS 1, project `pleasance-savor`.
- Relay: https://savor.diespaetzles.lol, Coolify on VPS 3, project `privat-savor`, application `savor-relay`.
- Robin's own instance runs as the systemd user service `savor.service` on `127.0.0.1:4317`, from the AppImage of the last release.

## Checks

`npm run build && npm run typecheck && npm test`

## Deploy

- A push to `main` runs `ci.yml`. If it touches `site/`, Coolify deploys the landing page through a repo webhook. Verify: `curl -sI https://savor.pleasance.org`.
- The app and the relay ship only with a release, see below. `release.yml` builds the desktop app, publishes the GitHub release and deploys the relay image `ghcr.io/robinchoice/savor-relay:<version>`.

## Pitfalls

- Robin works in Savor while you change it. Changes reach `savor.service` only through a release and an update. Test against a dev server and don't restart `savor.service`: your own session may run inside it.
- The e2e tests start `dist/server/index.mjs` when it exists, not `server/`. Without a fresh `npm run build` they test an old server and fail on new features.

## Releases

- Release only when asked to, never as a side effect of other work. A run of Robin's "Feierabend" workflow counts as being asked.
- `npm run release -- --check` shows the next version, the commits since the last tag and the CI status of `main`. Show that output before releasing and point out commits from other sessions.
- Then run `npm run release` in the main checkout. It refuses unless local `main` equals `origin/main` and CI on it is green, then bumps the version, commits, creates the signed tag `vX.Y.Z` and pushes `main` and the tag atomically. Don't bump or tag by hand.
- Bump the patch version by default; use `--minor` only when asked.
- The version lives in `package.json` and `desktop/package.json`, and the server reads it from there. Don't hard-code it anywhere else.
- Pushed tags are final. If a release fails, delete its draft, fix the cause and release the next patch version. Never delete or move a tag.
- After each release, `release.yml` pushes fresh screenshots to `main`, so fetch before the next push.

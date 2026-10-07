# Agent notes

Setup, architecture and the development commands are in README.md.

## Releases

- Release only when asked to, never as a side effect of other work. A run of Robin's "Feierabend" workflow counts as being asked.
- `npm run release -- --check` shows the next version, the commits since the last tag and the CI status of `main`. Show that output before releasing and point out commits from other sessions.
- Then run `npm run release` in the main checkout. It refuses unless local `main` equals `origin/main` and CI on it is green, then bumps the version, commits, creates the signed tag `vX.Y.Z` and pushes `main` and the tag atomically. Don't bump or tag by hand.
- Bump the patch version by default; use `--minor` only when asked.
- The version lives in `package.json` and `desktop/package.json`, and the server reads it from there. Don't hard-code it anywhere else.
- Pushed tags are final. If a release fails, delete its draft, fix the cause and release the next patch version. Never delete or move a tag.
- After each release, `release.yml` pushes fresh screenshots to `main`, so fetch before the next push.

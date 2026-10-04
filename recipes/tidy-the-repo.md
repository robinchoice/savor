---
title: Repo cleanup
blurb: Dead code, stale branches, leftover files and forgotten TODOs, with safe cleanups proposed.
category: Maintenance
schedule: 0 11 1 * *
---
Look for things in this repository that nobody needs anymore: unused files and exports, dependencies nothing imports, branches merged long ago, generated files that are committed, TODO comments older than the feature they mention, and scripts that no longer run.

For each, say how you know it is unused. Remove what is clearly dead and covered by the checks, in small commits. Ask before deleting branches or anything you are not sure about.

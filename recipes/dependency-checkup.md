---
title: Dependency checkup
blurb: Outdated and vulnerable packages, with the safe updates already applied.
category: Keep the code healthy
schedule: 0 7 * * 1
---
Check this project's dependencies.

1. List packages with known vulnerabilities and packages that are more than one major version behind.
2. Apply the updates that are safe: patch and minor versions, and major versions whose changelog shows no breaking change that affects this project. Run the project's checks after each group of updates.
3. For every update you skipped, say what would break and how much work the migration looks like.

Commit the applied updates in one commit. Ask before touching a package the build or deployment depends on in an unusual way.

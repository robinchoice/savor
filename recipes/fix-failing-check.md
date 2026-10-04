---
title: Get CI green
blurb: Find out why CI or the test suite is red and make it green.
category: Review and release
schedule:
---
A check is failing in this project. Find out which one: run the project's own checks (tests, typecheck, lint, build), and look at the latest CI run with the `gh` CLI if it is available.

Diagnose before you fix: read the error, find the cause, and say in one sentence what broke and when. Then fix the cause, not the symptom. Don't skip, delete or loosen a test to make it pass unless the test itself is wrong, and say so if it is.

Run the checks again to prove the fix, then commit.

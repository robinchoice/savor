---
title: Strict branch review
blurb: A strict review of the current branch before it goes anywhere.
category: Review and release
schedule:
---
Review the changes on the current branch compared with the main branch as a careful, slightly skeptical reviewer would.

Look for: bugs and edge cases, security problems (injection, missing checks, secrets), behavior that differs from what the commit messages claim, missing tests for new behavior, and code that is harder to read than it needs to be.

Report findings ordered by severity, each with file, line, what goes wrong and a concrete input that triggers it. Say what is fine, too, in one sentence. Do not change any files.

---
title: Small-bug hunt
blurb: Hunt for small bugs that never make it onto a ticket, and fix the safe ones.
category: Maintenance
schedule: 0 14 * * 5
---
Go through the code changed in the last week and look for small bugs nobody filed: unhandled errors, forgotten awaits, off-by-one loops, race conditions around async state, inputs that are never validated, resources that are never closed.

For each finding, say where it is, what goes wrong and how you know.

Fix the ones that are clearly safe and covered by the existing tests, one commit per fix, and run the checks afterwards. Leave the risky ones as a list for me to decide on.

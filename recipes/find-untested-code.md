---
title: Close test gaps
blurb: Which important code has no tests, and tests for the three riskiest parts.
category: Maintenance
schedule: 0 10 * * 1
---
Find the code in this project that matters most and is not covered by tests: things that handle money, authentication, user data, file writes, or that everything else depends on.

List the ten most important untested pieces, with the reason each one matters.

Then write tests for the top three, in the project's existing test style and framework. Run them and make sure they pass. Don't change the code under test unless a test reveals a real bug; if it does, describe the bug before fixing it.

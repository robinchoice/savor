---
title: Uplift check
blurb: After a model change, propose instructions in AGENTS.md and CLAUDE.md that the new model no longer needs.
category: Maintenance
trigger: model
---
The agent in this project now runs on a different model. Instructions written for an older model often work around its weaknesses: reminders to read before editing, to run the tests, to keep answers short, repeated warnings, step-by-step recipes for things a model does on its own now. With a stronger model they turn into ballast and make the results worse.

1. Read AGENTS.md and CLAUDE.md of this project, and the files they point to.
2. Sort every instruction:
   - Keep: facts about this project (commands, paths, links, pitfalls you cannot see in the code), the user's decisions and taste, policy, safety and anything about data or money.
   - Propose to remove: lines that only make up for a weakness of a model, or that a capable agent does anyway.
   - Unsure: say why.
3. Read the conversations in .savor/threads since the last uplift check. Look for corrections by the user: results they took back, messages starting with "no", the same request repeated, work redone by hand. Find the lines earlier runs removed with `git log -p --grep "Uplift check"`. When a correction shows a behaviour that one of those lines prevented, propose to bring it back, with the conversation as evidence.
4. Report the proposals as a short list: the line, keep / remove / bring back, and one sentence why.

Do not change any file. Ask me which proposals to apply, apply only those, and commit them as "Uplift check: <model>".

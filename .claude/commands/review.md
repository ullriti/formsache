---
description: Review the current branch's changes against the project conventions
---

Review the not-yet-merged changes on this branch.

1. Read `AGENTS.md` (incl. its Conventions section) and any nested `CLAUDE.md` in the touched areas.
2. Determine the changes: `git diff main...HEAD` (or the default branch).
3. Check for: correctness, missing tests, convention violations, secrets in the
   diff, user-visible behavior changes.
4. Summarize findings by severity; propose concrete fixes.

Don't commit anything – report only.

---
description: Checks whether the agent/knowledge files (KB, ADRs, CHANGELOG) are used and maintained correctly.
---

Audit the agent/knowledge files. Goal: detect whether the introduced structures
are **used correctly** – wrong placement, missing or forgotten entries, stale state.

## Step 1 — Mechanical check

Run `scripts/check-ai-docs.sh` and adopt its findings. It covers structure,
placement, naming conventions, required sections and dead links.

## Step 2 — Judgment checks (what the script can't do)

Read `git log --oneline -15`, `docs/kb/README.md`, `docs/architecture/README.md`
and the `[Unreleased]` block in `CHANGELOG.md`. Check:

1. **KB complete?** Are there commits with substantive work whose knowledge
   landed nowhere — neither in a KB document nor in an ADR?
2. **KB kept current?** Does each document really describe today's state, or is
   it stale (referring to long-finished or renamed things)?
3. **CHANGELOG maintained?** User-visible changes in recent commits not listed
   under `[Unreleased]`?
4. **Correct placement/separation?**
   - Architecture *decisions* as ADRs in `docs/architecture/`, numbered
     `NNNN-title.md` and listed in that folder's README.
   - Durable knowledge in `docs/kb/`, not buried in an ADR that only decides one
     question.
5. **Reference consistency?** Do KB and ADRs reference each other, the code and
   the scripts by paths that exist?
6. **No local memory instead of repo?** Look for signs that knowledge was meant
   to land in user memory instead of the repo; remind about the rule in
   `AGENTS.md` (knowledge belongs in the repo). You cannot/should not read the
   user memory itself.

## Step 3 — Report

Produce a compact report – **change nothing, report only**:

```markdown
## Audit: agent/knowledge files

### Mechanical (check-ai-docs.sh)
<summary: clean / findings>

### Findings
1. **[Category]** File — problem
   **Fix:** concrete step

### OK
- <what is maintained correctly>
```

Categories e.g.: *Placement*, *Missing entry*, *Stale*, *Inconsistency*,
*Convention violation*. If everything is clean, say so clearly.

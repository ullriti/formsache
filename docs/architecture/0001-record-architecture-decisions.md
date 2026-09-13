# 1. Record architecture decisions (ADRs)

- **Status:** accepted
- **Date:** 2026-07-22

## Context

Architecture decisions otherwise get lost in chats and commit messages. New team
members – and AI agents – then reconstruct intent from the code, which is
error-prone.

## Decision

We document every significant architecture decision as an **ADR** (Architecture
Decision Record) in `docs/architecture/`, numbered sequentially, in the format of
this file.

## Consequences

- Decisions are traceable and versioned.
- Agents can read the "why" context instead of guessing.
- Small overhead per decision.

---

## Template for new ADRs

```markdown
# N. <Decision title>

- **Status:** proposed | accepted | superseded by ADR-M
- **Date:** YYYY-MM-DD

## Context
<Which problem, which constraints?>

## Decision
<What is being decided?>

## Consequences
<Positive and negative effects, trade-offs.>
```

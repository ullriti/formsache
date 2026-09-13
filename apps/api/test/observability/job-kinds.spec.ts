import { jobKindSchema, jobOutcomeSchema } from '@formsache/shared';
import { JobKind, JobOutcome } from '@prisma/client';
import { describe, expect, it } from 'vitest';

/**
 * **The database and the wire contract count the same background runs.**
 *
 * `JobKind` (Prisma, `job_kind`) and `jobKindSchema` (`packages/shared`) are
 * two spellings of the same set. That is intentional — one is the column, the
 * other the payload —, but without this case only the type checker holds them
 * together, and it speaks up in the wrong place: when `session_purge` was added
 * to the enum, the error read "Type … is not assignable" in
 * `ops-status.service.ts:130`, that is, in a file that has nothing to do with
 * the forgotten line.
 *
 * This case says instead what is missing: **which run** in which list.
 *
 * The **order** is checked as well, not just the set: the operations page shows
 * the runs in the order of the enum, and an entry that sits at the back of one
 * list and in the middle of the other is the next finding about a display that
 * claims something other than the row.
 */
describe('die Hintergrundläufe, aus beiden Richtungen gezählt', () => {
  it('nennt in `jobKindSchema` genau die Werte von `JobKind`', () => {
    expect(jobKindSchema.options).toStrictEqual(Object.values(JobKind));
  });

  it('nennt in `jobOutcomeSchema` genau die Werte von `JobOutcome`', () => {
    expect(jobOutcomeSchema.options).toStrictEqual(Object.values(JobOutcome));
  });

  it('zählt überhaupt etwas (Boden unter dem Wächter)', () => {
    // Without this case two empty enums would be equal — and the guard an
    // assertion about nothing.
    expect(jobKindSchema.options.length).toBeGreaterThanOrEqual(7);
  });
});

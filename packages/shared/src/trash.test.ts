import { describe, expect, it } from 'vitest';

import { submissionRefusalReasonSchema } from './public-form.ts';
import {
  RESTORE_REFUSAL_MESSAGES,
  TRASH_PURGE_BATCH_SIZE,
  TRASH_RETENTION_DAYS,
  readRestoreRefusal,
  restoreRefusalReasonSchema,
  restoreRefusalSchema,
  trashCutoff,
  trashPurgeResultSchema,
  trashViewSchema,
} from './trash.ts';

/**
 * The wire contract of the trash.
 *
 * What is worth asserting here is exactly what a database test cannot see: the
 * *shape* of a refusal, and the two properties of the reason enum that make it
 * usable by a client — it is narrow, and it is not a private renaming of the
 * submission's own reasons.
 */

describe('restore refusal ', () => {
  it('names exactly the two reasons a restore can fail on', () => {
    expect(restoreRefusalReasonSchema.options).toStrictEqual([
      'limit_reached',
      'event_full',
    ]);
  });

  /**
   * The two shared reasons keep the **same spelling** as on the submission
   * path. They are the same rule counted the same way, and a client that
   * already branches on `limit_reached` must not have to learn a second name
   * for it — a rename here would be a silent contract split, invisible to
   * every test that only ever looks at one of the two payloads.
   */
  it('spells its two reasons the way the submission path spells them', () => {
    for (const reason of restoreRefusalReasonSchema.options) {
      expect(submissionRefusalReasonSchema.options).toContain(reason);
    }
  });

  it('carries a message for every reason, and says the answer stays', () => {
    for (const reason of restoreRefusalReasonSchema.options) {
      const message = RESTORE_REFUSAL_MESSAGES[reason];
      expect(message.length).toBeGreaterThan(0);
      // The half an editor has to be able to act on: „abgelehnt" and
      // „abgelehnt, und weg" read the same in the moment.
      expect(message).toContain('Papierkorb');
    }
  });

  it('takes a position for event_full and needs none for the other reason', () => {
    expect(
      restoreRefusalSchema.parse({
        message: RESTORE_REFUSAL_MESSAGES.event_full,
        reason: 'event_full',
        position: { questionId: 'q1', eventKey: 'abend' },
      }).position,
    ).toStrictEqual({ questionId: 'q1', eventKey: 'abend' });

    // Absent, not null — the same reading `submissionRefusalSchema` documents.
    expect(
      restoreRefusalSchema.parse({
        message: RESTORE_REFUSAL_MESSAGES.limit_reached,
        reason: 'limit_reached',
      }),
    ).not.toHaveProperty('position');
  });

  it('reads a foreign body as „no refusal" rather than inventing one', () => {
    expect(readRestoreRefusal('<html>502 Bad Gateway</html>')).toBeUndefined();
    expect(
      readRestoreRefusal({ message: 'weg', reason: 'password_required' }),
    ).toBeUndefined();
  });
});

describe('trash view ', () => {
  it('accepts the two sections and rejects a row without its deletion time', () => {
    const view = trashViewSchema.parse({
      forms: [
        {
          id: '019fd000-0000-7000-8000-0000000000a0',
          title: 'Bestandsmeldung',
          responseCount: 2,
          deletedAt: '2026-08-03T10:00:00.000Z',
        },
      ],
      responses: [],
    });
    expect(view.forms).toHaveLength(1);

    expect(
      trashViewSchema.safeParse({
        forms: [
          {
            id: '019fd000-0000-7000-8000-0000000000a0',
            title: 'Bestandsmeldung',
            responseCount: 2,
          },
        ],
        responses: [],
      }).success,
    ).toBe(false);
  });
});

/**
 * **Was „Papierkorb leeren" zurückmeldet** .
 *
 * The point of the schema is the last two numbers. `failed` is a state the
 * first two cannot express — an item whose file bytes the storage would not
 * release stays in the trash, and „nicht gelöscht" would otherwise be
 * indistinguishable from „war schon weg". `remaining` is the one a review finding
 * added: a call takes at most {@link TRASH_PURGE_BATCH_SIZE} items, so
 * „fertig" is a number and not the absence of one. A `strictObject`, so a
 * server that dropped either would fail here rather than let a view silently
 * stop reporting it.
 */
describe('trash purge result ', () => {
  it('carries what went, what stayed and what is left', () => {
    const result = trashPurgeResultSchema.parse({
      forms: 2,
      responses: 5,
      failed: 1,
      remaining: 3,
    });
    expect(result).toEqual({
      forms: 2,
      responses: 5,
      failed: 1,
      remaining: 3,
    });
  });

  it('refuses a payload without the failure count', () => {
    expect(
      trashPurgeResultSchema.safeParse({ forms: 0, responses: 0, remaining: 0 })
        .success,
    ).toBe(false);
  });

  /**
   * The half that makes a batched „leeren" usable: without it a client cannot
   * tell „der Papierkorb ist leer" from „der Stapel war voll" and would stop
   * after the first press with items still standing.
   */
  it('refuses a payload without the remaining count', () => {
    expect(
      trashPurgeResultSchema.safeParse({ forms: 0, responses: 0, failed: 0 })
        .success,
    ).toBe(false);
  });

  /**
   * Not a tautology: a batch size of `0` would make „Papierkorb leeren" a
   * no-op that reports `remaining` forever, and „leeren" would be a button
   * that never finishes. The only wrong values are ≤ 0 and non-integers, and
   * both are one careless edit away from a constant nothing else guards.
   */
  it('has a batch size that can actually empty something', () => {
    expect(Number.isInteger(TRASH_PURGE_BATCH_SIZE)).toBe(true);
    expect(TRASH_PURGE_BATCH_SIZE).toBeGreaterThan(0);
  });

  it('refuses a negative or fractional count', () => {
    expect(
      trashPurgeResultSchema.safeParse({
        forms: -1,
        responses: 0,
        failed: 0,
        remaining: 0,
      }).success,
    ).toBe(false);
    expect(
      trashPurgeResultSchema.safeParse({
        forms: 0,
        responses: 0,
        failed: 0,
        remaining: 0.5,
      }).success,
    ).toBe(false);
  });
});

/**
 * **The thirty days** (the requirements, Konzept no. 59 and no. 63).
 *
 * The boundary is a pure function over an injected `now`, and that is what
 * makes „nach 30 Tagen ist alles physisch weg, gemessen mit injizierter Uhr"
 * measurable at all. Asserted here rather than only through the database,
 * because the arithmetic is the part a Postgres suite cannot see going wrong by
 * an hour.
 */
describe('the 30 days of the Papierkorb ', () => {
  const NOW = new Date('2026-08-03T12:00:00.000Z');

  it('is 30 days, for a form, an answer and an organisation alike', () => {
    // The number itself, because Konzept no. 63 makes it one number on purpose:
    // three constants are three things that drift apart.
    expect(TRASH_RETENTION_DAYS).toBe(30);
  });

  it('cuts exactly 30 days back', () => {
    expect(trashCutoff(NOW).toISOString()).toBe('2026-07-04T12:00:00.000Z');
  });

  it('leaves a 29-day-old deletion standing and takes a 31-day-old one', () => {
    // The pair the purge is proven with, stated as the comparison the caller
    // makes: `deletedAt <= cutoff` is due.
    const cutoff = trashCutoff(NOW);
    const twentyNine = new Date(NOW.getTime() - 29 * 86_400_000);
    const thirtyOne = new Date(NOW.getTime() - 31 * 86_400_000);

    expect(twentyNine.getTime() <= cutoff.getTime()).toBe(false);
    expect(thirtyOne.getTime() <= cutoff.getTime()).toBe(true);
  });

  it('does not read a clock of its own', () => {
    // Twice with the same argument, an hour of real time apart would be the
    // honest test and is not affordable; what is affordable is that the answer
    // depends on nothing but the argument.
    expect(trashCutoff(NOW).getTime()).toBe(trashCutoff(NOW).getTime());
  });
});

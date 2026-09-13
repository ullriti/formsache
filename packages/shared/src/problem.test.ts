import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { QUESTIONS_PER_PAGE_MAX } from './form-schema.ts';
import {
  MAX_VALIDATION_ISSUES,
  readValidationProblem,
  toFieldIssues,
  toValidationIssues,
  validationProblem,
} from './problem.ts';

/**
 * **The cap on the public 400** (a security review).
 *
 * A 400 is longer than the request that caused it: every issue repeats the path
 * it happened at and adds a sentence. *Measured on 2026-08-07:* a 100-KiB
 * submission naming 9404 unknown table columns produced 9404 issues and an
 * **873 523 byte** body — factor **8,5**, over a route that needs no session
 * and allows 30 requests a minute per address.
 *
 * What the cases below hold on to is the pair: the list is short, and the
 * **count is not lost** — a body that quietly reported six failures where six
 * hundred happened would be a worse answer than the long one.
 */
describe('toValidationIssues — the cap on a 400 (a security review)', () => {
  /** `count` distinct custom issues, as Zod hands them over. */
  function issues(count: number): z.core.$ZodIssue[] {
    return Array.from({ length: count }, (_, index) => ({
      code: 'custom' as const,
      path: [`frage-${String(index)}`],
      message: 'Unbekannte Spalte.',
      input: undefined,
    }));
  }

  it('is the number of inputs one page of a form can have', () => {
    // Not a round number somebody liked: the fill-in view marks its fields from
    // `path` and shows one page at a time, so "as many as can stand on one
    // page" is the smallest cap that never blanks a visible field.
    expect(MAX_VALIDATION_ISSUES).toBe(QUESTIONS_PER_PAGE_MAX);
  });

  it('carries every issue of a failure a human can produce', () => {
    // Five empty required fields — two orders of magnitude below the cap.
    expect(toValidationIssues(issues(5))).toHaveLength(5);
    expect(toValidationIssues(issues(MAX_VALIDATION_ISSUES))).toHaveLength(
      MAX_VALIDATION_ISSUES,
    );
  });

  it('truncates the flood and still says how large it was', () => {
    const problem = validationProblem(
      'Bitte die markierten Felder prüfen.',
      issues(9404),
    );

    expect(problem.issues).toHaveLength(MAX_VALIDATION_ISSUES);
    expect(problem.issueCount).toBe(9404);
    // **The first ones, not just any** — the order of the questions is the
    // order of the output, and the client jumps to the first page with
    // a finding.
    expect(problem.issues[0]?.path).toBe('frage-0');
    expect(problem.issues.at(-1)?.path).toBe(
      `frage-${String(MAX_VALIDATION_ISSUES - 1)}`,
    );
  });

  /**
   * **Measured, not claimed:** the point of the cap is the size of what
   * leaves the machine. A body built from a flood must be small enough that the
   * answer can no longer be larger than the request that provoked it — the 100
   * KiB `JSON_BODY_LIMIT_BYTES` allows.
   */
  it('keeps the body below the request that can provoke it', () => {
    const problem = validationProblem(
      'Bitte die markierten Felder prüfen.',
      issues(9404),
    );

    expect(Buffer.byteLength(JSON.stringify(problem))).toBeLessThan(100 * 1024);
  });

  it('leaves the count off nothing and reads back through the schema', () => {
    const problem = validationProblem('Die Anfrage ist ungültig.', issues(3));

    // The wire contract parses what the API writes — the client's own door.
    expect(readValidationProblem(JSON.parse(JSON.stringify(problem)))).toEqual(
      problem,
    );
    expect(problem.issueCount).toBe(3);
    expect(Object.keys(toFieldIssues(problem))).toHaveLength(3);
  });

  /**
   * A body from before this change — no `issueCount` — still parses. The field
   * is an addition to the contract, not a change to it.
   */
  it('reads a body without the count', () => {
    const parsed = readValidationProblem({
      message: 'Die Anfrage ist ungültig.',
      issues: [{ path: 'title', message: 'Pflichtfeld.' }],
    });

    expect(parsed?.issues).toHaveLength(1);
    expect(parsed?.issueCount).toBeUndefined();
  });
});

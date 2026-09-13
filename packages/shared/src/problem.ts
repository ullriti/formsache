import { z } from 'zod';

import { QUESTIONS_PER_PAGE_MAX } from './form-schema.ts';

/**
 * The shape of a validation failure — produced by the API, read by the client.
 *
 * A wire contract like any other, and therefore here rather than in either
 * side (`CONTRIBUTING.md`). It is written by two controllers (the form routes and
 * the public fill-in) and read by the fetch layer of the web app; a private
 * copy on each side is how "the server names fields" and "the client marks
 * fields" quietly stop meaning the same thing.
 *
 * `path` is the dotted path the server saw — a question id for a submission,
 * `pages.0.questions.2.pattern` for a form definition. The client keys its
 * field markers by it and needs nothing else.
 */
export const validationIssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  /**
   * The **rule** that refused, where the rule has a name — `path` says which
   * field, `message` says it in German, and this says it in a way a caller can
   * branch on (`TABLE_ROW_LIMIT_CODE`).
   *
   * `.optional()`, because almost no issue carries one: the ordinary „zu lang",
   * „Pflichtfeld", „kein Datum" are Zod's own and need no second name. A client
   * that ignores the field sees exactly what it saw before, which is why this
   * is an addition to the contract rather than a change to it.
   */
  code: z.string().optional(),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

/**
 * **The most field messages one 400 carries back** — the deckel on a public
 * route's answer amplification (a security review).
 *
 * ## The measurement
 *
 * A 400 is longer than the request that caused it, because each issue repeats
 * the path it happened at and adds a German sentence. *Gemessen am 2026-08-07:*
 * a **100-KiB** submission naming 9404 unknown Tabellen-Spalten produced
 * **9404** issues and an **873 523 Byte** body — factor **8,5**, over a route
 * that needs no session and allows 30 requests a minute per address. It is the
 * cheapest amplifier in the application: the sender pays 100 KiB up and gets
 * roughly a megabyte down, and the work of building it is the server's.
 *
 * ## Why exactly `QUESTIONS_PER_PAGE_MAX`
 *
 * The list is not decoration — the fill-in view marks its inputs from `path`
 * and jumps to the first page carrying one (`FillIn.tsx`), so a cap that cuts
 * too deep turns „Bitte die markierten Felder prüfen." into a sentence about
 * nothing. The number is therefore taken from the form schema rather than
 * chosen: **one page can hold at most `QUESTIONS_PER_PAGE_MAX` questions**, and
 * a page is what a participant sees at once. Every field the participant is
 * looking at can still be marked, and any real human failure — five empty
 * Pflichtfelder, a date in the past — is two orders of magnitude below the cap.
 *
 * **What it costs, said plainly:** a *composite* answer can fail several times
 * over (a Matrix reports per row), so a document that produces more than 200
 * issues on a single page loses the markers past the cut. That is a payload no
 * fill-in view can produce, and `issueCount` still says how many there were.
 *
 * A cap rather than a summary sentence, and a `slice` rather than a
 * de-duplication by path: the first issues are the first questions, `path` and
 * `code` keep meaning exactly what they meant, and a caller that reads neither
 * sees what it saw before.
 */
export const MAX_VALIDATION_ISSUES = QUESTIONS_PER_PAGE_MAX;

/**
 * Zod's issues as the wire carries them — **one mapper, every route**.
 *
 * It used to be four byte-identical `issues.map(…)` in three files, and the
 * cost of that shape is exactly the one CONTRIBUTING.md warns about: a route that
 * grows a field the others do not is a 400 whose shape depends on which door
 * the request came in. The machine-readable `code` is the first field where
 * that would have shown, and it is the reason this exists.
 *
 * `params.code` rather than a Zod field of its own: a custom issue is the only
 * kind that can carry one, and `params` is where Zod puts what a refinement
 * attaches to it. Anything else — a `params` without a `code`, a `code` that is
 * not a string — reads as „kein Code", never as a value invented here.
 *
 * **Truncated at {@link MAX_VALIDATION_ISSUES}**, and this is the one place it
 * may be: the same argument that puts the mapper here puts the cap here. A
 * route that capped and a route that did not would be two different 400s again.
 * How many there really were travels beside the list — {@link validationProblem}
 * is what puts it there, and it is the only correct way to build the body.
 */
export function toValidationIssues(
  issues: readonly z.core.$ZodIssue[],
): ValidationIssue[] {
  return issues.slice(0, MAX_VALIDATION_ISSUES).map((issue) => {
    const code =
      issue.code === 'custom' && typeof issue.params?.code === 'string'
        ? issue.params.code
        : undefined;
    return {
      path: issue.path.join('.'),
      message: issue.message,
      ...(code === undefined ? {} : { code }),
    };
  });
}

export const validationProblemSchema = z.object({
  message: z.string(),
  issues: z.array(validationIssueSchema),
  /**
   * How many rules refused **in total**, whether or not their issue is in
   * `issues` above (see {@link MAX_VALIDATION_ISSUES}).
   *
   * `.optional()` for the reason `ValidationIssue.code` is: a reader that
   * ignores it sees exactly what it saw before, so this is an addition to the
   * contract rather than a change to it. A body without it means „so viele, wie
   * dastehen" — never „unbekannt viele".
   */
  issueCount: z.number().int().nonnegative().optional(),
});
export type ValidationProblem = z.infer<typeof validationProblemSchema>;

/**
 * The body of a 400, built in **one** place — message, the capped issue list
 * and the true count.
 *
 * Every write path that reports Zod's refusals goes through here rather than
 * assembling `{message, issues}` itself. That is not tidiness: `issues` is
 * truncated, and a route that built the object by hand would report a short
 * list with no `issueCount` beside it, i.e. it would silently claim that six
 * fields failed when six hundred did.
 */
export function validationProblem(
  message: string,
  issues: readonly z.core.$ZodIssue[],
): ValidationProblem {
  return {
    message,
    issues: toValidationIssues(issues),
    issueCount: issues.length,
  };
}

/**
 * Reads an error body, or answers `undefined`.
 *
 * Tolerant on purpose: the body of a failed request is foreign data like any
 * other, and a proxy's HTML error page must not become a field marker on a
 * random question. Anything that is not this shape is simply not field
 * information.
 */
export function readValidationProblem(
  source: unknown,
): ValidationProblem | undefined {
  const parsed = validationProblemSchema.safeParse(source);
  return parsed.success ? parsed.data : undefined;
}

/** Field messages keyed by path — what a form view marks its inputs from. */
export function toFieldIssues(
  problem: ValidationProblem,
): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const issue of problem.issues) {
    // The first message per field wins: a question can fail two rules at once,
    // and stacking both under one input helps nobody.
    issues[issue.path] ??= issue.message;
  }
  return issues;
}

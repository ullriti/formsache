import { validationProblem } from '@formsache/shared';
import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Parses a request body — parse, never cast (`CONTRIBUTING.md`).
 *
 * The issue list is passed on, because unlike a login these messages carry no
 * secret: the sender wrote the document being described, and „values.closeAt:
 * ‚Schließt am' muss nach ‚Öffnet am' liegen" is the whole value of validating
 * it. Letting the `ZodError` escape instead would produce a 500.
 *
 * Lifted out of `forms.controller.ts` when the settings routes needed the
 * same thing. One copy rather than two, so the shape of a 400 — and the promise
 * that a path travels with it — cannot differ per controller.
 *
 * The **whole body** is built by `validationProblem` (`packages/shared`), the
 * same function the public routes use: an issue may carry a
 * machine-readable `code` beside its path, and since a security review
 * the list is capped at `MAX_VALIDATION_ISSUES` with the true count beside it.
 * A body assembled per route family is how one of them ends up without either.
 */
export function parseRequest<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new BadRequestException(
      validationProblem('Die Anfrage ist ungültig.', parsed.error.issues),
    );
  }
  return parsed.data;
}

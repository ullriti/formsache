import { expect } from 'vitest';
import { readValidationProblem } from '@formsache/shared';

/**
 * The field paths of a refused write — the one shape more than one legal-text
 * suite asks about.
 *
 * Read through `readValidationProblem` rather than by hand: whether the body
 * still *is* a validation problem is half of what the interface depends on — a
 * body of a different shape is silently no field information at all
 * (`problem.ts`).
 *
 * Here and not in each suite, because it was written twice before this file
 * existed and the two copies would have been free to disagree about what
 * counts as a field message.
 */
export function validationPaths(
  status: number,
  body: unknown,
): readonly string[] {
  expect(status).toBe(400);
  const problem = readValidationProblem(body);
  expect(problem, 'Der Antwortkörper ist kein validationProblem').toBeDefined();
  return (problem?.issues ?? []).map((issue) => issue.path);
}

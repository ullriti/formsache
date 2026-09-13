import { questionTypeSchema } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  AI_FORM_JSON_SCHEMA,
  AI_FORM_JSON_SCHEMA_TYPES,
  AI_FORM_TOOL_NAME,
} from '../../src/ai/ai-form-json-schema';

/**
 * **The schema that goes to the providers is derived, and stays derived**
 * (Konzept no. 89, ADR-0015 no. 3(c)).
 *
 * The point of the whole file under test is that there is **one** description
 * of a form in this repository. That is an intention until something is red
 * when it stops being true — which is what the equality below is for.
 */

/** Everything Zod stamps on a schema that the two providers do not want. */
function keywordsIn(schema: unknown): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      walk(value);
    }
  };
  walk(schema);
  return found;
}

describe('the JSON schema handed to the providers', () => {
  /**
   * **The guard.** A seventeenth question type that never reached the
   * rendering would leave the model unable to propose it, and nothing would
   * say so — the same construction as `env-contract.test.ts`, an equality
   * rather than a superset.
   */
  it('offers exactly the question types of the shared schema', () => {
    expect([...AI_FORM_JSON_SCHEMA_TYPES].sort()).toEqual(
      [...questionTypeSchema.options].sort(),
    );
  });

  it('is an object schema whose only required member is the page list', () => {
    expect(AI_FORM_JSON_SCHEMA.type).toBe('object');
    expect(AI_FORM_JSON_SCHEMA.required).toEqual(['pages']);
    // `title` is the model's *suggestion* and optional by decision
    // (`ai-form-draft.ts`): a good form without a name must not cost a second
    // counted call.
    expect(Object.keys(AI_FORM_JSON_SCHEMA.properties).sort()).toEqual([
      'pages',
      'title',
    ]);
  });

  /**
   * The two mechanical normalisations, measured rather than described. Both
   * would otherwise be a sentence in a comment that no provider reads.
   */
  it('carries neither a dialect declaration nor oneOf', () => {
    const keywords = keywordsIn(AI_FORM_JSON_SCHEMA);
    expect(keywords).not.toContain('$schema');
    expect(keywords).not.toContain('oneOf');
    // …and the rename actually happened rather than the branches vanishing.
    expect(keywords).toContain('anyOf');
    expect(keywords).toContain('$ref');
  });

  /**
   * **The size, as a number in the run** — this rides on every single call, in
   * tokens an organisation pays for.
   *
   * The budget is deliberately loose (roughly twice today's 11.8 kB) so it is
   * not a maintenance tax; what it catches is the one failure that would
   * otherwise be silent: `reused: 'ref'` no longer extracting `$defs`, which
   * inlines the same schema to 37 kB.
   */
  it('stays inside its size budget', () => {
    const bytes = JSON.stringify(AI_FORM_JSON_SCHEMA).length;
    expect(bytes).toBeGreaterThan(4_000);
    expect(bytes).toBeLessThan(24_000);
    expect(Object.keys(AI_FORM_JSON_SCHEMA.$defs ?? {}).length).toBeGreaterThan(
      0,
    );
  });

  it('names the document in a way both providers accept', () => {
    // Anthropic tool names and Mistral `json_schema.name` share the same
    // conservative alphabet; a name outside it fails at the provider, where we
    // cannot see it.
    expect(AI_FORM_TOOL_NAME).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});

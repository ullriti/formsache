import { describe, expect, it } from 'vitest';

import { pinnedMistralModel } from './mistral-model-alias';

/**
 * **The alias rule, against the *measured* list** .
 *
 * The groupings below are no invented examples: they stand like that in the
 * answer of `GET /v1/models` at `api.eu.mistral.ai`, run on 2026-08-12
 * (56 entries). That is why they are written out instead of being derived from a
 * constant — an assurance about an outside service that feeds on our
 * own code proves our code.
 */
describe('pinnedMistralModel', () => {
  it.each([
    {
      name: 'der Alias, den die Vorgabe benutzt',
      id: 'mistral-large-latest',
      aliases: ['mistral-large-2512'],
      expected: 'mistral-large-2512',
    },
    {
      name: 'die Gegenrichtung — die Liste nennt Aliasse symmetrisch',
      id: 'mistral-large-2512',
      aliases: ['mistral-large-latest'],
      expected: 'mistral-large-2512',
    },
    {
      /**
       * The instructive case: **seven** identifiers for the same thing, of which
       * exactly one is dated. `mistral-medium-3-5` stands in the middle of them and is
       * an alias, although it looks like a version.
       */
      name: 'die Medium-Gruppe mit sieben Namen und einer Datierung',
      id: 'mistral-medium-latest',
      aliases: [
        'mistral-medium',
        'mistral-medium-3-5',
        'mistral-medium-3.5',
        'mistral-medium-3',
        'mistral-medium-2604',
        'mistral-vibe-cli-latest',
        'mistral-vibe-cli-with-tools',
      ],
      expected: 'mistral-medium-2604',
    },
    {
      name: 'Small, dessen Gruppe auch einen Fremdnamen führt',
      id: 'mistral-small-latest',
      aliases: [
        'mistral-small-2603',
        'mistral-vibe-cli-fast',
        'magistral-small-latest',
      ],
      expected: 'mistral-small-2603',
    },
    {
      // A discontinued old identifier without aliases — it resolves to itself,
      // without the rule needing a special case for it.
      name: 'eine bereits datierte Kennung ohne Gruppe',
      id: 'mistral-medium-2508',
      aliases: [],
      expected: 'mistral-medium-2508',
    },
  ])('$name', ({ id, aliases, expected }) => {
    expect(pinnedMistralModel(id, aliases)).toBe(expected);
  });

  /**
   * **`null` is an answer, not an error.**
   *
   * Both directions stand here, because only the second one proves something: that a
   * group *without* a dating gives `null` would also be true of a rule that
   * always gives `null`. The case below it — **two** dated identifiers — is
   * the one at which a careless rule would guess „nimm die erste".
   */
  it.each([
    {
      name: 'keine datierte Kennung in der Gruppe',
      id: 'mistral-vibe-cli-latest',
      aliases: ['mistral-medium', 'mistral-medium-3'],
    },
    {
      name: 'zwei datierte Kennungen — jede Wahl wäre geraten',
      id: 'irgendwas-latest',
      aliases: ['irgendwas-2512', 'irgendwas-2604'],
    },
  ])('gibt null: $name', ({ id, aliases }) => {
    expect(pinnedMistralModel(id, aliases)).toBeNull();
  });

  /**
   * An identifier named twice is no ambiguity — the list is the
   * self-declaration of an outside service, no normalised table.
   */
  it('zählt eine doppelt genannte Kennung einmal', () => {
    expect(
      pinnedMistralModel('mistral-large-latest', [
        'mistral-large-2512',
        'mistral-large-2512',
      ]),
    ).toBe('mistral-large-2512');
  });

  /** And the default without arguments: one identifier alone, without an alias list. */
  it('kommt ohne Aliasliste aus', () => {
    expect(pinnedMistralModel('mistral-large-2512')).toBe('mistral-large-2512');
    expect(pinnedMistralModel('mistral-large-latest')).toBeNull();
  });
});

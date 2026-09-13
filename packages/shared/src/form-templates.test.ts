import { describe, expect, it } from 'vitest';

import type { FormDefinition, Question } from './form-schema.ts';
import { EMPTY_SETTINGS_OVERRIDE } from './form-settings.ts';
import {
  FORM_TEMPLATE_NAME_MAX,
  formTemplateContentSchema,
  formTemplateInstanceSchema,
  renameFormTemplateRequestSchema,
  saveFormTemplateRequestSchema,
  templateQuestionCount,
  updateFormTemplateContentRequestSchema,
  type FormTemplateContent,
} from './form-templates.ts';

const PAGE_A = '019fe900-0000-7000-8000-0000000000a1';
const PAGE_B = '019fe900-0000-7000-8000-0000000000a2';
const Q1 = '019fe900-0000-7000-8000-000000000001';
const Q2 = '019fe900-0000-7000-8000-000000000002';
const Q3 = '019fe900-0000-7000-8000-000000000003';

function textQuestion(id: string): Question {
  return {
    id,
    type: 'text',
    label: `Frage ${id}`,
    hint: null,
    required: false,
    width: 'full',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

/**
 * A table, „ergänzbar" or not — the absent `addRows` is the fixed one, and
 * it is spelled by leaving the key out rather than by writing `undefined`.
 */
function tableQuestion(addRows?: { maxRows: number }): Question {
  return {
    id: Q1,
    type: 'table',
    label: 'Begleitpersonen',
    hint: null,
    required: false,
    width: 'full',
    columns: [{ key: 'spalte-1', label: 'Name', type: 'text' }],
    rows: 1,
    ...(addRows === undefined ? {} : { addRows }),
  };
}

const definition: FormDefinition = {
  pages: [
    {
      id: PAGE_A,
      title: 'Seite 1',
      description: null,
      questions: [textQuestion(Q1), textQuestion(Q2)],
    },
    {
      id: PAGE_B,
      title: 'Seite 2',
      description: null,
      questions: [textQuestion(Q3)],
    },
  ],
};

describe('formTemplateContentSchema', () => {
  it('accepts a form Vorlage and keeps the settings document it carries', () => {
    const parsed = formTemplateContentSchema.parse({
      kind: 'form',
      title: 'Bestandsmeldung',
      definition,
      settingsOverride: {
        overridden: { confirm: true },
        values: {
          confirmTitle: 'Danke!',
          closeAt: '2026-09-30T22:00:00.000Z',
        },
      },
    });

    expect(parsed.kind).toBe('form');
    if (parsed.kind !== 'form') {
      throw new Error('expected a form template');
    }
    expect(parsed.definition.pages).toHaveLength(2);
    // The sections that are not named now stand there spelled out: since a
    // later rework the contract describes this document instead of passing it
    // through as `z.unknown()`, and `settingsOverriddenSchema` says „not
    // adopted" for every section that nobody named.
    // *Verfügbarkeit* has no switch any more (ADR-0011, amendment
    // 2026-08-14) — the template nevertheless carries its values along, because
    // on the target form they are that form's own.
    expect(parsed.settingsOverride).toStrictEqual({
      overridden: {
        access: false,
        confirm: true,
        display: false,
        budget: false,
      },
      values: {
        confirmTitle: 'Danke!',
        closeAt: '2026-09-30T22:00:00.000Z',
      },
    });
  });

  /**
   * Rework on a review finding — the one place that can carry a secret was the
   * only one the contract did not describe.
   *
   * *Reproduction:* set `settingsOverride` back to `z.unknown()` → both
   * assertions turn red, and the row travels byte-identical into
   * `form.settings_override`. Measured on 2026-08-05 that ended in a permanent
   * 500 on `GET /forms/:id/settings`.
   */
  it('rejects a settings document the write path could never have produced', () => {
    const foreignKey = formTemplateContentSchema.safeParse({
      kind: 'form',
      title: 'Handgeschrieben',
      definition,
      settingsOverride: {
        values: { passwordEnabled: true, password: 'KLARTEXT-GEHEIM' },
        unbekannterSchluessel: 'x',
      },
    });
    const wrongType = formTemplateContentSchema.safeParse({
      kind: 'form',
      title: 'Handgeschrieben',
      definition,
      settingsOverride: { values: { passwordEnabled: 'ja' } },
    });

    expect(foreignKey.success).toBe(false);
    expect(wrongType.success).toBe(false);
  });

  /**
   * And the counter-check that keeps the promise honest: the *cross-field* rules
   * stay outside. A password protection without a word is valid here, because
   * only the system level decides what the document means — that is checked on
   * insertion (`FormsService.create`, 422), where this level is present.
   */
  it('leaves the cross-field rules to the moment the Vorlage lands on a form', () => {
    const parsed = formTemplateContentSchema.safeParse({
      kind: 'form',
      title: 'Erst später beurteilt',
      definition,
      settingsOverride: {
        overridden: { access: true },
        values: { passwordEnabled: true, password: '' },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('rejects a key the contract does not name — a Vorlage is not a place to smuggle a column through', () => {
    const smuggled = formTemplateContentSchema.safeParse({
      kind: 'page',
      page: definition.pages[0],
      publicSlug: 'A5uJ0V9pQ1m2n3o4',
    });

    expect(smuggled.success).toBe(false);
  });

  it('rejects a page Vorlage with no page and a question Vorlage with no question', () => {
    expect(formTemplateContentSchema.safeParse({ kind: 'page' }).success).toBe(
      false,
    );
    expect(
      formTemplateContentSchema.safeParse({ kind: 'question' }).success,
    ).toBe(false);
  });

  /**
   * „Zeilen ergänzbar" survives being saved as a template and read back.
   *
   * The mechanism is that this schema holds `questionSchema` itself rather
   * than a description of a question written a second time — but „it goes
   * through `questionSchema`" is a claim about the code, and the way it fails
   * is quiet: a template of a growing table would come back fixed, and the
   * form built from it would refuse the „+ Zeile" its source offered. Both
   * halves are asserted below, on the same round trip that stores the row a
   * template actually is.
   */
  it('carries „Zeilen ergänzbar" through a Vorlage, both ways', () => {
    const growing = tableQuestion({ maxRows: 6 });

    // Out of the builder, into the row: what `form_template.content` holds
    // once JSONB has been through it.
    const stored: unknown = JSON.parse(
      JSON.stringify(
        formTemplateContentSchema.parse({
          kind: 'question',
          question: growing,
        }),
      ),
    );
    // …and back out of it, which is where a lost field would first show.
    const restored = formTemplateContentSchema.parse(stored);

    expect(restored.kind === 'question' && restored.question).toStrictEqual(
      growing,
    );

    // The counterpart: a fixed table stays fixed rather than picking up a
    // default on the way through — otherwise this test would pass on a schema
    // that simply invented `addRows` for everybody.
    const fixed = formTemplateContentSchema.parse({
      kind: 'question',
      question: tableQuestion(),
    });
    expect(
      fixed.kind === 'question' && Object.hasOwn(fixed.question, 'addRows'),
    ).toBe(false);
  });
});

describe('templateQuestionCount', () => {
  it('counts across every page of a form Vorlage', () => {
    const content: FormTemplateContent = {
      kind: 'form',
      title: 'Zwei Seiten',
      definition,
      settingsOverride: EMPTY_SETTINGS_OVERRIDE,
    };

    expect(templateQuestionCount(content)).toBe(3);
  });

  it('counts a page’s own questions, and a single question as one', () => {
    const page = definition.pages[0];
    if (page === undefined) {
      throw new Error('expected a page');
    }

    expect(templateQuestionCount({ kind: 'page', page })).toBe(2);
    expect(
      templateQuestionCount({ kind: 'question', question: textQuestion(Q1) }),
    ).toBe(1);
  });
});

describe('saveFormTemplateRequestSchema', () => {
  it('takes a name and — for a page or a question — the part it names', () => {
    expect(
      saveFormTemplateRequestSchema.parse({ kind: 'form', name: 'Meine BT' }),
    ).toStrictEqual({ kind: 'form', name: 'Meine BT' });
    expect(
      saveFormTemplateRequestSchema.parse({
        kind: 'page',
        name: 'Ihre Daten',
        pageId: PAGE_A,
      }),
    ).toStrictEqual({ kind: 'page', name: 'Ihre Daten', pageId: PAGE_A });
  });

  it('refuses a page save without a page and a nameless save', () => {
    expect(
      saveFormTemplateRequestSchema.safeParse({ kind: 'page', name: 'x' })
        .success,
    ).toBe(false);
    expect(
      saveFormTemplateRequestSchema.safeParse({ kind: 'form', name: '   ' })
        .success,
    ).toBe(false);
  });

  it('carries no definition of its own — the server reads the form it addresses', () => {
    const withDefinition = saveFormTemplateRequestSchema.safeParse({
      kind: 'form',
      name: 'Untergeschoben',
      definition,
    });

    expect(withDefinition.success).toBe(false);
  });
});

describe('renameFormTemplateRequestSchema ', () => {
  it('nimmt einen Namen und sonst nichts — kein Inhalt reist am Umbenennen mit', () => {
    expect(
      renameFormTemplateRequestSchema.parse({ name: 'BT-Anmeldung 2027' }),
    ).toStrictEqual({ name: 'BT-Anmeldung 2027' });
    // Reproduction: replace `strictObject` with `object` → green, and an
    // „Umbenennen" that sets the content on the side would be a valid request.
    expect(
      renameFormTemplateRequestSchema.safeParse({
        name: 'Untergeschoben',
        kind: 'form',
      }).success,
    ).toBe(false);
  });

  it('misst den Namen an derselben Regel wie das Speichern', () => {
    expect(
      renameFormTemplateRequestSchema.safeParse({ name: '  ' }).success,
    ).toBe(false);
    expect(
      renameFormTemplateRequestSchema.safeParse({
        name: 'x'.repeat(FORM_TEMPLATE_NAME_MAX + 1),
      }).success,
    ).toBe(false);
  });
});

describe('updateFormTemplateContentRequestSchema ', () => {
  it('zeigt auf einen Teil des Formulars, wie das Speichern — nur ohne Namen', () => {
    expect(
      updateFormTemplateContentRequestSchema.parse({ kind: 'form' }),
    ).toStrictEqual({ kind: 'form' });
    expect(
      updateFormTemplateContentRequestSchema.parse({
        kind: 'page',
        pageId: PAGE_A,
      }),
    ).toStrictEqual({ kind: 'page', pageId: PAGE_A });
    expect(
      updateFormTemplateContentRequestSchema.safeParse({ kind: 'page' })
        .success,
    ).toBe(false);
  });

  it('trägt weder Namen noch Definition — beides wäre ein zweiter Weg an den Filtern vorbei', () => {
    // A `name` here would mean: „I only wanted to rename" is one forgotten
    // field away from the irreversible overwriting.
    expect(
      updateFormTemplateContentRequestSchema.safeParse({
        kind: 'form',
        name: 'Nebenbei',
      }).success,
    ).toBe(false);
    // And a definition sent along would be the document of the client — in
    // which the access word stands as a redaction mark.
    expect(
      updateFormTemplateContentRequestSchema.safeParse({
        kind: 'form',
        definition,
      }).success,
    ).toBe(false);
  });
});

describe('formTemplateInstanceSchema', () => {
  it('has no `form` member — a form Vorlage becomes a row, not something to append', () => {
    const page = definition.pages[0];
    if (page === undefined) {
      throw new Error('expected a page');
    }

    expect(formTemplateInstanceSchema.parse({ kind: 'page', page }).kind).toBe(
      'page',
    );
    expect(
      formTemplateInstanceSchema.safeParse({ kind: 'form', definition })
        .success,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { EDIT_LINK_MARK, type FormDefinition } from '@formsache/shared';

import { mailContextOf, renderNotificationBody } from './notification-render';

/**
 * How one answer becomes what a notification says.
 *
 * The escaping itself belongs to `packages/shared` and is proven there; what is
 * proven here is the *assembly* — that the table carries every question of the
 * answer's own version, that a value this application did not write does not
 * take a delivery down, and that an HTML notification really does carry a
 * plain-text alternative.
 */

const NAME = '019ffb00-0000-7000-8000-000000000001';
const SEMESTER = '019ffb00-0000-7000-8000-000000000002';
const REMARK = '019ffb00-0000-7000-8000-000000000003';
/** The one with a „Sonstiges" box — see the `other: ''` case below. */
const MEAL = '019ffb00-0000-7000-8000-000000000004';
/** A callout, not a question — and a review finding. */
const NOTICE = '019ffb00-0000-7000-8000-000000000006';
/** The three structured answers with a canonically empty form — a review finding. */
const ADDRESS = '019ffb00-0000-7000-8000-000000000007';
const MATRIX = '019ffb00-0000-7000-8000-000000000008';
const TABLE = '019ffb00-0000-7000-8000-000000000009';
const NACHWEIS = '019ffb00-0000-7000-8000-00000000000a';

const definition: FormDefinition = {
  pages: [
    {
      id: '019ffb00-0000-7000-8000-0000000000a0',
      title: 'Anmeldung',
      description: null,
      questions: [
        {
          id: NAME,
          type: 'text',
          label: 'Name',
          hint: null,
          required: true,
          width: 'full',
          minLength: null,
          maxLength: null,
          pattern: null,
        },
        {
          id: SEMESTER,
          type: 'number',
          label: 'Semester',
          hint: null,
          required: false,
          width: 'half',
          min: null,
          max: null,
          integer: false,
        },
        {
          id: REMARK,
          type: 'textarea',
          label: 'Anmerkung',
          hint: null,
          required: false,
          width: 'full',
          minLength: null,
          maxLength: null,
        },
        {
          id: MEAL,
          type: 'checkbox',
          label: 'Verpflegung',
          hint: null,
          required: false,
          width: 'full',
          options: [
            { value: 'fleisch', label: 'Mit Fleisch' },
            { value: 'vegetarisch', label: 'Vegetarisch' },
          ],
          allowOther: true,
          otherLabel: 'Sonstiges',
          minSelected: null,
          maxSelected: null,
        },
        {
          id: NOTICE,
          type: 'info',
          label: 'Bitte pünktlich erscheinen.',
          hint: 'Einlass ab 9 Uhr.',
          required: false,
          width: 'full',
        },
        {
          id: ADDRESS,
          type: 'address',
          label: 'Anschrift',
          hint: null,
          required: false,
          width: 'full',
        },
        {
          id: MATRIX,
          type: 'matrix',
          label: 'Bewertung',
          hint: null,
          required: false,
          width: 'full',
          rows: [{ value: 'organisation', label: 'Organisation' }],
          columns: [{ value: 'gut', label: 'Gut' }],
          multiple: false,
        },
        {
          id: TABLE,
          type: 'table',
          label: 'Begleitpersonen',
          hint: null,
          required: false,
          width: 'full',
          columns: [{ key: 'name', label: 'Name', type: 'text' }],
          rows: 2,
        },
        {
          id: NACHWEIS,
          type: 'file',
          label: 'Nachweis',
          hint: null,
          required: false,
          width: 'full',
          maxFiles: 2,
        },
      ],
    },
  ],
};

const SUBMITTED_AT = new Date('2026-07-28T08:00:00.000Z');

function contextOf(
  answers: Record<string, unknown>,
  previousAnswers: Record<string, unknown> | null = null,
) {
  return mailContextOf({
    tenantName: 'Organisation Alpha',
    formTitle: 'Jahrestagung 2026',
    submittedAt: SUBMITTED_AT,
    definition,
    answers,
    previousAnswers,
  });
}

describe('mailContextOf', () => {
  it('carries every answerable question of the version, blanks included', () => {
    const context = contextOf({ [NAME]: 'Anton Aktiv' });

    // One row per question: `{{antworten}}` is „die Tabelle mit allen
    // Feldwerten", and a table that dropped the blanks would read as though the
    // participant had never been asked.
    //
    // **The Infotext is the exception, and it is not a blank row** (a review finding): a callout was never asked, so „keine
    // Frage, keine Antwort" — measured on the sent body in
    // `test/public/submission-mail.spec.ts`, decided once in
    // `answerableQuestions` (`@formsache/shared`).
    expect(context.answers).toEqual([
      { questionId: NAME, label: 'Name', value: 'Anton Aktiv' },
      { questionId: SEMESTER, label: 'Semester', value: '' },
      { questionId: REMARK, label: 'Anmerkung', value: '' },
      { questionId: MEAL, label: 'Verpflegung', value: '' },
      { questionId: ADDRESS, label: 'Anschrift', value: '' },
      { questionId: MATRIX, label: 'Bewertung', value: '' },
      { questionId: TABLE, label: 'Begleitpersonen', value: '' },
      { questionId: NACHWEIS, label: 'Nachweis', value: '' },
    ]);
    expect(context.answers.map((row) => row.questionId)).not.toContain(NOTICE);
  });

  /**
   * **The mail is the second way an answer leaves the house**, and ADR-0014
   * no. 17 is about all of them, not only the CSV: the name goes out, the way
   * to the bytes does not. A mail is forwarded, printed and left in inboxes;
   * an address in it would be a door that outlives every session.
   *
   * Missing until a later review — `address`, `matrix` and `table` were
   * covered here, `file` was not.
   */
  it('carries a file name into the mail and never the way to it', () => {
    const context = contextOf({
      [NACHWEIS]: {
        files: [
          { ref: 'AbCdEfGhIjKlMnOpQrStUv', name: 'Nachweis Müller.pdf' },
          { ref: 'ZyXwVuTsRqPoNmLkJiHgFe', name: 'Anlage.pdf' },
        ],
      },
    });

    const row = context.answers.find((entry) => entry.questionId === NACHWEIS);
    expect(row?.value).toBe('Nachweis Müller.pdf, Anlage.pdf');

    // The negative half, over the whole rendered context rather than this one
    // cell: neither the retrieval route nor a reference may appear anywhere.
    const rendered = JSON.stringify(context);
    expect(rendered).not.toContain('/api/');
    expect(rendered).not.toContain('AbCdEfGhIjKlMnOpQrStUv');
  });

  it('formats a number the way the export does', () => {
    const context = contextOf({ [SEMESTER]: 4.5 });

    // German decimal comma — the same `formatAnswerCell` the CSV uses, so a
    // mail cannot say `4.5` where the file says `4,5`.
    expect(context.answers[1]?.value).toBe('4,5');
  });

  it('renders a value this application did not write as blank', () => {
    // A hand-edited JSONB column. It must not throw: at send time a `TypeError`
    // is a mail nobody ever gets, over a defect the participant cannot fix.
    const context = contextOf({ [NAME]: { unerwartet: true } });

    expect(context.answers[0]?.value).toBe('');
  });

  it('names the organisation, the form and the date in Berlin time', () => {
    const context = contextOf({});

    expect(context.formularorganisation).toBe('Organisation Alpha');
    expect(context.formular).toBe('Jahrestagung 2026');
    expect(context.datum).toBe('28.07.2026, 10:00 Uhr MESZ');
  });
});

/**
 * `{{aenderungen}}` — **which** answers count as changed.
 *
 * How they are escaped and laid out belongs to `packages/shared` and is proven
 * there. What is proven here is the selection, and every case is written so that
 * removing the rule it names makes it fail: an unchanged answer must be
 * **absent**, not merely „not first", and the two spellings of an empty choice
 * must produce **no row at all**, not a row with two empty sides.
 */
describe('answerChanges (what {{aenderungen}} is built from)', () => {
  it('names only the question that moved, with both its values', () => {
    const context = contextOf(
      { [NAME]: 'Anton Bandinsky', [SEMESTER]: 4 },
      { [NAME]: 'Anton Aktiv', [SEMESTER]: 4 },
    );

    expect(context.changes).toEqual([
      {
        questionId: NAME,
        label: 'Name',
        previous: 'Anton Aktiv',
        current: 'Anton Bandinsky',
      },
    ]);
  });

  it('counts a newly answered and a cleared question as changes', () => {
    const context = contextOf(
      { [NAME]: 'Anton Aktiv', [REMARK]: 'Komme später' },
      { [NAME]: 'Anton Aktiv', [SEMESTER]: 4 },
    );

    expect(context.changes).toEqual([
      { questionId: SEMESTER, label: 'Semester', previous: '4', current: '' },
      {
        questionId: REMARK,
        label: 'Anmerkung',
        previous: '',
        current: 'Komme später',
      },
    ]);
  });

  /**
   * **The doubled form of an empty choice answer** (a known open point).
   *
   * `{"values": [], "other": ""}` is what a fill-in view stores while the
   * „Sonstiges" box is on screen, `{"values": [], "other": null}` what it stores
   * when it is not — and which of the two a document carries depends on nothing
   * the participant did. Read as different values they would announce a change
   * to a question nobody touched: not a missing line, but a line that is not
   * true.
   *
   * **Proves `isBlankAnswer`, not the `other`-collapse** — checked at the
   * 2026-07-29 review: with `values: []` on both sides this stays
   * green with or without `canonicalAnswerValue`, because both sides already
   * count as blank outright. The next case below is the one that actually
   * needs the collapse.
   *
   * Since the requirement no *new* row is written the first way; both sides
   * here are what the column has held, which is exactly why the pair
   * still has to compare equal.
   */
  it('sees no change between other: "" and other: null', () => {
    const context = contextOf(
      { [MEAL]: { values: [], other: '' } },
      { [MEAL]: { values: [], other: null } },
    );

    expect(context.changes).toEqual([]);
  });

  /**
   * The case `isBlankAnswer` cannot cover: an option **is** selected on both
   * sides, so only `canonicalAnswerValue`'s `other`-collapse keeps this out —
   * the same double spelling as above, just no longer shielded by both sides
   * being blank outright.
   *
   * **This is the case the requirement leaves standing.** A change made the
   * *writer* canonical, so two rows written after it never differ this way.
   * The previous side of an edit is not one of them: it is whatever the column
   * has held, and dropping the collapse here would announce
   * „Mit Fleisch → Mit Fleisch" to the participant whose Bearbeiten-Link was
   * just used. Measured end to end in `test/public/canonical-other.spec.ts`.
   */
  it('sees no change when only the spelling of an untouched „Sonstiges" box differs', () => {
    const context = contextOf(
      { [MEAL]: { values: ['fleisch'], other: '' } },
      { [MEAL]: { values: ['fleisch'], other: null } },
    );

    expect(context.changes).toEqual([]);
  });

  /**
   * The other half of „zweimal leer ist keine Änderung": a space bar against no
   * answer at all.
   *
   * This one is `isBlankAnswer`'s own — the doubled choice form above is
   * already caught by both sides *formatting* to the same empty string, so it
   * would stay green without the guard. Here the formatted values differ
   * (`'   '` against `''`) and only the guard keeps the row out.
   */
  it('sees no change between whitespace and no answer at all', () => {
    expect(contextOf({ [NAME]: '' }, { [NAME]: '   ' }).changes).toEqual([]);
  });

  /**
   * **Regression (a) of a 2026-07-29 review.** `true` is not a valid
   * `AnswerValue` — a hand-edited or restored row. Deciding on
   * `formatAnswerCell`'s output would have parsed it to `null` and then read
   * it as blank, same as the empty string on the other side, and this row
   * would never have appeared even though the question really did carry a
   * value before the edit blanked it.
   *
   * **Negative probe:** deciding on the formatted strings instead of the raw
   * values turns this red (verified while writing this fix, not re-run here).
   */
  it('reports a change when an unreadable value clears to blank', () => {
    const context = contextOf({ [NAME]: '' }, { [NAME]: true });

    expect(context.changes).toEqual([
      { questionId: NAME, label: 'Name', previous: '', current: '' },
    ]);
  });

  /**
   * **Regression (b) of a 2026-07-29 review.** `optionsSchema`
   * (`@formsache/shared`) forbids a duplicate option **value**, not a duplicate
   * **label** — two options can read identically and still be different
   * answers. Deciding on `formatAnswerCell`'s output would have rendered both
   * sides as "Fleisch" and reported no change, even though the participant
   * switched from one option to the other.
   *
   * **Negative probe:** deciding on the formatted strings instead of the raw
   * values turns this red (verified while writing this fix, not re-run here).
   */
  it('reports a change between two options with the same label', () => {
    const ambiguous = '019ffb00-0000-7000-8000-000000000005';
    const sameLabelDefinition: FormDefinition = {
      pages: [
        {
          id: '019ffb00-0000-7000-8000-0000000000a1',
          title: 'Anmeldung',
          description: null,
          questions: [
            {
              id: ambiguous,
              type: 'radio',
              label: 'Verpflegung',
              hint: null,
              required: false,
              width: 'full',
              options: [
                { value: 'a', label: 'Fleisch' },
                { value: 'b', label: 'Fleisch' },
              ],
              allowOther: false,
              otherLabel: null,
            },
          ],
        },
      ],
    };

    const context = mailContextOf({
      tenantName: 'Organisation Alpha',
      formTitle: 'Jahrestagung 2026',
      submittedAt: SUBMITTED_AT,
      definition: sameLabelDefinition,
      answers: { [ambiguous]: { values: ['b'], other: null } },
      previousAnswers: { [ambiguous]: { values: ['a'], other: null } },
    });

    expect(context.changes).toEqual([
      {
        questionId: ambiguous,
        label: 'Verpflegung',
        previous: 'Fleisch',
        current: 'Fleisch',
      },
    ]);
  });

  it('formats a choice the way the export does, „Sonstiges" included', () => {
    const context = contextOf(
      { [MEAL]: { values: ['vegetarisch'], other: 'laktosefrei' } },
      { [MEAL]: { values: ['fleisch'], other: null } },
    );

    // Captions, not stored values, and the same `formatAnswerCell` the CSV
    // uses — a change mail is read next to an export.
    expect(context.changes).toEqual([
      {
        questionId: MEAL,
        label: 'Verpflegung',
        previous: 'Mit Fleisch',
        current: 'Vegetarisch, Sonstiges: laktosefrei',
      },
    ]);
  });

  it('reports nothing for a save that changed nothing', () => {
    const answers = { [NAME]: 'Anton Aktiv', [SEMESTER]: 4 };

    expect(contextOf(answers, { ...answers }).changes).toEqual([]);
  });

  /**
   * **a review finding** — measured before
   * the fix: an edit that brings a structured answer to its *canonically
   * empty* form („die Adresse angetippt und wieder geleert") reported a change
   * with two empty values, because this file's own blank check only knew the
   * four shapes it originally had. Both directions, since either alone would be green with
   * the comparison merely made symmetric.
   *
   * **Negative probe:** with this file's former local blank check back in
   * place both cases go red — it reads `{street: '', …}` as „nicht leer".
   */
  it.each([
    [
      'eine leere Adresse',
      ADDRESS,
      { street: '', zip: '', city: '', country: '' },
    ],
    ['eine leere Matrix', MATRIX, { rows: { organisation: [] } }],
    ['eine leere Tabelle', TABLE, { cells: [{}, {}] }],
  ])('reports no change when an edit writes %s', (_name, question, empty) => {
    expect(contextOf({ [question]: empty }, {}).changes).toEqual([]);
    expect(contextOf({}, { [question]: empty }).changes).toEqual([]);
  });

  it('still reports a real change of that same answer', () => {
    // The counter-check to the case above: „leer" must not have grown into
    // „egal". A filled Adresse against nothing is a change, and it is shown
    // folded, the way the export and the responses table show it.
    const filled = {
      street: 'Hauptstraße 1',
      zip: '01067',
      city: 'Dresden',
      country: 'Deutschland',
    };

    expect(contextOf({ [ADDRESS]: filled }, {}).changes).toEqual([
      {
        questionId: ADDRESS,
        label: 'Anschrift',
        previous: '',
        current: 'Hauptstraße 1, 01067 Dresden, Deutschland',
      },
    ]);
  });

  it('reports nothing at all when this is not an edit', () => {
    // `previousAnswers: null` — the submission's answer, and the reason
    // `{{aenderungen}}` renders to empty text there.
    expect(contextOf({ [NAME]: 'Anton Aktiv' }).changes).toEqual([]);
  });

  it('ignores a question the answer’s own version does not have', () => {
    // A question of *today's* draft, added after this answer was given: it is
    // not in the version's definition, so neither side of the comparison may
    // see it. Otherwise every old answer would look „newly filled in" the
    // moment a form grows a field.
    const foreign = '019ffb00-0000-7000-8000-0000000000ff';
    const context = contextOf(
      { [NAME]: 'Anton Aktiv', [foreign]: 'neu' },
      { [NAME]: 'Anton Aktiv' },
    );

    expect(context.changes).toEqual([]);
  });

  it('treats a value this application did not write as blank on either side', () => {
    // A hand-edited JSONB column, on the *old* side. It must not throw: at the
    // enqueue that would take the whole edit down with it.
    const context = contextOf(
      { [NAME]: 'Anton Aktiv' },
      { [NAME]: { unerwartet: true } },
    );

    expect(context.changes).toEqual([
      { questionId: NAME, label: 'Name', previous: '', current: 'Anton Aktiv' },
    ]);
  });
});

describe('renderNotificationBody', () => {
  it('gives an HTML notification a plain-text alternative', () => {
    const body = renderNotificationBody(
      { format: 'html', body: '<p>Hallo {{frage:' + NAME + '}}</p>' },
      contextOf({ [NAME]: 'Anton Aktiv' }),
    );

    expect(body.html).toBe('<p>Hallo Anton Aktiv</p>');
    // The same template rendered as text, not the finished HTML stripped —
    // segment by segment, so a value cannot swallow the text behind it.
    expect(body.text).toBe('Hallo Anton Aktiv');
  });

  it('sends no markup at all in the plain-text format', () => {
    const body = renderNotificationBody(
      { format: 'text', body: '<p>Hallo {{frage:' + NAME + '}}</p>' },
      contextOf({ [NAME]: '<b>Anton</b>' }),
    );

    // `null`, not `undefined`: the value goes into a nullable column now, and
    // „kein HTML-Teil" has to be spelled the way the database spells it.
    expect(body.html).toBeNull();
    expect(body.text).toBe('Hallo Anton');
    expect(body.text).not.toMatch(/<[a-zA-Z]/);
  });

  /**
   * **The body leaves here with the `{{bearbeiten}}` slot still open**
   * . Everything else is frozen; this one is
   * filled by the send step, because whether the link still leads anywhere is a
   * property of the present and not of the submission.
   */
  it('defers the edit link in both halves', () => {
    const body = renderNotificationBody(
      { format: 'html', body: '<p>Ändern: {{bearbeiten}}</p>' },
      contextOf({ [NAME]: 'Anton Aktiv' }),
    );

    expect(body.text).toContain(EDIT_LINK_MARK);
    expect(body.html).toContain(EDIT_LINK_MARK);
    // Not a URL, and not an empty spot either — both would be a decision this
    // step is not allowed to take.
    expect(body.text).not.toContain('/a/');
    expect(body.html).not.toContain('/a/');
  });
});

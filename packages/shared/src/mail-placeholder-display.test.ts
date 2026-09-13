import { describe, expect, it } from 'vitest';

import {
  toDisplayForm,
  toStorageForm,
  unresolvedQuestionCaptions,
} from './mail-placeholder-display.ts';
import { questionPlaceholderToken } from './mail.ts';
import type { Question } from './form-schema.ts';

/**
 * `toDisplayForm` / `toStorageForm` —
 * pure text in, pure text out, no DOM, no editor.
 *
 * The four traps named in the work item get one describe block each. Nothing
 * here asserts against a rendered component: `NotificationEditor.test.tsx`
 * (via `NotificationsView.test.tsx`) covers that the editor actually calls
 * these at the right two moments, not what they compute.
 */

const VORNAME_ID = '019ff900-0000-7000-8000-0000000000a1';
const NACHNAME_ID = '019ff900-0000-7000-8000-0000000000a2';
const AMBIGUOUS_A_ID = '019ff900-0000-7000-8000-0000000000b1';
const AMBIGUOUS_B_ID = '019ff900-0000-7000-8000-0000000000b2';
const BRACE_ID = '019ff900-0000-7000-8000-0000000000c1';

function textQuestion(id: string, label: string): Question {
  return {
    id,
    type: 'text',
    label,
    hint: null,
    required: false,
    width: 'full',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

const QUESTIONS: readonly Question[] = [
  textQuestion(VORNAME_ID, 'Vorname'),
  textQuestion(NACHNAME_ID, 'Nachname'),
  textQuestion(AMBIGUOUS_A_ID, 'Adresse'),
  textQuestion(AMBIGUOUS_B_ID, 'Adresse'),
  textQuestion(BRACE_ID, 'Kommentar {geheim}'),
];

describe('toDisplayForm', () => {
  it('shows the caption for a question with a unique, safe label', () => {
    expect(toDisplayForm(`Hallo {{frage:${VORNAME_ID}}}!`, QUESTIONS)).toBe(
      'Hallo {{frage:Vorname}}!',
    );
  });

  it('leaves system placeholders and plain text untouched', () => {
    const text = 'Liebe/r, {{formularorganisation}} grüßt dich am {{datum}}.';
    expect(toDisplayForm(text, QUESTIONS)).toBe(text);
  });

  it('leaves an id it does not know about in id form', () => {
    const text = `{{frage:${'0'.repeat(8)}-0000-7000-8000-000000000000}}`;
    expect(toDisplayForm(text, QUESTIONS)).toBe(text);
  });

  /** Trap 1: an ambiguous caption does not get the short form at all. */
  it('leaves both questions of a duplicate caption in id form', () => {
    const text = `{{frage:${AMBIGUOUS_A_ID}}} / {{frage:${AMBIGUOUS_B_ID}}}`;
    expect(toDisplayForm(text, QUESTIONS)).toBe(text);
  });

  /** Trap 2: a caption containing `{`/`}` cannot delimit `{{frage:…}}` either. */
  it('leaves a caption containing a brace in id form', () => {
    const text = `{{frage:${BRACE_ID}}}`;
    expect(toDisplayForm(text, QUESTIONS)).toBe(text);
  });

  it('leaves a caption containing a line break in id form', () => {
    const withLineBreak = [
      ...QUESTIONS,
      textQuestion('019ff900-0000-7000-8000-0000000000d1', 'Zwei\nZeilen'),
    ];
    const text = '{{frage:019ff900-0000-7000-8000-0000000000d1}}';
    expect(toDisplayForm(text, withLineBreak)).toBe(text);
  });

  it('converts every occurrence, not just the first', () => {
    const text = `{{frage:${VORNAME_ID}}} und nochmal {{frage:${VORNAME_ID}}}`;
    expect(toDisplayForm(text, QUESTIONS)).toBe(
      '{{frage:Vorname}} und nochmal {{frage:Vorname}}',
    );
  });
});

describe('toStorageForm', () => {
  it('writes the id back for a caption naming exactly one question', () => {
    expect(toStorageForm('Hallo {{frage:Vorname}}!', QUESTIONS)).toBe(
      `Hallo {{frage:${VORNAME_ID}}}!`,
    );
  });

  /** Trap 3: a caption naming no current question stays exactly as written. */
  it('leaves a caption that names no question untouched, verbatim', () => {
    const text = '{{frage:Gibt es nicht (mehr)}}';
    expect(toStorageForm(text, QUESTIONS)).toBe(text);
  });

  /** Trap 1 in the other direction: an ambiguous caption resolves to nothing. */
  it('does not resolve the shared caption of two questions', () => {
    const text = '{{frage:Adresse}}';
    expect(toStorageForm(text, QUESTIONS)).toBe(text);
  });

  it('leaves an id-form token unchanged — it was never a caption', () => {
    const text = `{{frage:${VORNAME_ID}}}`;
    expect(toStorageForm(text, QUESTIONS)).toBe(text);
  });
});

describe('round trip (trap 4)', () => {
  it('recovers the exact original for every resolvable placeholder', () => {
    const original =
      `Hallo {{frage:${VORNAME_ID}}} {{frage:${NACHNAME_ID}}}, ` +
      `dein Organisation ist {{formularorganisation}}. Formular: {{formular}}.`;

    const roundTripped = toStorageForm(
      toDisplayForm(original, QUESTIONS),
      QUESTIONS,
    );

    expect(roundTripped).toBe(original);
  });

  it('round-trips a text with no question placeholder at all', () => {
    const original = 'Danke fürs Ausfüllen, {{bearbeiten}}.';
    expect(toStorageForm(toDisplayForm(original, QUESTIONS), QUESTIONS)).toBe(
      original,
    );
  });

  /**
   * The regression the *reproduction* asks for: without the uniqueness rule,
   * `toDisplayForm` would show `{{frage:Adresse}}` for **both** questions, and
   * `toStorageForm` would then have to guess which id it meant — this is the
   * test that catches a guess. It fails if trap 1 is removed, because a lone
   * `{{frage:Adresse}}` written back would resolve to *some* id instead of
   * staying put as a token nobody can attribute.
   */
  it('never turns an ambiguous caption into a chosen id', () => {
    const displayed = toDisplayForm(`{{frage:${AMBIGUOUS_A_ID}}}`, QUESTIONS);
    expect(displayed).toBe(`{{frage:${AMBIGUOUS_A_ID}}}`);
    expect(toStorageForm(displayed, QUESTIONS)).toBe(
      `{{frage:${AMBIGUOUS_A_ID}}}`,
    );
  });
});

describe('unresolvedQuestionCaptions', () => {
  /**
   * The finding this function exists to close: a realistic German caption
   * with a space is exactly the shape `toStorageForm` leaves untouched
   * (trap 3) and exactly the shape `scanPlaceholders` cannot see either —
   * without this function, nothing in the system ever notices.
   */
  it('reports a caption that names no current question', () => {
    expect(
      unresolvedQuestionCaptions('{{frage:Name des Mitglieds}}', QUESTIONS),
    ).toEqual(['Name des Mitglieds']);
  });

  it('reports each distinct unresolved caption once', () => {
    const text =
      '{{frage:Unbekannt}} und nochmal {{frage:Unbekannt}} und {{frage:Auch nicht}}';
    expect(unresolvedQuestionCaptions(text, QUESTIONS)).toEqual([
      'Unbekannt',
      'Auch nicht',
    ]);
  });

  it('says nothing about a caption that resolves cleanly', () => {
    expect(
      unresolvedQuestionCaptions('Hallo {{frage:Vorname}}!', QUESTIONS),
    ).toEqual([]);
  });

  /**
   * Trap 1, restated for this function: an ambiguous caption is not
   * convertible either, so it *would* be reported here too — that is
   * correct, `toStorageForm` cannot resolve it any more than a caption
   * naming nothing could.
   */
  it('reports a caption shared by two questions as unresolved', () => {
    expect(unresolvedQuestionCaptions('{{frage:Adresse}}', QUESTIONS)).toEqual([
      'Adresse',
    ]);
  });

  /**
   * The other gap this function must not fall into: an id-form token,
   * whether it names a live question or one since deleted, is not a
   * caption at all — that case belongs to the publish lock (C1a), not here.
   */
  it('does not report an id-form token, known or dangling', () => {
    const known = `{{frage:${VORNAME_ID}}}`;
    const dangling = `{{frage:${'0'.repeat(8)}-0000-7000-8000-000000000000}}`;
    expect(unresolvedQuestionCaptions(known, QUESTIONS)).toEqual([]);
    expect(unresolvedQuestionCaptions(dangling, QUESTIONS)).toEqual([]);
  });

  it('leaves plain text and system placeholders alone', () => {
    expect(
      unresolvedQuestionCaptions(
        'Liebe/r, {{formularorganisation}} grüßt dich.',
        QUESTIONS,
      ),
    ).toEqual([]);
  });
});

describe('agreement with questionPlaceholderToken', () => {
  it('produces the same id token `mail.ts` would insert', () => {
    expect(toStorageForm('{{frage:Vorname}}', QUESTIONS)).toBe(
      questionPlaceholderToken(VORNAME_ID),
    );
  });
});

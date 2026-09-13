import { questionSchema, questionTypeSchema } from '@formsache/shared';
import { describe, expect, it } from 'vitest';

import {
  QUESTION_TYPES,
  createQuestion,
  parseOptionBulkImport,
} from './question-defaults';

const ID = '019fe300-0000-7000-8000-000000000001';

describe('QUESTION_TYPES', () => {
  /**
   * The palette offers **every** type the schema knows.
   *
   * The compiler already refuses an incomplete list (`PaletteIsComplete` in
   * `question-defaults.ts`), and that is the guarantee that holds. This test
   * states the same thing as behaviour, because `pnpm typecheck` is a gate one
   * can be tempted to satisfy by deleting the assertion — and what would be
   * lost then is not a type error but a question type an editor can never
   * insert, in a builder that looks perfectly normal.
   */
  it('offers every question type the schema knows', () => {
    expect([...QUESTION_TYPES].sort()).toStrictEqual(
      [...questionTypeSchema.options].sort(),
    );
  });
});

describe('createQuestion', () => {
  /**
   * The assertion that matters: a freshly added question of **any** of the
   * nine types is already a valid document. A dropdown born without options
   * would look fine in the builder and be refused by the very first save,
   * with an error pointing at a field the editor never touched.
   */
  it.each(QUESTION_TYPES)('produces a valid %s question', (type) => {
    const result = questionSchema.safeParse(createQuestion(type, ID));

    expect(result.success).toBe(true);
  });

  it('starts every card at full width — half is something one docks into', () => {
    for (const type of QUESTION_TYPES) {
      expect(createQuestion(type, ID).width).toBe('full');
    }
  });

  it('gives choice questions a non-empty option list', () => {
    for (const type of ['select', 'radio', 'checkbox'] as const) {
      const question = createQuestion(type, ID);
      expect('options' in question && question.options.length).toBeGreaterThan(
        0,
      );
    }
  });
});

describe('parseOptionBulkImport', () => {
  it('takes one option per line and ignores blank lines', () => {
    expect(parseOptionBulkImport('Aktiv\n\n  Inaktiv  \n')).toStrictEqual([
      { value: 'aktiv', label: 'Aktiv' },
      { value: 'inaktiv', label: 'Inaktiv' },
    ]);
  });

  /**
   * The reason `wert = Beschriftung` exists: answers refer to *values*. An
   * admin who re-imports a list after renaming its captions must be able to
   * keep the values fifty stored answers already point at.
   */
  it('honours an explicit value so existing answers keep their meaning', () => {
    expect(parseOptionBulkImport('ja = Ja, ich komme')).toStrictEqual([
      { value: 'ja', label: 'Ja, ich komme' },
    ]);
  });

  it('transliterates umlauts rather than dropping them', () => {
    expect(parseOptionBulkImport('Grüße\nWeiß')).toStrictEqual([
      { value: 'gruesse', label: 'Grüße' },
      { value: 'weiss', label: 'Weiß' },
    ]);
  });

  it('keeps generated values unique when two labels collapse to one slug', () => {
    const options = parseOptionBulkImport('Ja!\nJa?');

    expect(options.map((option) => option.value)).toStrictEqual(['ja', 'ja-2']);
  });

  /**
   * A pasted spreadsheet column routinely repeats a line. Dropping the
   * duplicate is friendlier than refusing the whole paste — and the schema
   * still refuses duplicate values, so nothing invalid can get through here.
   */
  it('drops a repeated line instead of refusing the whole import', () => {
    expect(parseOptionBulkImport('a = Eins\na = Eins nochmal')).toStrictEqual([
      { value: 'a', label: 'Eins' },
    ]);
  });

  it('produces a usable value for a label with no letters at all', () => {
    expect(parseOptionBulkImport('!!!')).toStrictEqual([
      { value: 'option', label: '!!!' },
    ]);
  });

  it('answers with an empty list for empty input, so nothing replaces the options', () => {
    expect(parseOptionBulkImport('   \n\n')).toStrictEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { COLUMN_LABEL_SEPARATOR } from './answer-columns.ts';
import {
  SUBMITTED_AT_COLUMN,
  SUBMITTED_AT_LABEL,
  buildCsv,
  chooseColumns,
} from './csv.ts';
import { parseFormDefinition, type FormDefinition } from './form-schema.ts';
import {
  NO_ANSWERS,
  RETIRED_COLUMN_NOTE,
  csvColumns,
  hasUnpublishedChanges,
  publishDiff,
  questionHistory,
  responseColumnGroups,
  responseColumns,
  sameDefinition,
} from './form-history.ts';
import type { FormVersionSnapshot } from './forms.ts';
import type { AnswerMap } from './response-validation.ts';

/**
 * The two promises of this module:
 *
 * - the responses view shows **everything that was ever asked**, and a removed
 *   question stays exportable rather than quietly dropping out of the file;
 * - publishing again with answers on file says *what* it changes.
 *
 * Written the way `CONTRIBUTING.md` asks of a rule that matters: the union is
 * asserted through the case that used to fail — a question that is no longer in
 * the newest version — and the export is built end to end, so a column that is
 * merely *listed* but formats to an empty cell would not pass.
 *
 * `NO_ANSWERS` is imported rather than declared here (it is the same empty set
 * `responseColumns` passes down): most of what this file measures is a statement
 * about the **document** — which questions were ever published, in which order,
 * under which label — and for the types those cases use the answer set changes
 * nothing. The one place it does is `die wachsende Tabelle` at the end, and that
 * describe exists because the rest of the file cannot see the difference.
 */

const PAGE_A = '019ff100-0000-7000-8000-0000000000a0';
const PAGE_B = '019ff100-0000-7000-8000-0000000000b0';
const NAME = '019ff100-0000-7000-8000-000000000001';
const SEMESTER = '019ff100-0000-7000-8000-000000000002';
const PHONE = '019ff100-0000-7000-8000-000000000003';
const DIET = '019ff100-0000-7000-8000-000000000004';
const GUESTS = '019ff100-0000-7000-8000-000000000005';

const base = { hint: null, required: false, width: 'full' } as const;

function text(id: string, label: string): Record<string, unknown> {
  return {
    ...base,
    id,
    label,
    type: 'text',
    minLength: null,
    maxLength: null,
    pattern: null,
  };
}

function phone(id: string, label: string): Record<string, unknown> {
  return { ...base, id, label, type: 'phone' };
}

function number(id: string, label: string): Record<string, unknown> {
  return {
    ...base,
    id,
    label,
    type: 'number',
    min: null,
    max: null,
    integer: true,
  };
}

function select(
  id: string,
  label: string,
  options: readonly string[],
): Record<string, unknown> {
  return {
    ...base,
    id,
    label,
    type: 'select',
    options: options.map((value) => ({ value, label: value })),
    allowOther: false,
    otherLabel: null,
  };
}

/**
 * A table over one Zelltyp, offering `rows` rows.
 *
 * The one type whose column count is not a function of the document alone —
 * everything else in this file has a plan the form decides.
 */
function table(
  id: string,
  label: string,
  rows: number,
): Record<string, unknown> {
  return {
    ...base,
    id,
    label,
    type: 'table',
    columns: [{ key: 'name', label: 'Name', type: 'text' }],
    rows,
  };
}

/** Parsed, never cast — a fixture the schema rejects would prove nothing. */
function definition(
  questions: readonly Record<string, unknown>[],
  pageId = PAGE_A,
): FormDefinition {
  return parseFormDefinition({
    pages: [{ id: pageId, title: 'Seite 1', questions }],
  });
}

function snapshot(
  version: number,
  questions: readonly Record<string, unknown>[],
): FormVersionSnapshot {
  return { version, definition: definition(questions) };
}

/** The column keys, so an expectation reads as the table's header row. */
function keysOf(snapshots: readonly FormVersionSnapshot[]): string[] {
  return responseColumns(snapshots).map((column) => column.key);
}

describe('questionHistory (Nr. 22)', () => {
  it('keeps a question that a later version removed', () => {
    const history = questionHistory(
      [
        snapshot(1, [text(NAME, 'Name'), text(SEMESTER, 'Semester')]),
        snapshot(2, [text(NAME, 'Name')]),
      ],
      NO_ANSWERS,
    );

    expect(history.map((entry) => entry.question.id)).toEqual([NAME, SEMESTER]);
    expect(history.map((entry) => entry.retired)).toEqual([false, true]);
    // The retired one still names the version it was last asked in, which is
    // what tells a reader why the newer rows are empty there.
    expect(history[1]?.firstVersion).toBe(1);
    expect(history[1]?.lastVersion).toBe(1);
  });

  it('reads the draft nowhere — only what was published gets a column', () => {
    // The whole defect of no. 22 in one assertion: the union is a function of
    // the published snapshots alone, so there is no argument through which an
    // unsaved draft could reach it.
    expect(keysOf([])).toEqual([SUBMITTED_AT_COLUMN]);
    expect(keysOf([snapshot(1, [text(NAME, 'Name')])])).toEqual([
      NAME,
      SUBMITTED_AT_COLUMN,
    ]);
  });

  it('merges by id and takes the label of the newest version that has it', () => {
    const history = questionHistory(
      [
        snapshot(1, [text(NAME, 'Name')]),
        snapshot(2, [text(NAME, 'Vor- und Zuname')]),
      ],
      NO_ANSWERS,
    );

    // One column, not two: a rename must not open a second column beside the
    // answers that were already given.
    expect(history).toHaveLength(1);
    expect(history[0]?.question.label).toBe('Vor- und Zuname');
  });

  it('takes a retired question in the state it was retired in', () => {
    const history = questionHistory(
      [
        snapshot(1, [text(NAME, 'Name'), text(SEMESTER, 'Semester')]),
        snapshot(2, [text(NAME, 'Name'), text(SEMESTER, 'Fachsemester')]),
        snapshot(3, [text(NAME, 'Name')]),
      ],
      NO_ANSWERS,
    );

    expect(history[1]?.question.label).toBe('Fachsemester');
    expect(history[1]?.lastVersion).toBe(2);
  });

  it('orders the active columns by the newest version, not by first appearance', () => {
    const reordered = [
      snapshot(1, [text(NAME, 'Name'), text(SEMESTER, 'Semester')]),
      snapshot(2, [text(SEMESTER, 'Semester'), text(NAME, 'Name')]),
    ];

    expect(keysOf(reordered)).toEqual([SEMESTER, NAME, SUBMITTED_AT_COLUMN]);
  });

  /**
   * The order as the client decided it, **including the price**.
   *
   * A newly retired question joins the retired ones as their last, and the
   * retired keep their order relative to one another. What it is *not* is
   * append-only: leaving the active block pulls every earlier-retired column
   * one place towards the front. The test says both, because the first
   * sentence alone reads like a stability promise the rule does not make.
   */
  it('retires a column as the last of the retired ones, and keeps their order', () => {
    const versions = [
      snapshot(1, [
        text(NAME, 'Name'),
        text(SEMESTER, 'Semester'),
        phone(PHONE, 'Telefon'),
        text(DIET, 'Essenswunsch'),
      ]),
      // Semester goes first…
      snapshot(2, [
        text(NAME, 'Name'),
        phone(PHONE, 'Telefon'),
        text(DIET, 'Essenswunsch'),
      ]),
      // …then the phone question.
      snapshot(3, [text(NAME, 'Name'), text(DIET, 'Essenswunsch')]),
    ];

    const before = keysOf(versions.slice(0, 2));
    const after = keysOf(versions);

    expect(before).toEqual([NAME, PHONE, DIET, SEMESTER, SUBMITTED_AT_COLUMN]);
    // The newly retired column joins as the **last** of the retired ones,
    // behind the one retired before it — not merely somewhere at the back.
    expect(after).toEqual([NAME, DIET, SEMESTER, PHONE, SUBMITTED_AT_COLUMN]);
    expect(after.at(-2)).toBe(PHONE);

    // The retired columns keep their order relative to one another — read off
    // the `retired` flag rather than off a hand-kept list of ids, so the
    // assertion cannot quietly include a column that is still active.
    const retired = (snapshots: readonly FormVersionSnapshot[]): string[] =>
      responseColumns(snapshots)
        .filter((column) => column.retired)
        .map((column) => column.key);
    expect(retired(versions.slice(0, 2))).toEqual([SEMESTER]);
    expect(retired(versions)).toEqual([SEMESTER, PHONE]);

    // …and here is the price of "active first", asserted rather than left to
    // be discovered: the active block shrank by one, so everything behind it
    // moved forward. `Essenswunsch` and `Semester` each lost a place without
    // anybody touching them.
    expect(before.indexOf(DIET)).toBe(2);
    expect(after.indexOf(DIET)).toBe(1);
    expect(before.indexOf(SEMESTER)).toBe(3);
    expect(after.indexOf(SEMESTER)).toBe(2);
  });

  it('is independent of the order the snapshots arrive in', () => {
    const ascending = [
      snapshot(1, [text(NAME, 'Name'), text(SEMESTER, 'Semester')]),
      snapshot(2, [text(NAME, 'Vor- und Zuname')]),
    ];
    const descending = [...ascending].reverse();

    expect(keysOf(descending)).toEqual(keysOf(ascending));
    expect(questionHistory(descending, NO_ANSWERS)[0]?.question.label).toBe(
      'Vor- und Zuname',
    );
  });

  it('reports an id whose type changed instead of choking on it', () => {
    // An older document: the builder now gives a changed type a new
    // id, but a stored history may well hold this shape and must not crash.
    const history = questionHistory(
      [
        snapshot(1, [phone(SEMESTER, 'Semester')]),
        snapshot(2, [number(SEMESTER, 'Semester')]),
      ],
      NO_ANSWERS,
    );

    expect(history).toHaveLength(1);
    expect(history[0]?.typeChanged).toBe(true);
    // The newest version decides what the column *is* — the whole question is
    // taken from one snapshot, never assembled from two.
    expect(history[0]?.question.type).toBe('number');
  });

  it('finds questions on every page, in page order', () => {
    const twoPages: FormVersionSnapshot = {
      version: 1,
      definition: parseFormDefinition({
        pages: [
          { id: PAGE_A, title: 'Eins', questions: [text(NAME, 'Name')] },
          {
            id: PAGE_B,
            title: 'Zwei',
            questions: [text(SEMESTER, 'Semester')],
          },
        ],
      }),
    };

    expect(keysOf([twoPages])).toEqual([NAME, SEMESTER, SUBMITTED_AT_COLUMN]);
  });
});

/**
 * `responseColumns` is what actually travels to the client, so `retired` is
 * asserted **on it** and not only on `questionHistory` behind it. Pinning the
 * field to `false` in the mapping used to leave every shared test green.
 */
describe('responseColumns (Nr. 22)', () => {
  const versions = [
    snapshot(1, [text(NAME, 'Name'), phone(PHONE, 'Telefon')]),
    snapshot(2, [text(NAME, 'Name')]),
  ];

  it('marks the removed question as retired and the surviving one as active', () => {
    expect(
      responseColumns(versions).map((column) => [column.key, column.retired]),
    ).toEqual([
      [NAME, false],
      [PHONE, true],
      [SUBMITTED_AT_COLUMN, false],
    ]);
  });

  it('carries the plain question text as the label — no marker in the data', () => {
    // The wire contract carries the fact (`retired`), never the wording. A
    // table that wants a muted marker builds it from the flag; a label with
    // „(nicht mehr gefragt)" baked in would force every surface to show the
    // file's phrasing or to strip it back off.
    expect(responseColumns(versions).map((column) => column.label)).toEqual([
      'Name',
      'Telefon',
      SUBMITTED_AT_LABEL,
    ]);
  });

  it('offers nothing but the timestamp for a form that was never published', () => {
    expect(responseColumns([])).toEqual([
      { key: SUBMITTED_AT_COLUMN, label: SUBMITTED_AT_LABEL, retired: false },
    ]);
  });

  /**
   * **A table is one tick in the field menu, asked without a single answer**
   * — the paragraph „This list is answer-independent" in `form-history.ts`, from
   * the side that could break it.
   *
   * What carries that paragraph is not the type switch but
   * `tableQuestionSchema`: `rows` is `min(1)` and `columns` is `min(1)`, so a
   * table's plan is never empty, and `tableRowCount` only ever *raises* the
   * count above it. The `columns.length > 0` filter in `responseColumnGroups`
   * therefore cannot drop the question for want of answers.
   *
   * **The decision behind Startzeilen holds, and `rows ≥ 1` stays** (2026-08-06):
   * „beliebig viele Begleitpersonen" is `rows: 1` plus `addRows`, not `rows: 0`.
   * With no start row a table asked *without* answers would plan no column at
   * all: the question would vanish from the field menu and from the responses
   * table while the export — which does hold the answers — writes columns for
   * it, and the two surfaces would disagree about what the form asked. The
   * reasoning is at `tableQuestionSchema`, and the bound itself is guarded by
   * `form-schema.test.ts` („refuses a Tabelle without a start row").
   *
   * ⚠️ **This test alone would not have noticed** — it builds a table with
   * two start rows, so `min(0)` in the schema leaves it green until a fixture
   * says `rows: 0` (measured again on 2026-08-06). It shows the *consequence*;
   * the schema test guards the *bound*.
   *
   * *Reproduction run on 2026-08-06:* `rows` in `tableQuestionSchema` loosened
   * to `min(0)` and the table built with `rows: 0` → red, the question
   * is missing from the list (`- "019ff100-…005"`). Both changes have been
   * taken back; the line stands here so that nobody has to derive it a second
   * time.
   */
  it('lists a Tabelle, which is asked without any answer in hand', () => {
    expect(
      responseColumns([snapshot(1, [table(GUESTS, 'Begleitpersonen', 2)])]).map(
        (column) => column.key,
      ),
    ).toEqual([GUESTS, SUBMITTED_AT_COLUMN]);
  });
});

describe('csvColumns (Nr. 22, the file half)', () => {
  const versions = [
    snapshot(1, [text(NAME, 'Name'), phone(PHONE, 'Telefon')]),
    snapshot(2, [text(NAME, 'Name')]),
  ];

  /**
   * The header is the only place a file can say it. Someone opens the CSV who
   * has never seen the form, and „leer" has to be distinguishable from
   * „danach nicht mehr gefragt" — two different statements.
   */
  it('names a retired column in the header and leaves the others untouched', () => {
    expect(
      csvColumns(responseColumnGroups(versions, NO_ANSWERS)).map(
        (c) => c.label,
      ),
    ).toEqual(['Name', `Telefon (${RETIRED_COLUMN_NOTE})`, SUBMITTED_AT_LABEL]);
  });

  /**
   * The note goes into the label and **nowhere else**: same keys, same count,
   * same order as the plan the groups carry, so no value can end up under
   * another column's header.
   *
   * Compared against the expanded plan (`group.columns`) rather than against
   * `groups.map(key)`. The latter holds only while one question is one column,
   * which is exactly the assumption that no longer holds — an Adresse writes four
   * columns and a Matrix one per row, and the assertion would then be measuring
   * nothing but its own outdated premise.
   */
  it('keeps the keys of the plan, so the note cannot move a value', () => {
    const groups = responseColumnGroups(versions, NO_ANSWERS);
    const plan = groups.flatMap((group) => group.columns);

    expect(csvColumns(groups).map((column) => column.key)).toEqual(
      plan.map((column) => column.key),
    );
    // And the labels differ from the plan's only where the plan says „retired" —
    // read off the flag, not off a hand-kept list of ids.
    expect(
      csvColumns(groups).map((column, index) => [
        column.label === plan[index]?.label,
        plan[index]?.retired,
      ]),
    ).toEqual(plan.map((column) => [!column.retired, column.retired]));
  });

  it('writes the note into the file itself', () => {
    const csv = buildCsv(
      csvColumns(responseColumnGroups(versions, NO_ANSWERS)),
      [],
    );

    expect(csv).toContain(`Telefon (${RETIRED_COLUMN_NOTE})`);
  });
});

/**
 * **The wachsende Tabelle in the union.**
 *
 * Everything above measures the document, and for the types those cases use the
 * answer set changes nothing. A Tabelle is the one type where it does — and the
 * union is where that difference turns into a *word in the file*.
 *
 * The mechanism, because it is not obvious: `questionHistory` accumulates every
 * column an id ever produced, and it walks the answer set while doing so, so the
 * blocks of rows a participant added are **in** that map. `columnsOf` then asks
 * the newest published shape which of them are still live and marks the rest
 * „nicht mehr gefragt". Asking that shape *without* the answers makes the two
 * walks disagree: the form offers two rows, the map holds four, and rows three
 * and four come out of the file as retired columns — with values under them.
 *
 * *Reproduction run on 2026-08-06:* in `columnsOf` `questionColumns(entry.question, [])`
 * instead of `answers` → both cases red; the second with
 * `Begleitpersonen — Name (Zeile 3) (nicht mehr gefragt)` in the header line.
 */
describe('die wachsende Tabelle in der Union ', () => {
  /** The form offers two rows; the participant filled in four. */
  const versions = [snapshot(1, [table(GUESTS, 'Begleitpersonen', 2)])];
  const answers: AnswerMap[] = [
    {
      [GUESTS]: {
        cells: [
          { name: 'Anna' },
          { name: 'Bert' },
          { name: 'Cäsar' },
          { name: 'Dora' },
        ],
      },
    },
  ];

  function labelOf(row: number): string {
    return `Begleitpersonen${COLUMN_LABEL_SEPARATOR}Name (Zeile ${String(row)})`;
  }

  it('calls no column of a row the answer created retired', () => {
    const [entry] = questionHistory(versions, answers);

    expect(
      entry?.columns.map((column) => [column.label, column.retired]),
    ).toStrictEqual([
      [labelOf(1), false],
      [labelOf(2), false],
      [labelOf(3), false],
      [labelOf(4), false],
    ]);
  });

  /**
   * The same statement where it is read: the header of the file. `retired` is a
   * flag a reader of this module can weigh; „(nicht mehr gefragt)" is what a
   * Mitglied sees in Excel over a column that is very much alive.
   */
  it('writes the four headers without the note', () => {
    expect(
      csvColumns(responseColumnGroups(versions, answers)).map(
        (column) => column.label,
      ),
    ).toStrictEqual([
      labelOf(1),
      labelOf(2),
      labelOf(3),
      labelOf(4),
      SUBMITTED_AT_LABEL,
    ]);
  });
});

describe('chooseColumns over the union', () => {
  const versions = [
    snapshot(1, [
      text(NAME, 'Name'),
      phone(PHONE, 'Telefon'),
      text(SEMESTER, 'Semester'),
      text(DIET, 'Essenswunsch'),
    ]),
  ];

  it('falls back to the default view for an empty selection', () => {
    // The client that switched every column off. A file with a header of
    // nothing is not what "follow the visible view" means.
    expect(
      chooseColumns(responseColumns(versions), [], 'table').map((c) => c.key),
    ).toEqual([NAME, PHONE, SEMESTER, SUBMITTED_AT_COLUMN]);
  });

  it('falls back to the default view when nothing requested exists any more', () => {
    expect(
      chooseColumns(responseColumns(versions), ['nicht-existent'], 'table').map(
        (c) => c.key,
      ),
    ).toEqual([NAME, PHONE, SEMESTER, SUBMITTED_AT_COLUMN]);
  });

  it('drops only the unknown keys when something is left', () => {
    expect(
      chooseColumns(
        responseColumns(versions),
        [DIET, 'nicht-existent'],
        'table',
      ).map((c) => c.key),
    ).toEqual([DIET]);
  });

  it('keeps `retired` on the way through, so the header note survives', () => {
    const chosen = chooseColumns(
      responseColumnGroups(
        [
          snapshot(1, [text(NAME, 'Name'), phone(PHONE, 'Telefon')]),
          snapshot(2, [text(NAME, 'Name')]),
        ],
        NO_ANSWERS,
      ),
      [PHONE],
      'table',
    );

    expect(chosen[0]?.retired).toBe(true);
    expect(csvColumns(chosen)[0]?.label).toBe(
      `Telefon (${RETIRED_COLUMN_NOTE})`,
    );
  });
});

/**
 * „Die ersten drei Fragen" of the handoff, now that the list is the union
 * of every published version rather than one document.
 *
 * A form with fewer than three questions in force therefore fills the remaining
 * slots with retired ones. That is a real change of meaning and it was weighed:
 * skipping them reads better on screen, but a retired column that is not
 * *eligible* is one the field menu cannot offer back, and the answers to a
 * removed question would drop out of what the reader sees — the very defect
 * the requirement exists to end, and what the spec forbids in as many words („bleibt als
 * Spalte sichtbar … und bleibt exportierbar").
 *
 * ⚠️ The two surfaces differ in **how many** questions the
 * untouched view takes (three against all) — and in nothing else.
 * Whether a retired question is eligible at all is still one answer for both,
 * decided in `pickDefaultColumns`; splitting *that* would be the drift the
 * function was shared against, and the case below measures the export end of it.
 *
 * Written down as a test rather than left to the comment, because it is the
 * kind of decision the next reader will otherwise assume was an oversight.
 */
describe('the default view over the union (Nr. 22)', () => {
  /** One question today, one retired behind it — the shape of the API fixture. */
  const shrunk = [
    snapshot(1, [text(NAME, 'Name'), phone(PHONE, 'Telefon')]),
    snapshot(2, [text(NAME, 'Name')]),
  ];

  it('keeps a retired column in the untouched view, marked rather than hidden', () => {
    expect(
      chooseColumns(responseColumns(shrunk), undefined, 'table').map(
        (c) => c.key,
      ),
    ).toEqual([NAME, PHONE, SUBMITTED_AT_COLUMN]);
  });

  /**
   * The consequence that decided it: this is the file an editor exports without
   * touching a single control. Dropping the column here is the silent data loss
   * of no. 22, one layer down.
   */
  it('therefore keeps the removed question’s answers in an untouched export', () => {
    const csv = buildCsv(
      csvColumns(
        chooseColumns(
          responseColumnGroups(shrunk, NO_ANSWERS),
          undefined,
          'export',
        ),
      ),
      [],
    );

    expect(csv).toContain(`Telefon (${RETIRED_COLUMN_NOTE})`);
  });

  it('still lets an explicit selection leave it out', () => {
    expect(
      chooseColumns(responseColumns(shrunk), [NAME], 'table').map((c) => c.key),
    ).toEqual([NAME]);
  });

  /** Active questions come first, so three of them crowd a retired one out. */
  it('does not reach a retired column while active ones fill the slots', () => {
    const roomy = [
      snapshot(1, [
        text(NAME, 'Name'),
        number(SEMESTER, 'Semester'),
        text(DIET, 'Essenswunsch'),
        phone(PHONE, 'Telefon'),
      ]),
      snapshot(2, [
        text(NAME, 'Name'),
        number(SEMESTER, 'Semester'),
        text(DIET, 'Essenswunsch'),
      ]),
    ];

    expect(
      chooseColumns(responseColumns(roomy), undefined, 'table').map(
        (c) => c.key,
      ),
    ).toEqual([NAME, SEMESTER, DIET, SUBMITTED_AT_COLUMN]);
  });
});

describe('the export of a retired column (Nr. 22)', () => {
  const versions = [
    snapshot(1, [text(NAME, 'Name'), phone(PHONE, 'Telefon')]),
    snapshot(2, [text(NAME, 'Name')]),
  ];

  /**
   * One answer from before the question was removed.
   *
   * The number is written so that **only the question's type** can decide it:
   * `06421 123456` is neither a formula nor a digit string a spreadsheet would
   * re-read as a number, so nothing about the *value* would guard it. It ends
   * up as text because the question was a `phone` question — and after the
   * removal, the row's own snapshot is the only thing that still knows that.
   */
  const oldRow = {
    submittedAt: '2026-05-01T10:00:00.000Z',
    answers: { [NAME]: 'Anton', [PHONE]: '06421 123456' },
    definition: versions[0]?.definition ?? definition([]),
  };
  /** …and one from after. */
  const newRow = {
    submittedAt: '2026-06-01T10:00:00.000Z',
    answers: { [NAME]: 'Berthold' },
    definition: versions[1]?.definition ?? definition([]),
  };

  it('carries the old answer into the file, and leaves newer rows empty', () => {
    const csv = buildCsv(responseColumns(versions), [oldRow, newRow]);
    const [header, first, second] = csv.split('\r\n');

    expect(header).toContain('Telefon');
    // The regression this whole package exists for: before, the column came
    // from the current document, so this value was in the database and in no
    // file anybody could produce.
    expect(first).toContain("'06421 123456");
    expect(second).toContain('Berthold');
    // The participant of version 2 was never asked — an empty cell, not a gap
    // in the row.
    expect(second?.split(';')).toHaveLength(header?.split(';').length ?? 0);
  });

  it('gives the retired column the guard of its own type', () => {
    // Nothing about `06421 123456` asks to be guarded — it is guarded because
    // the question is a `phone` question, and after the removal the row's own
    // snapshot is the only place that still says so. Reading the type off the
    // column instead would drop the guard on every retired column.
    const csv = buildCsv(responseColumns(versions), [oldRow]);

    expect(csv).toContain("'06421 123456");
  });

  it('exports a retired column when the client asks for it by key', () => {
    const chosen = chooseColumns(responseColumns(versions), [PHONE], 'export');

    expect(chosen.map((column) => column.key)).toEqual([PHONE]);
    expect(buildCsv(chosen, [oldRow])).toContain("'06421 123456");
  });

  it('formats each row against its own version, not against the column', () => {
    // The same id published as a phone question and later as a number one — an
    // older document, which the builder now avoids by giving a changed type a new id.
    // The old row keeps the text guard of the version it was answered under,
    // although the column reports the newer type. Taking the guard from the
    // column would leave this value unguarded, which is how the two readings
    // are told apart.
    const changed = [
      snapshot(1, [phone(PHONE, 'Kontakt')]),
      snapshot(2, [number(PHONE, 'Kontakt')]),
    ];
    const csv = buildCsv(responseColumns(changed), [
      {
        submittedAt: '2026-05-01T10:00:00.000Z',
        answers: { [PHONE]: '06421 123456' },
        definition: changed[0]?.definition ?? definition([]),
      },
    ]);

    expect(csv).toContain("'06421 123456");
  });
});

describe('publishDiff (Nr. 23)', () => {
  it('names what is removed, added and changed in type', () => {
    const published = definition([
      text(NAME, 'Name'),
      text(SEMESTER, 'Semester'),
      phone(PHONE, 'Telefon'),
    ]);
    const draft = definition([
      text(NAME, 'Name'),
      number(PHONE, 'Telefon'),
      text(DIET, 'Essenswunsch'),
    ]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [{ id: SEMESTER, label: 'Semester', type: 'text' }],
      added: [{ id: DIET, label: 'Essenswunsch', type: 'text' }],
      typeChanged: [
        { id: PHONE, label: 'Telefon', from: 'phone', to: 'number' },
      ],
    });
  });

  it('says nothing when only a label changed', () => {
    const published = definition([text(NAME, 'Name')]);
    const draft = definition([text(NAME, 'Vor- und Zuname')]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [],
      added: [],
      typeChanged: [],
    });
  });

  it('says nothing when the questions were only reordered', () => {
    const published = definition([
      text(NAME, 'Name'),
      text(SEMESTER, 'Semester'),
    ]);
    const draft = definition([text(SEMESTER, 'Semester'), text(NAME, 'Name')]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [],
      added: [],
      typeChanged: [],
    });
  });

  it('reads a first publish as all additions', () => {
    const draft = definition([text(NAME, 'Name')]);

    expect(publishDiff(null, draft)).toEqual({
      removed: [],
      added: [{ id: NAME, label: 'Name', type: 'text' }],
      typeChanged: [],
    });
  });

  /**
   * The pages are not the unit of comparison — the question id is. A question
   * removed from the *second* page has to be found just as a question on the
   * first, which every other fixture here leaves untested.
   */
  it('sees a question removed from another page', () => {
    const published = parseFormDefinition({
      pages: [
        { id: PAGE_A, title: 'Eins', questions: [text(NAME, 'Name')] },
        {
          id: PAGE_B,
          title: 'Zwei',
          questions: [text(SEMESTER, 'Semester'), phone(PHONE, 'Telefon')],
        },
      ],
    });
    const draft = parseFormDefinition({
      pages: [
        { id: PAGE_A, title: 'Eins', questions: [text(NAME, 'Name')] },
        {
          id: PAGE_B,
          title: 'Zwei',
          questions: [phone(PHONE, 'Telefon'), text(DIET, 'Essenswunsch')],
        },
      ],
    });

    expect(publishDiff(published, draft)).toEqual({
      removed: [{ id: SEMESTER, label: 'Semester', type: 'text' }],
      added: [{ id: DIET, label: 'Essenswunsch', type: 'text' }],
      typeChanged: [],
    });
  });

  /**
   * Moving a question to another page changes nothing a stored answer can be
   * hurt by: answers are keyed by question id, and ids are unique across the
   * whole document, not per page.
   */
  it('says nothing when a question only moved to another page', () => {
    const published = parseFormDefinition({
      pages: [
        {
          id: PAGE_A,
          title: 'Eins',
          questions: [text(NAME, 'Name'), text(SEMESTER, 'Semester')],
        },
        { id: PAGE_B, title: 'Zwei', questions: [phone(PHONE, 'Telefon')] },
      ],
    });
    const draft = parseFormDefinition({
      pages: [
        { id: PAGE_A, title: 'Eins', questions: [text(NAME, 'Name')] },
        {
          id: PAGE_B,
          title: 'Zwei',
          questions: [text(SEMESTER, 'Semester'), phone(PHONE, 'Telefon')],
        },
      ],
    });

    expect(publishDiff(published, draft)).toEqual({
      removed: [],
      added: [],
      typeChanged: [],
    });
  });

  it('lists removals in the order of the published form', () => {
    const published = definition([
      text(NAME, 'Name'),
      text(SEMESTER, 'Semester'),
      phone(PHONE, 'Telefon'),
    ]);
    const draft = definition([text(DIET, 'Essenswunsch')]);

    expect(
      publishDiff(published, draft).removed.map((entry) => entry.id),
    ).toEqual([NAME, SEMESTER, PHONE]);
  });
});

/**
 * The type change that wears two ids.
 *
 * The builder mints a new id when a question's type changes, so without a reference
 * back the diff reports a removal and an unrelated addition: the same question
 * text twice, nothing saying it is one change, and the notice's own „ändert den
 * Typ" branch never reached. The reference repairs that — but only where it is
 * corroborated, and the four tests that follow the first one are each a case
 * where it is not.
 */
describe('publishDiff with a replaced predecessor (Nr. 26)', () => {
  it('reads reference plus vanished predecessor as one type change', () => {
    const published = definition([text(NAME, 'Name'), text(PHONE, 'Telefon')]);
    const draft = definition([
      text(NAME, 'Name'),
      { ...number(DIET, 'Telefon'), replaces: PHONE },
    ]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [],
      added: [],
      typeChanged: [
        // The **successor's** id and label: the sentence the editor reads is
        // about the question as it will be after publishing.
        { id: DIET, label: 'Telefon', from: 'text', to: 'number' },
      ],
    });
  });

  /**
   * The ordinary case while building: a question is added and retyped before
   * the form is published again. The predecessor never reached anyone, so there
   * is nothing to warn about — „ändert den Typ" would name a change that exists
   * only inside the builder.
   */
  it('is a plain addition when the predecessor was never published', () => {
    const published = definition([text(NAME, 'Name')]);
    const draft = definition([
      text(NAME, 'Name'),
      { ...number(DIET, 'Semester'), replaces: SEMESTER },
    ]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [],
      added: [{ id: DIET, label: 'Semester', type: 'number' }],
      typeChanged: [],
    });
  });

  /**
   * Somebody restored or duplicated the old question after retyping. Then
   * nothing was replaced: both questions stand, and the published one is not
   * going anywhere.
   */
  it('is a plain addition while the predecessor is still in the draft', () => {
    const published = definition([text(NAME, 'Name'), text(PHONE, 'Telefon')]);
    const draft = definition([
      text(NAME, 'Name'),
      text(PHONE, 'Telefon'),
      { ...number(DIET, 'Telefon (Zahl)'), replaces: PHONE },
    ]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [],
      added: [{ id: DIET, label: 'Telefon (Zahl)', type: 'number' }],
      typeChanged: [],
    });
  });

  /**
   * Two successors for one predecessor cannot both be true, and the builder
   * mints one. The first in document order is taken — the order this module
   * reads every document in — and the second is what it looks like: a new
   * question. What must not happen is a throw, or the predecessor being
   * swallowed twice.
   */
  it('lets the first of two claims on the same predecessor win', () => {
    const published = definition([text(NAME, 'Name'), text(PHONE, 'Telefon')]);
    const draft = definition([
      text(NAME, 'Name'),
      { ...number(DIET, 'Telefon als Zahl'), replaces: PHONE },
      { ...phone(SEMESTER, 'Telefon als Telefon'), replaces: PHONE },
    ]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [],
      added: [{ id: SEMESTER, label: 'Telefon als Telefon', type: 'phone' }],
      typeChanged: [
        { id: DIET, label: 'Telefon als Zahl', from: 'text', to: 'number' },
      ],
    });
  });

  /**
   * text → number → text in one sitting: the reference survives, the type does
   * not differ. Calling that a type change would be false, and calling it
   * nothing would be worse — the id *did* change, so the answers on file are
   * orphaned exactly as by a removal. Removed plus added is what happens, so
   * removed plus added is what is reported.
   */
  it('reports removal and addition when the type came back to where it was', () => {
    const published = definition([text(NAME, 'Name'), text(PHONE, 'Telefon')]);
    const draft = definition([
      text(NAME, 'Name'),
      { ...text(DIET, 'Telefon'), replaces: PHONE },
    ]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [{ id: PHONE, label: 'Telefon', type: 'text' }],
      added: [{ id: DIET, label: 'Telefon', type: 'text' }],
      typeChanged: [],
    });
  });

  /**
   * A question that was published under its own id is not the replacement of
   * another one, whatever it claims. Taking the claim would swallow the
   * predecessor's removal and leave nothing in its place — the editor would
   * hear about neither.
   */
  it('ignores a reference carried by a question that is itself in force', () => {
    const published = definition([
      text(NAME, 'Name'),
      text(SEMESTER, 'Semester'),
      text(PHONE, 'Telefon'),
    ]);
    const draft = definition([
      text(NAME, 'Name'),
      { ...number(PHONE, 'Telefon'), replaces: SEMESTER },
    ]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [{ id: SEMESTER, label: 'Semester', type: 'text' }],
      added: [],
      typeChanged: [
        { id: PHONE, label: 'Telefon', from: 'text', to: 'number' },
      ],
    });
  });

  /**
   * A reference into nowhere — a document from another form, a hand-edited
   * snapshot, an id that never existed. It changes nothing: the comparison
   * looks the value up in two documents and never in the database, so an
   * unresolvable one is inert rather than dangerous.
   */
  it('shrugs at a reference that resolves to nothing at all', () => {
    const published = definition([text(NAME, 'Name')]);
    const draft = definition([
      text(NAME, 'Name'),
      { ...number(DIET, 'Semester'), replaces: PAGE_B },
    ]);

    expect(publishDiff(published, draft)).toEqual({
      removed: [],
      added: [{ id: DIET, label: 'Semester', type: 'number' }],
      typeChanged: [],
    });
  });
});

/**
 * „Ist überhaupt etwas zu veröffentlichen?"
 *
 * The suite is built around the trap this function exists to avoid: **every
 * case below that must count as a change produces an *empty* `publishDiff`**,
 * and each of them is asserted through that diff as well. A future refactor
 * that reaches for the diff — the obvious-looking shortcut — therefore turns
 * these tests red instead of silently locking editors out of publishing their
 * work.
 */
describe('hasUnpublishedChanges (Konzept Nr. 29)', () => {
  /** A page of a multi-page document, so page order and titles are testable. */
  function pages(
    entries: readonly {
      id: string;
      title: string;
      description?: string | null;
      questions: readonly Record<string, unknown>[];
    }[],
  ): FormDefinition {
    return parseFormDefinition({ pages: entries });
  }

  const published = definition([
    text(NAME, 'Name'),
    select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch']),
  ]);

  /**
   * The same document with every object's keys written in the opposite order —
   * what a round trip through JSONB can hand back.
   *
   * Reordered **after** parsing on purpose: `formDefinitionSchema` normalises
   * key order to the schema's own, so two parsed documents never differ that
   * way and a fixture built out of two shuffled *inputs* would prove nothing
   * about the comparison.
   */
  function withReversedKeys<T>(value: T): T {
    const reverse = (entry: unknown): unknown => {
      if (Array.isArray(entry)) {
        return (entry as readonly unknown[]).map(reverse);
      }
      if (typeof entry === 'object' && entry !== null) {
        return Object.fromEntries(
          Object.entries(entry)
            .reverse()
            .map(([key, nested]) => [key, reverse(nested)]),
        );
      }
      return entry;
    };
    return reverse(value) as T;
  }

  describe('what counts as nothing to publish', () => {
    it('reads an untouched draft as nothing to publish', () => {
      expect(
        hasUnpublishedChanges(
          published,
          definition([
            text(NAME, 'Name'),
            select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch']),
          ]),
        ),
      ).toBe(false);
    });

    it('reads the same document with reordered keys as nothing to publish', () => {
      const fromStorage = withReversedKeys(published);

      // The fixture has to actually differ byte-wise, or it asserts nothing.
      expect(JSON.stringify(fromStorage)).not.toBe(JSON.stringify(published));
      expect(hasUnpublishedChanges(fromStorage, published)).toBe(false);
    });
  });

  /**
   * The first publish has no version in force to differ from, so it is always
   * something to do — a form that has never been published must never sit
   * behind a locked button.
   */
  it('always has something to publish before the first publication', () => {
    expect(hasUnpublishedChanges(null, published)).toBe(true);
  });

  /**
   * Each of these is a real edit that `publishDiff` reports as **nothing**,
   * which is what makes them the cases the button has to be opened by.
   */
  describe('edits the publish diff cannot see', () => {
    const cases: readonly (readonly [string, FormDefinition])[] = [
      [
        'a reworded label',
        definition([
          text(NAME, 'Vor- und Zuname'),
          select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch']),
        ]),
      ],
      [
        'an edited hint',
        definition([
          { ...text(NAME, 'Name'), hint: 'Bitte wie im Ausweis' },
          select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch']),
        ]),
      ],
      [
        'a changed option list',
        definition([
          text(NAME, 'Name'),
          select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch', 'vegan']),
        ]),
      ],
      [
        'a reordered option list',
        definition([
          text(NAME, 'Name'),
          select(DIET, 'Verpflegung', ['vegetarisch', 'fleisch']),
        ]),
      ],
      [
        'a question turned into a required one',
        definition([
          { ...text(NAME, 'Name'), required: true },
          select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch']),
        ]),
      ],
      [
        'a changed width',
        definition([
          { ...text(NAME, 'Name'), width: 'half' },
          {
            ...select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch']),
            width: 'half',
          },
        ]),
      ],
      [
        'reordered questions',
        definition([
          select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch']),
          text(NAME, 'Name'),
        ]),
      ],
      [
        'a tightened validation rule',
        definition([
          { ...text(NAME, 'Name'), maxLength: 80 },
          select(DIET, 'Verpflegung', ['fleisch', 'vegetarisch']),
        ]),
      ],
    ];

    it.each(cases)('publishes %s', (_name, draft) => {
      expect(hasUnpublishedChanges(published, draft)).toBe(true);
      // The trap, pinned: the diff sees none of it. A gate built on the diff
      // would leave this draft unpublishable.
      expect(publishDiff(published, draft)).toEqual({
        removed: [],
        added: [],
        typeChanged: [],
      });
    });
  });

  describe('pages, which carry no question of their own', () => {
    const twoPages = pages([
      { id: PAGE_A, title: 'Person', questions: [text(NAME, 'Name')] },
      { id: PAGE_B, title: 'Anreise', questions: [phone(PHONE, 'Telefon')] },
    ]);

    it('publishes a renamed page', () => {
      const renamed = pages([
        {
          id: PAGE_A,
          title: 'Angaben zur Person',
          questions: [text(NAME, 'Name')],
        },
        { id: PAGE_B, title: 'Anreise', questions: [phone(PHONE, 'Telefon')] },
      ]);

      expect(hasUnpublishedChanges(twoPages, renamed)).toBe(true);
      expect(publishDiff(twoPages, renamed)).toEqual({
        removed: [],
        added: [],
        typeChanged: [],
      });
    });

    it('publishes reordered pages', () => {
      const swapped = pages([
        { id: PAGE_B, title: 'Anreise', questions: [phone(PHONE, 'Telefon')] },
        { id: PAGE_A, title: 'Person', questions: [text(NAME, 'Name')] },
      ]);

      expect(hasUnpublishedChanges(twoPages, swapped)).toBe(true);
      expect(publishDiff(twoPages, swapped)).toEqual({
        removed: [],
        added: [],
        typeChanged: [],
      });
    });

    /**
     * The field this describe-block exists for did not exist
     * when it was written. `sameDefinition` promises to need no editing for a
     * field the schema grows (`canonicalJson` is structural), and this is the
     * proof rather than a restatement of that promise: the *only* difference
     * between the two documents is a page's `description`.
     */
    it('publishes a changed page description', () => {
      const described = pages([
        {
          id: PAGE_A,
          title: 'Person',
          description: 'Bitte in Blockschrift ausfüllen.',
          questions: [text(NAME, 'Name')],
        },
        { id: PAGE_B, title: 'Anreise', questions: [phone(PHONE, 'Telefon')] },
      ]);

      expect(hasUnpublishedChanges(twoPages, described)).toBe(true);
      expect(publishDiff(twoPages, described)).toEqual({
        removed: [],
        added: [],
        typeChanged: [],
      });
    });

    /**
     * Moving a question to another page keeps every question and every page
     * title — only the split changes. `allQuestions` flattens the pages away,
     * so the diff cannot see it either.
     */
    it('publishes a question moved to another page', () => {
      const moved = pages([
        { id: PAGE_A, title: 'Person', questions: [] },
        {
          id: PAGE_B,
          title: 'Anreise',
          questions: [text(NAME, 'Name'), phone(PHONE, 'Telefon')],
        },
      ]);

      expect(hasUnpublishedChanges(twoPages, moved)).toBe(true);
    });
  });

  /** The changes the diff *does* see are changes here too — no gap between them. */
  it('publishes a removed question', () => {
    expect(
      hasUnpublishedChanges(published, definition([text(NAME, 'Name')])),
    ).toBe(true);
  });
});

describe('sameDefinition', () => {
  /**
   * Symmetric and reflexive, because the caller decides which side is the
   * published one and a comparison that depended on that would report „nichts
   * zu veröffentlichen" in one direction only.
   */
  it('is symmetric', () => {
    const a = definition([text(NAME, 'Name')]);
    const b = definition([text(NAME, 'Vorname')]);

    expect(sameDefinition(a, a)).toBe(true);
    expect(sameDefinition(a, b)).toBe(sameDefinition(b, a));
    expect(sameDefinition(a, b)).toBe(false);
  });

  /**
   * `replaces` is the one `.optional()` field of a question, so absent and
   * present-but-equal have to agree — a stored document from before no. 26 has
   * no such key at all.
   */
  it('treats an absent optional field as absent, not as different', () => {
    const withoutKey = definition([text(NAME, 'Name')]);
    const withUndefined = definition([
      { ...text(NAME, 'Name'), replaces: undefined },
    ]);

    expect(sameDefinition(withoutKey, withUndefined)).toBe(true);
    expect(
      sameDefinition(
        withoutKey,
        definition([{ ...text(NAME, 'Name'), replaces: PHONE }]),
      ),
    ).toBe(false);
  });
});

import type { Question, QuestionOption, QuestionType } from '@formsache/shared';

/**
 * A fresh question of each type, and the label the palette shows for it.
 *
 * One place, because the defaults have to satisfy `questionSchema` — a new
 * dropdown without options would not parse, so "add a question" cannot simply
 * spread a base object and set `type`. The compiler enforces that here: the
 * factory returns `Question`, so a variant missing a field of its own variant
 * does not compile.
 */

/** German names of the original nine types, in the order the palette shows them. */
export const QUESTION_TYPE_LABELS: Readonly<Record<QuestionType, string>> = {
  text: 'Text',
  textarea: 'Mehrzeilig',
  number: 'Zahl',
  date: 'Datum',
  email: 'E-Mail',
  phone: 'Telefon',
  select: 'Dropdown',
  radio: 'Einfachauswahl',
  checkbox: 'Mehrfachauswahl',
  rating: 'Bewertung',
  info: 'Infotext',
  address: 'Adresse',
  matrix: 'Matrix',
  table: 'Tabelle',
  file: 'Datei-Upload',
  event: 'Veranstaltung',
};

/**
 * The palette's types, in the order the handoff shows them.
 *
 * A **tuple**, not a `Record`, because this is one of the five places
 * where the order is itself the content — the palette is read top to bottom,
 * and later work inserts seven types between the existing ones. `satisfies` keeps an
 * unknown entry out; what it cannot do is notice a *missing* one, since a
 * shorter array is a perfectly good `readonly QuestionType[]`. That half is
 * stated below, because a type forgotten here would not fall back to a text
 * field — it would not appear in the builder at all, the quietest of the five
 * holes.
 */
export const QUESTION_TYPES = [
  'text',
  'textarea',
  'number',
  'date',
  'email',
  'phone',
  'select',
  'radio',
  'checkbox',
  // Appended rather than placed at the handoff's palette position: the
  // types between „Mehrfachauswahl" and „Bewertung" (Adresse, Veranstaltung,
  // Tabelle, Matrix) do not exist here yet, and slotting this one in early
  // would only have to move again once they land.
  'rating',
  // The handoff's palette puts „Infotext" last (`paletteTypes`), which
  // is also where it lands here without waiting for the types still missing
  // between it and `rating`.
  'info',
  // The handoff's palette has Adresse right after Dropdown (`paletteTypes`:
  // …, 'dropdown', 'address', 'event', …), but Veranstaltung, Tabelle and Matrix
  // still do not exist here, so inserting it there now would only move again once
  // they do. Appended for the same reason `rating` and `info` were.
  'address',
  // The handoff's palette has „Tabelle" between Veranstaltung and
  // Einfachauswahl and „Matrix" between Mehrfachauswahl and Bewertung
  // (`paletteTypes`). Veranstaltung is still missing, so the pair is appended
  // together rather than split across a gap that will move anyway.
  'matrix',
  'table',
  // The handoff's palette has „Datei-Upload" between Matrix and
  // Bewertung (`typeMeta()`); Veranstaltung is still missing from the run of
  // types before it, so it is appended like the five before it rather than
  // slotted into a position that would move again.
  'file',
  // The type the handoff's palette places between „Adresse" and
  // „Tabelle" (`paletteTypes`). It is appended like the six before it rather
  // than slotted in: the run of types around it has been reordered each time
  // a new type arrived, and one more move at the end costs less than six
  // that each have to be undone.
  'event',
] as const satisfies readonly QuestionType[];

/** Types the palette does not list — `never` while it lists all of them. */
type MissingFromPalette = Exclude<
  QuestionType,
  (typeof QUESTION_TYPES)[number]
>;

/**
 * The compile-time assertion itself: the constraint `never` fails by name
 * („Type 'address' does not satisfy the constraint 'never'") as soon as
 * {@link MissingFromPalette} is inhabited. Exported so it is a declaration with
 * a reader, not dead code a cleanup would remove.
 */
export type PaletteIsComplete<T extends never = MissingFromPalette> = T;

/**
 * A list of captions turned into `{ value, label }` pairs with stable,
 * readable values — what a Matrix's rows and scale steps are.
 *
 * The values go through the same {@link slugify} an imported option list uses,
 * so „Sehr gut" becomes `sehr-gut` rather than `row-1`: these values are what
 * a stored answer refers to and what the export column is keyed by, and a
 * readable one is worth as much there as it is next to an option label.
 */
function labelledList(labels: readonly string[]): QuestionOption[] {
  const taken = new Set<string>();
  return labels.map((label) => {
    const value = slugify(label, taken);
    taken.add(value);
    return { value, label };
  });
}

/**
 * The two options a fresh choice question starts with — never an empty list.
 *
 * Exported: a table column switched to „Liste" needs the same
 * seed for the same reason (an empty option list does not parse), and a second
 * pair spelled somewhere else would be the first place the two drift.
 */
export function starterOptions(): { value: string; label: string }[] {
  return [
    { value: 'option-1', label: 'Option 1' },
    { value: 'option-2', label: 'Option 2' },
  ];
}

export function createQuestion(type: QuestionType, id: string): Question {
  const base = {
    id,
    label: QUESTION_TYPE_LABELS[type],
    hint: null,
    required: false,
    // Full width by default: half width is something one *docks* a card into
    // , not a state a card is born in.
    width: 'full',
  } as const;

  switch (type) {
    case 'text':
      return {
        ...base,
        type,
        minLength: null,
        maxLength: null,
        pattern: null,
      };
    case 'textarea':
      return { ...base, type, minLength: null, maxLength: null };
    case 'number':
      return { ...base, type, min: null, max: null, integer: false };
    case 'date':
      return { ...base, type, minDate: null, maxDate: null };
    case 'email':
    case 'phone':
      return { ...base, type };
    case 'select':
    case 'radio':
      return {
        ...base,
        type,
        options: starterOptions(),
        allowOther: false,
        otherLabel: null,
      };
    case 'checkbox':
      return {
        ...base,
        type,
        options: starterOptions(),
        allowOther: false,
        otherLabel: null,
        minSelected: null,
        maxSelected: null,
      };
    case 'rating':
      // Five stars, the handoff's own default (`inspectorExtra()`'s rating
      // branch: `q.max || 5`).
      return { ...base, type, max: 5 };
    case 'info':
      // Nothing type-specific to seed — `base.label` already reads
      // „Infotext" from `QUESTION_TYPE_LABELS`, which is what an editor sees
      // and replaces with the actual explanatory text.
      return { ...base, type };
    case 'address':
      // Nothing type-specific either — no setting exists to seed, the
      // same as `email`/`phone` above; unlike those two the answer is still
      // structured, which is decided entirely downstream of this factory.
      return { ...base, type };
    case 'matrix':
      // The handoff's own starting Matrix (`addQuestion`'s matrix branch),
      // **including its label**: „Bewerte folgende Punkte" is a sentence about
      // the rows below it, and „Matrix" — the palette's name for the type —
      // would read as a heading nobody would leave standing. The three
      // statements and the four scale steps are the prototype's, verbatim.
      return {
        ...base,
        type,
        label: 'Bewerte folgende Punkte',
        rows: labelledList(['Organisation', 'Programm', 'Verpflegung']),
        columns: labelledList(['Sehr gut', 'Gut', 'Neutral', 'Schlecht']),
        multiple: false,
      };
    case 'file':
      // **One** file, which is the domain: an Anmeldung with a Nachweis,
      // a Sterbefallmeldung with a death record (ADR-0014 no. 6). The handoff's own
      // starting Datei-Upload carries `accept` and `maxMb` besides — neither
      // exists here, because both are decided by the server's allow list and
      // size limit and not by an editor (`fileQuestionSchema`).
      return { ...base, type, label: 'Datei hochladen', maxFiles: 1 };
    case 'table':
      // Two Text columns over two rows — the handoff's own starting Tabelle
      // (`addQuestion`'s table branch: `columns: [Spalte 1, Spalte 2], rows: 2`).
      return {
        ...base,
        type,
        columns: [
          { key: 'spalte-1', label: 'Spalte 1', type: 'text' },
          { key: 'spalte-2', label: 'Spalte 2', type: 'text' },
        ],
        rows: 2,
      };
    case 'event':
      // The handoff's own starting Veranstaltung (`addQuestion`'s event branch:
      // one entry, „Veranstaltung 1", no Termin, Limit 50) — **minus its
      // `registered`**, which is a counter an editor may type there and here is
      // the sum of the `event_registration` rows (`eventEntrySchema`).
      //
      // `showRemaining: false` is the default and it is a decision, not an
      // omission: Konzept no. 56 makes the number an editor's choice precisely
      // because it leaves the house without a session, and a default of „an"
      // would publish every organisation's registration state for anybody who did not think
      // about the switch. „Ausgebucht" is visible either way.
      return {
        ...base,
        type,
        label: 'Veranstaltungen',
        events: [
          {
            key: 'veranstaltung-1',
            label: 'Veranstaltung 1',
            when: null,
            capacity: 50,
            showRemaining: false,
          },
        ],
      };
  }
}

/**
 * Parses a pasted block into options — the Massenimport of the handoff.
 *
 * One option per line. `Wert = Beschriftung` is honoured when a line carries an
 * `=`, because an admin who re-imports a list must be able to keep the values
 * their existing answers refer to; a plain line generates a stable value from
 * the label.
 *
 * Duplicate values are dropped rather than rejected: a pasted list from a
 * spreadsheet routinely repeats a line, and refusing the whole import for that
 * would send the user back to a text editor. The *schema* still refuses
 * duplicates, so nothing invalid can be produced here — this only decides what
 * a paste means.
 */
export function parseOptionBulkImport(
  source: string,
): { value: string; label: string }[] {
  const seen = new Set<string>();
  const options: { value: string; label: string }[] = [];

  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }

    const separator = trimmed.indexOf('=');
    const label = (
      separator === -1 ? trimmed : trimmed.slice(separator + 1)
    ).trim();
    const explicitValue =
      separator === -1 ? undefined : trimmed.slice(0, separator).trim();

    if (label === '') {
      continue;
    }

    const value =
      explicitValue !== undefined && explicitValue !== ''
        ? explicitValue
        : slugify(label, seen);
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    options.push({ value, label });
  }

  return options;
}

/**
 * A readable, stable value for a label.
 *
 * Readable matters more than it looks: these values end up in the CSV export
 * next to the labels, and `ja-ich-komme` tells a reader something that
 * `option-7` does not. Umlauts are transliterated rather than stripped, so
 * „Grüße" does not become „gre".
 */
function slugify(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/ä/gu, 'ae')
      .replace(/ö/gu, 'oe')
      .replace(/ü/gu, 'ue')
      .replace(/ß/gu, 'ss')
      .normalize('NFD')
      .replace(/[̀-ͯ]/gu, '')
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 60) || 'option';

  if (!taken.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

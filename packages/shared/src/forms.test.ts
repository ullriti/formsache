import { describe, expect, it } from 'vitest';

import {
  FORM_PAGE_SIZE_DEFAULT,
  FORM_PAGE_SIZE_MAX,
  FORM_SEARCH_MAX_LENGTH,
  formListQuerySchema,
  formSummarySchema,
  parsePublishPreview,
} from './forms.ts';

/**
 * The publish preview on the wire.
 *
 * Only `blocked` is pinned here — specifically the
 * property that makes it an **additive** change. Everything else about this
 * payload has been covered through the two sides that produce and consume it
 *.
 */

const BASE = {
  revision: 3,
  publishedVersion: 2,
  responseCount: 7,
  changes: { removed: [], added: [], typeChanged: [] },
};

describe('publishPreviewSchema — blocked', () => {
  /**
   * A server one deploy behind sends no `blocked` at all, and a client that saw
   * `undefined` would evaluate `blocked.length > 0` to a crash — or, worse,
   * guard it away and quietly publish over a dangling placeholder. The default
   * makes „absent" mean „nothing blocked" for every reader at once.
   */
  it('defaults to an empty list when the field is absent', () => {
    expect(parsePublishPreview(BASE).blocked).toEqual([]);
  });

  it('carries the notification, the token, the caption and the places', () => {
    const parsed = parsePublishPreview({
      ...BASE,
      blocked: [
        {
          notificationName: 'Bestätigung an Teilnehmer',
          token: '{{frage:019fe500-0000-7000-8000-0000000000c1}}',
          label: 'E-Mail-Adresse',
          places: ['recipients', 'body'],
        },
      ],
    });

    expect(parsed.blocked).toEqual([
      {
        // Filled in by the default: the payload above carries no discriminator,
        // because it is the shape a server one deploy behind sends (this field's
        // second shape arrived later, and „additiv" has to keep meaning
        // additiv).
        kind: 'placeholder',
        notificationName: 'Bestätigung an Teilnehmer',
        token: '{{frage:019fe500-0000-7000-8000-0000000000c1}}',
        label: 'E-Mail-Adresse',
        places: ['recipients', 'body'],
      },
    ]);
  });

  /** The caption is only known while the version in force still has it. */
  it('accepts a finding whose question caption is unknown', () => {
    const parsed = parsePublishPreview({
      ...BASE,
      blocked: [
        {
          notificationName: 'Interne Meldung',
          token: '{{frage:019fe500-0000-7000-8000-0000000000c2}}',
          label: null,
          places: [],
        },
      ],
    });

    // Narrowed rather than read blindly:/0.2 the list holds two
    // shapes, and „`label` ist null" would also be true of an entry that has no
    // `label` at all — the condition shape.
    const [finding] = parsed.blocked;
    if (finding?.kind !== 'placeholder') {
      throw new Error('Der Befund oben ist ein Platzhalter-Befund.');
    }
    expect(finding.label).toBeNull();
  });

  it('refuses a place the application has no wording for', () => {
    expect(() =>
      parsePublishPreview({
        ...BASE,
        blocked: [
          {
            notificationName: 'Interne Meldung',
            token: '{{frage:019fe500-0000-7000-8000-0000000000c2}}',
            label: null,
            // `PLACE_LABELS` in `PublishNotice` is exhaustive over the three
            // literals; a fourth would render as `undefined` in the dialog.
            places: ['attachment'],
          },
        ],
      }),
    ).toThrow();
  });
});

/**
 * The second shape of `blocked` — a Bedingung whose source no longer resolves.
 *
 * The wire is where the two shapes meet, and the three things worth pinning are
 * exactly the three ways one field for two shapes goes wrong: a condition
 * finding read as a placeholder (or the other way round), a defect the dialog
 * has no sentence for, and the old placeholder payload no longer parsing.
 */
describe('publishPreviewSchema — blocked conditions', () => {
  const CONDITION = {
    kind: 'condition',
    questionLabel: 'Mitfahrgelegenheit',
    sourceLabel: 'Anreise',
    defect: 'missing',
  };

  it('keeps the two shapes apart in one list', () => {
    const parsed = parsePublishPreview({
      ...BASE,
      blocked: [
        CONDITION,
        {
          notificationName: 'Bestätigung',
          token: '{{frage:019fe500-0000-7000-8000-0000000000c1}}',
          label: 'E-Mail-Adresse',
          places: ['body'],
        },
      ],
    });

    // Not `toHaveLength(2)`: a union that put both entries through the *same*
    // branch would still be two, and the dialog would render the wrong list.
    expect(parsed.blocked.map((finding) => finding.kind)).toEqual([
      'condition',
      'placeholder',
    ]);
    expect(parsed.blocked[0]).toEqual(CONDITION);
  });

  /** The source may be gone from both documents — then it has no caption. */
  it('accepts a finding whose source caption is unknown', () => {
    const parsed = parsePublishPreview({
      ...BASE,
      blocked: [{ ...CONDITION, sourceLabel: null }],
    });

    expect(parsed.blocked[0]).toEqual({ ...CONDITION, sourceLabel: null });
  });

  /**
   * `reasonOf` in `condition.ts` is exhaustive over the four defects; a fifth
   * one arriving from anywhere would render as `undefined` in the dialog — the
   * `places: ['attachment']` case above makes the same point.
   */
  it('refuses a defect the application has no sentence for', () => {
    expect(() =>
      parsePublishPreview({
        ...BASE,
        blocked: [{ ...CONDITION, defect: 'cycle' }],
      }),
    ).toThrow();
  });

  /** Nothing to name, nothing to open — an empty caption is not a finding. */
  it('refuses a finding without the name of the affected question', () => {
    expect(() =>
      parsePublishPreview({
        ...BASE,
        blocked: [{ ...CONDITION, questionLabel: '' }],
      }),
    ).toThrow();
  });

  /**
   * **The `kind` of the condition shape stays required** — the one property
   * `publishBlockedSchema` leans on and the only one nothing else measures.
   *
   * The union is undiscriminated so that the placeholder payload of a server one
   * deploy behind still parses through the first branch and its default; that
   * only stays safe while „no branch matched" cannot mean „matched the wrong
   * one". Give the condition shape a `.default('condition')` too and this entry
   * goes through the *placeholder* branch instead — the dialog then files a
   * broken condition under „Diese Benachrichtigungen verweisen auf Fragen …",
   * with no notification to name and no token, and the editor reads a block with
   * an empty reason. The comment in `forms.ts` says this holds; here it is
   * measured.
   */
  it('refuses a condition finding that carries no kind', () => {
    expect(() =>
      parsePublishPreview({
        ...BASE,
        blocked: [
          {
            questionLabel: 'Mitfahrgelegenheit',
            sourceLabel: 'Anreise',
            defect: 'missing',
          },
        ],
      }),
    ).toThrow();
  });
});

/**
 * The effective rights per form on the wire.
 *
 * Pinned **here** rather than only at the two ends, because this is the seam:
 * the API fills the field and the web client renders decisions from it, and a
 * payload without it must not quietly parse into „alles erlaubt" or into
 * `undefined` that a `&&` reads as „nichts erlaubt". It is required, and the
 * parse is where that is decided.
 */
describe('formSummarySchema — permissions', () => {
  const SUMMARY = {
    id: '019fe200-0000-7000-8000-000000000001',
    title: 'Anmeldung Jahrestagung',
    status: 'active',
    publishedVersion: 1,
    responseCount: 3,
    updatedAt: '2026-07-27T10:00:00.000Z',
    permissions: {
      canBuild: false,
      canViewResponses: true,
      canExport: false,
      canManageSettings: false,
      canManageFormSettings: false,
      canManageUsers: true,
    },
  };

  it('carries the five flags of the capped role, not a shorthand', () => {
    const summary = formSummarySchema.parse(SUMMARY);

    expect(summary.permissions).toEqual(SUMMARY.permissions);
  });

  /**
   * **Deliberately no default.** `blocked` above has one because „absent"
   * genuinely means „nothing blocked"; here every possible default is a lie —
   * all-true grants what a cap took away, all-false hides a form's every
   * control. A server that does not send the field is a server this client
   * cannot render honestly, and the parse says so.
   */
  it('refuses a payload that omits them', () => {
    const { permissions, ...without } = SUMMARY;
    expect(permissions).toBeDefined();

    expect(() => formSummarySchema.parse(without)).toThrow();
  });

  it('refuses a payload that omits a single flag', () => {
    const { canExport, ...incomplete } = SUMMARY.permissions;
    expect(canExport).toBe(false);

    expect(() =>
      formSummarySchema.parse({ ...SUMMARY, permissions: incomplete }),
    ).toThrow();
  });
});

/**
 * **The query contract of the paged form list** .
 *
 * Unit-tested here rather than only through the route, because this is where
 * the ceiling actually lives: `formListQuerySchema` is what both ends read, so
 * a client that computed its own page arithmetic would still be clamped by the
 * same function the server clamps with. The integration suite proves the route
 * uses it; these prove what it does.
 */
describe('formListQuerySchema', () => {
  it('defaults to the measured page size and the first page', () => {
    expect(formListQuerySchema.parse({})).toEqual({
      limit: FORM_PAGE_SIZE_DEFAULT,
      offset: 0,
      q: '',
      id: undefined,
    });
  });

  /**
   * **An unknown parameter is refused, not swallowed**
   * (a find of an acceptance run).
   *
   * The schema was a `z.object`, and that throws unknown keys away:
   * `?search=…` — the parameter is called `q` — got no refusal but
   * the **first page of the whole Organisation**, and nothing told the caller
   * that their search never took place. They read 24 forms and take
   * them for their hits.
   *
   * ⚠️ **Six isolated runs went green past it.** Against a fresh
   * database „all forms of the Organisation" and „those of the run"
   * coincide; only the full run turned an `Expected: 2` into a
   * `Received: 97`. A schema test like this one would have seen it at once — and
   * that is exactly why it now stands here and not only in the run.
   */
  it('weist einen unbekannten Parameter ab, statt ihn wegzuwerfen', () => {
    const refused = formListQuerySchema.safeParse({ search: 'Jahrestagung' });

    expect(refused.success).toBe(false);
    // And the known neighbour stays untouched: it is about the **name**,
    // not about strictness as such.
    expect(formListQuerySchema.safeParse({ q: 'Jahrestagung' }).success).toBe(
      true,
    );
  });

  /**
   * ⚠️ Worth calling out: „ein `limit=100000` aus der Adresszeile
   * bekommt den Deckel, nicht die Zahl." Clamped — deliberately not refused;
   * an over-large limit is an honest request for „alles".
   *
   * **The difference to the case above is what both lines say
   * together:** there the *name* is unknown and there is no recognisable
   * wish; here the *value* is too large and the wish stays readable.
   */
  it('clamps an over-large limit instead of obeying or refusing it', () => {
    expect(formListQuerySchema.parse({ limit: '100000' }).limit).toBe(
      FORM_PAGE_SIZE_MAX,
    );
    expect(
      formListQuerySchema.parse({ limit: String(FORM_PAGE_SIZE_MAX + 1) })
        .limit,
    ).toBe(FORM_PAGE_SIZE_MAX);
    // …and a limit below the ceiling is passed through untouched, or the clamp
    // would be indistinguishable from a constant.
    expect(formListQuerySchema.parse({ limit: '7' }).limit).toBe(7);
  });

  it('refuses a limit that is not a whole number rather than guessing one', () => {
    expect(() => formListQuerySchema.parse({ limit: 'alle' })).toThrow();
    expect(() => formListQuerySchema.parse({ limit: '2.5' })).toThrow();
    expect(() => formListQuerySchema.parse({ limit: '-1' })).toThrow();
    // Zero is refused rather than clamped to one: „gib mir keine Zeilen" is not
    // a wish anybody has, it is a mistake.
    expect(() => formListQuerySchema.parse({ limit: '0' })).toThrow();
  });

  it('refuses a negative offset and accepts zero', () => {
    expect(formListQuerySchema.parse({ offset: '0' }).offset).toBe(0);
    expect(formListQuerySchema.parse({ offset: '48' }).offset).toBe(48);
    expect(() => formListQuerySchema.parse({ offset: '-1' })).toThrow();
  });

  /**
   * **Regression, review finding of this package.** An offset of nineteen
   * digits passes the digit regex and `Number.isInteger`, and used to reach
   * Prisma's `skip` — where it does not fit a 64-bit signed integer and became
   * a **500**. The bound turns it into the 400 it always was.
   *
   * Without the `.max()` this case is green (the value parses) and the defect
   * only shows against a database, which is why the bound is asserted here
   * *and* through the route.
   */
  it('refuses an offset too large to be represented exactly', () => {
    expect(
      formListQuerySchema.parse({ offset: String(Number.MAX_SAFE_INTEGER) })
        .offset,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      formListQuerySchema.parse({ offset: '10000000000000000000' }),
    ).toThrow();
  });

  it('trims the search term and bounds its length', () => {
    expect(formListQuerySchema.parse({ q: '  Jahrestagung  ' }).q).toBe(
      'Jahrestagung',
    );
    expect(formListQuerySchema.parse({ q: '   ' }).q).toBe('');
    expect(() =>
      formListQuerySchema.parse({ q: 'x'.repeat(FORM_SEARCH_MAX_LENGTH + 1) }),
    ).toThrow();
  });

  /**
   * The id is parsed as a uuid rather than passed through as text. Not a
   * security boundary — the restriction and the tenant are — but a malformed id
   * that reached the `where` would be a database error where a 400 belongs.
   */
  it('refuses an id that is not a uuid', () => {
    const id = '019fe200-0000-7000-8000-000000000001';
    expect(formListQuerySchema.parse({ id }).id).toBe(id);
    expect(() => formListQuerySchema.parse({ id: 'nope' })).toThrow();
  });

  /**
   * **Reversed on 2026-08-11, and the old reasoning was the problem.**
   *
   * Here it said: „Unknown query parameters are dropped, not refused — `?columns=`
   * und Verwandte reisen auf anderen Routen, und ein geteilter Client könnte
   * sie mitschicken." Looked up instead of believed: `apps/web/src/api/forms.ts`
   * builds the query **explicitly** out of `limit`, `offset` and `q`; there is
   * no shared builder that appends anything, and `columns=` stands on the
   * export route, which never sees this schema. The argument was hypothetical.
   *
   * The damage was not: an acceptance run sent `?search=…` and
   * got the first page of the **whole Organisation**. A hypothetical benefit
   * against a measured damage — hence `strictObject`.
   */
  it('weist einen unbekannten Parameter ab, statt ihn stillschweigend zu ignorieren', () => {
    expect(formListQuerySchema.safeParse({ sortieren: 'titel' }).success).toBe(
      false,
    );
  });
});

/**
 * **The two traffic lights of the publish dialogue** — the notice of *this
 * form* and the legal texts of *the organisation* (ADR-0028 nos. 3 and 4).
 *
 * Two things are pinned here and nowhere else, because the wire is where they
 * are decided:
 *
 * 1. **„Wir wissen es nicht" is no shortcoming.** A server one version behind
 *    sends neither field. A client that read `undefined` as „unfertig" would
 *    halt every publishing dialogue of that installation with a finding
 *    nobody can act on — the same direction `blocked` resolves above.
 * 2. **`organisationLegal` stays *one* value.** Which of the two pages is
 *    missing is a statement the route may not make: it stands behind
 *    `can_build`, while the document it summarises stands behind
 *    `can_manage_settings`. That the schema *refuses* the page-by-page shape
 *    is what keeps a later „nur ein bisschen genauer" from passing quietly.
 */
describe('publishPreviewSchema — die beiden Ampeln', () => {
  it('liest ein fehlendes Feld als `ready` und nicht als Mangel', () => {
    const parsed = parsePublishPreview(BASE);

    expect(parsed.privacyNotice).toBe('ready');
    expect(parsed.organisationLegal).toBe('ready');
  });

  it('trägt die drei Zustände unverändert weiter', () => {
    for (const status of ['empty', 'incomplete', 'ready'] as const) {
      expect(
        parsePublishPreview({ ...BASE, organisationLegal: status })
          .organisationLegal,
      ).toBe(status);
    }
  });

  /**
   * A fourth state would render as `undefined` in the dialogue — the same
   * point the `places: ['attachment']` case makes above.
   */
  it('weist einen Zustand ab, den der Dialog nicht kennt', () => {
    expect(() =>
      parsePublishPreview({ ...BASE, organisationLegal: 'unbekannt' }),
    ).toThrow();
  });

  /**
   * ⚠️ The boundary of open item 3, at the one place it can be measured
   * without a database: **never which page.** Whoever widens the field to the
   * shape below has moved the answer past the guard on `GET /tenant/legal`,
   * and this case is what says so.
   */
  it('weist eine Auskunft je Seite ab — die Ampel gilt beiden zusammen', () => {
    expect(() =>
      parsePublishPreview({
        ...BASE,
        organisationLegal: { imprint: 'empty', privacy: 'ready' },
      }),
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import { parseFormDefinition } from './form-schema.ts';
import {
  AVAILABILITY_KEYS,
  EMPTY_SETTINGS_OVERRIDE,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_KEYS,
  PASSWORD_MIN,
  SYSTEM_FORM_SETTINGS,
  TENANT_SETTINGS_FLOOR,
  effectiveRedirect,
  effectiveSettings,
  formSettingsOverrideSchema,
  formSettingsPatchSchema,
  formSettingsSchema,
  formSettingsWriteSchema,
  mergeSettings,
  parseFormSettings,
  parseFormSettingsOverride,
  parseTenantFormDefaults,
  pruneToOverridden,
  revokesEditLinks,
  setSectionOverride,
  tenantFormDefaultsSchema,
  type FormSettings,
  type FormSettingsOverride,
  type PartialFormSettings,
  type TenantFormSettings,
} from './form-settings.ts';

/**
 * The schema and the inheritance merge.
 *
 * The merge tests are the load-bearing ones: they are what says that a tenant
 * default reaches a form nobody touched, and stops at a form that took the
 * section over.
 *
 * **The negative probe was run and holds.** Replacing the one section-wise
 * check in `effectiveSettings` with a field-wise one
 * (`withValues(tenantDefaults, override.values, keys)`) turns „1 — the standard
 * gets through" and „2 — a customised section does not follow" red, exactly as
 * predicted. Three further tests added after the review
 * gate fail with them — „accepts a value that does not apply", „reads a
 * taken-over section without any values as the system defaults" and the
 * `pruneToOverridden` round-trip — and they are merge semantics too. Nothing
 * outside the merge moves: the schema tests, both toggle cases and the
 * original-shape regression stay green.
 */

/** The two stored-document schemas, under the names this file used to build. */
const settingsSchema = formSettingsSchema;
const overrideSchema = formSettingsOverrideSchema;

/** A complete, valid settings document — the „vollständiger Einstellungssatz". */
const completeSettings = {
  openEnabled: true,
  openAt: '2026-06-01T06:00:00Z',
  closeAt: '2026-08-15T21:59:00Z',
  timeLimitEnabled: true,
  timeLimitMin: 30,
  maxResponsesEnabled: true,
  maxResponses: 250,

  passwordEnabled: true,
  password: 'Jahrestagung2026',
  allowSaveDraft: false,
  allowEdit: true,

  confirmTitle: 'Vielen Dank für Ihre Anmeldung!',
  confirmMsg: 'Ihre Angaben wurden gespeichert.',
  redirectEnabled: true,
  redirectUrl: 'https://beispielverein.de/',
  redirectDelay: 5,

  showProgress: true,
  showPageNumbers: false,
  showRequiredHint: true,

  mailBudgetLimit: 1000,
  mailBudgetWindowMin: 60,
} satisfies FormSettings;

/**
 * The organisation's standard for the merge tests — **no *Verfügbarkeit***, and
 * that is not an omission: an organisation has none (ADR-0011, continuation
 * 2026-08-14), and the type below refuses to hold one.
 */
const tenantDefaults: TenantFormSettings = parseTenantFormDefaults({
  allowEdit: true,
  confirmTitle: 'Danke, Mitglied.',
  redirectDelay: 42,
  showProgress: false,
});

function overrideOf(
  overridden: Partial<FormSettingsOverride['overridden']>,
  values: PartialFormSettings,
): FormSettingsOverride {
  return parseFormSettingsOverride({ overridden, values });
}

/** The first issue's path, as a caller would report it to the editor. */
function firstIssuePath(source: unknown): (string | number | symbol)[] {
  const result = settingsSchema.safeParse(source);
  expect(result.success).toBe(false);
  return result.error?.issues[0]?.path ?? [];
}

describe('formSettingsSchema', () => {
  it('parses a complete settings document unchanged', () => {
    expect(parseFormSettings(completeSettings)).toStrictEqual(completeSettings);
  });

  it('stores a redirect target the way a browser will resolve it', () => {
    // What is stored has to be what is followed: `http:evil` is
    // accepted by every browser and resolves to a host, so the normalised form
    // is what belongs in the column — not the shorthand somebody pasted.
    expect(
      parseFormSettings({ ...completeSettings, redirectUrl: 'http:evil' })
        .redirectUrl,
    ).toBe('http://evil/');
  });

  it('rejects an access word made of spaces', () => {
    expect(
      firstIssuePath({
        ...completeSettings,
        passwordEnabled: true,
        password: '   ',
      }),
    ).toStrictEqual(['password']);
  });

  it('rejects a timestamp with an explicit offset', () => {
    // Not because an offset would be ambiguous — it is not — but so that one
    // instant has one spelling in the column (see `utcInstantSchema`).
    expect(
      firstIssuePath({
        ...completeSettings,
        closeAt: '2026-08-15T23:59:00+02:00',
      }),
    ).toStrictEqual(['closeAt']);
  });

  it('rejects a document that is not an object at all', () => {
    for (const source of ['irgendwas', 42, [], true]) {
      expect(settingsSchema.safeParse(source).success).toBe(false);
    }
  });

  it('rejects free text past its bound instead of storing a novel', () => {
    expect(
      firstIssuePath({ ...completeSettings, confirmTitle: 'x'.repeat(201) }),
    ).toStrictEqual(['confirmTitle']);
    expect(
      firstIssuePath({ ...completeSettings, confirmTitle: '' }),
    ).toStrictEqual(['confirmTitle']);
    expect(
      firstIssuePath({ ...completeSettings, timeLimitMin: 24 * 60 + 1 }),
    ).toStrictEqual(['timeLimitMin']);
  });

  it('reads an absent tenant standard as the system defaults', () => {
    // `tenant.form_defaults` is a new column and NULL for every tenant that
    // existed before this column (no backfill). The fallback lives here
    // so it is not a rule every call site has to remember.
    expect(parseFormSettings(null)).toStrictEqual(SYSTEM_FORM_SETTINGS);
    expect(parseFormSettings(undefined)).toStrictEqual(SYSTEM_FORM_SETTINGS);
    expect(parseFormSettings({})).toStrictEqual(SYSTEM_FORM_SETTINGS);
  });

  it('rejects a closing instant that lies before the opening one', () => {
    expect(
      firstIssuePath({
        ...completeSettings,
        openAt: '2026-08-15T21:59:00Z',
        closeAt: '2026-06-01T06:00:00Z',
      }),
    ).toStrictEqual(['closeAt']);
  });

  it('rejects a response limit of zero or less', () => {
    expect(
      firstIssuePath({ ...completeSettings, maxResponses: 0 }),
    ).toStrictEqual(['maxResponses']);
    expect(
      firstIssuePath({ ...completeSettings, maxResponses: -5 }),
    ).toStrictEqual(['maxResponses']);
  });

  it('rejects a time limit of zero or less', () => {
    expect(
      firstIssuePath({ ...completeSettings, timeLimitMin: 0 }),
    ).toStrictEqual(['timeLimitMin']);
    expect(
      firstIssuePath({ ...completeSettings, timeLimitMin: -1 }),
    ).toStrictEqual(['timeLimitMin']);
  });

  it('rejects a redirect target that is neither http nor https', () => {
    // Both of these are what a stored XSS looks like on a page strangers open
    //  — the schema is where they stop being storable.
    expect(
      firstIssuePath({
        ...completeSettings,
        redirectUrl: 'javascript:alert(1)',
      }),
    ).toStrictEqual(['redirectUrl']);
    expect(
      firstIssuePath({
        ...completeSettings,
        redirectUrl: 'data:text/html,<script>alert(1)</script>',
      }),
    ).toStrictEqual(['redirectUrl']);
    expect(
      firstIssuePath({ ...completeSettings, redirectUrl: 'allgemeine.de' }),
    ).toStrictEqual(['redirectUrl']);
  });

  it('rejects password protection without a password', () => {
    expect(
      firstIssuePath({
        ...completeSettings,
        passwordEnabled: true,
        password: '',
      }),
    ).toStrictEqual(['password']);
  });

  it('rejects a redirect without a target', () => {
    expect(
      firstIssuePath({
        ...completeSettings,
        redirectEnabled: true,
        redirectUrl: null,
      }),
    ).toStrictEqual(['redirectUrl']);
  });

  it('rejects an unknown settings key and names it', () => {
    const result = settingsSchema.safeParse({
      ...completeSettings,
      wasAuchImmer: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    // Zod reports an unrecognized key on the *object*, and names the key in
    // `keys` — that is the pointer an editor gets, and it is asserted here so a
    // caller can rely on it.
    expect(result.error?.issues[0]).toMatchObject({
      keys: ['wasAuchImmer'],
    });
  });

  it('rejects a document carrying the dropped „onePerPerson"', () => {
    // Client decision of 2026-07-27: the setting is gone, not tolerated. A
    // document from a client that still knows it must fail loudly, or the
    // editor believes a restriction is in force that nothing enforces.
    const result = settingsSchema.safeParse({
      ...completeSettings,
      onePerPerson: true,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['onePerPerson'],
    });
  });

  it('rejects an unknown section key in the override state', () => {
    const result = overrideSchema.safeParse({
      overridden: { access: true, sonstiges: true },
      values: {},
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      path: ['overridden'],
      keys: ['sonstiges'],
    });
  });

  it('rejects „onePerPerson" inside an override as well', () => {
    const result = overrideSchema.safeParse({
      overridden: { display: true },
      values: { onePerPerson: true },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      path: ['values'],
      keys: ['onePerPerson'],
    });
  });

  it('rejects a naive local timestamp — a stored instant carries its zone', () => {
    // `datetime-local` produces `2026-08-15T23:59`; converting it to an instant
    // is the edge's job (open point 1). A value
    // without a zone would mean different things to the browser and to the
    // server clock it is compared against.
    expect(
      firstIssuePath({ ...completeSettings, closeAt: '2026-08-15T23:59' }),
    ).toStrictEqual(['closeAt']);
  });

  it('falls back to the system default for a key an older document lacks', () => {
    // Not `undefined`: a missing deadline has to mean „no deadline", otherwise
    // the first comparison at submission time throws instead of deciding.
    const parsed = parseFormSettings({ maxResponsesEnabled: true });

    expect(parsed.openAt).toBeNull();
    expect(parsed.closeAt).toBeNull();
    expect(parsed.maxResponses).toBe(SYSTEM_FORM_SETTINGS.maxResponses);
    expect(parsed).toStrictEqual({
      ...SYSTEM_FORM_SETTINGS,
      maxResponsesEnabled: true,
    });
  });

  it('reads an absent override as „all four sections on tenant default"', () => {
    // An untouched form has no `settings_override`, and that absence
    // is the meaning — no backfill needed and none done.
    expect(parseFormSettingsOverride(null)).toStrictEqual(
      EMPTY_SETTINGS_OVERRIDE,
    );
    expect(parseFormSettingsOverride(undefined)).toStrictEqual(
      EMPTY_SETTINGS_OVERRIDE,
    );
    expect(parseFormSettingsOverride({})).toStrictEqual(
      EMPTY_SETTINGS_OVERRIDE,
    );
  });

  it('assigns every setting to exactly one section', () => {
    // The merge walks the sections; a key in none of them would be decided by
    // nobody, a key in two by whichever section runs last. Both are silent, so
    // they are asserted rather than trusted (the map is derived from the same
    // four shapes the schema is built from — this is the guard for a future addition adding a
    // field).
    const assigned = [
      ...AVAILABILITY_KEYS,
      ...SETTINGS_SECTIONS.flatMap((section) => SETTINGS_SECTION_KEYS[section]),
    ];

    expect(new Set(assigned).size).toBe(assigned.length);
    expect(new Set(assigned)).toStrictEqual(
      new Set(Object.keys(SYSTEM_FORM_SETTINGS)),
    );
  });

  it('leaves the form schema untouched', () => {
    // Settings hang off the *form*, not off its questions. An older document
    // keeps parsing exactly as it did, with
    // one addition (a review finding): `description` no longer stays
    // absent — `pageSchema` normalises the key's absence to an explicit
    // `null` (the same value a page that was touched and left empty parses
    // to), so an older document round-trips to that `null` rather than to
    // itself byte-for-byte.
    const m1Document = {
      pages: [
        {
          id: '019ff000-0000-7000-8000-0000000000f0',
          title: 'Angaben',
          questions: [
            {
              id: '019ff000-0000-7000-8000-000000000001',
              type: 'email',
              label: 'E-Mail des Vorsitzenden',
              hint: null,
              required: true,
              width: 'full',
            },
          ],
        },
      ],
    };

    expect(parseFormDefinition(m1Document)).toStrictEqual({
      pages: [{ ...m1Document.pages[0], description: null }],
    });
  });
});

describe('formSettingsOverrideSchema', () => {
  it('rejects an inconsistent value in a section the form has taken over', () => {
    // The promise made at `checkSettingsConsistency`: password protection
    // without a password must fail here, not in front of a participant.
    const result = overrideSchema.safeParse({
      overridden: { access: true },
      values: { passwordEnabled: true },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['values', 'password']);
  });

  it('rejects a crossed deadline in a section the form has taken over', () => {
    // *Verfügbarkeit* belongs to no section and therefore always applies —
    // which is exactly why the rule is judged here without a switch being on.
    const result = overrideSchema.safeParse({
      overridden: {},
      values: {
        openAt: '2026-08-15T21:59:00Z',
        closeAt: '2026-06-01T06:00:00Z',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['values', 'closeAt']);
  });

  it('accepts a value that does not apply, because it does not apply', () => {
    // The prototype writes a full value set whatever the switches say
    // (`patchFormSetting`), so documents like this one exist. Rejecting them
    // would produce a stored row nobody can read any more — while the merge
    // provably ignores the value (test „1 — the standard gets through").
    const override = parseFormSettingsOverride({
      overridden: { display: true },
      values: { redirectEnabled: true },
    });

    expect(effectiveSettings(tenantDefaults, override).redirectEnabled).toBe(
      tenantDefaults.redirectEnabled,
    );
  });

  /**
   * **The product decision itself**, nailed down instead of read off the
   * constant (review finding 16, `CHANGELOG.md`: „Zwischenspeichern erlauben"
   * and „Bearbeiten nach Absenden" are on ex works).
   *
   * `toBe(true)` and not `toBe(SYSTEM_FORM_SETTINGS.allowEdit)`: a
   * comparison of the constant with itself would stay green if somebody turned
   * the two lines back — and turning them back is exactly what flips every
   * inheriting form (the confirmation page then hands out no edit link
   * any more, the fill-in view no „Zwischenspeichern"). Whoever changes them
   * changes them here as well and writes it into the CHANGELOG.
   */
  it('ships with Zwischenspeichern and Bearbeiten nach Absenden switched on', () => {
    expect(SYSTEM_FORM_SETTINGS.allowSaveDraft).toBe(true);
    expect(SYSTEM_FORM_SETTINGS.allowEdit).toBe(true);

    // And the consequence this is about: a form whose settings nobody has
    // ever been at inherits both — across both layers.
    const untouched = effectiveSettings(
      parseTenantFormDefaults(null),
      parseFormSettingsOverride(null),
    );
    expect(untouched.allowSaveDraft).toBe(true);
    expect(untouched.allowEdit).toBe(true);
  });

  it('keeps the shared constants out of reach of a caller', () => {
    // Both are read on every request in a long-lived process; a stray
    // assignment would change what „untouched" means for every tenant at once.
    expect(Object.isFrozen(SYSTEM_FORM_SETTINGS)).toBe(true);
    expect(Object.isFrozen(EMPTY_SETTINGS_OVERRIDE)).toBe(true);
    expect(Object.isFrozen(EMPTY_SETTINGS_OVERRIDE.overridden)).toBe(true);
    expect(parseFormSettingsOverride(null)).not.toBe(EMPTY_SETTINGS_OVERRIDE);
    expect(parseFormSettings(null)).not.toBe(SYSTEM_FORM_SETTINGS);
  });
});

describe('mergeSettings (write path)', () => {
  it('changes what the patch names and nothing else', () => {
    // The trap this exists for: running a partial write through
    // `formSettingsSchema` and storing the result would reset every field the
    // writer did not mention.
    const patch = formSettingsPatchSchema.parse({ redirectDelay: 9 });
    const merged = mergeSettings(tenantDefaults, patch);

    expect(merged.redirectDelay).toBe(9);
    expect(merged).toStrictEqual({ ...tenantDefaults, redirectDelay: 9 });
  });

  it('cannot put a deadline into a document that has none', () => {
    // The organisation's standard has no *Verfügbarkeit*, and a patch may only
    // move a value the document already carries — otherwise the editor's page
    // could grow a key the schema below refuses.
    const merged = mergeSettings(
      tenantDefaults,
      formSettingsPatchSchema.parse({ closeAt: '2026-12-24T12:00:00Z' }),
    );

    expect(Object.keys(merged)).not.toContain('closeAt');
  });

  it('validates each field the patch carries', () => {
    expect(formSettingsPatchSchema.safeParse({ maxResponses: 0 }).success).toBe(
      false,
    );
    expect(
      formSettingsPatchSchema.safeParse({ redirectUrl: 'javascript:alert(1)' })
        .success,
    ).toBe(false);
  });
});

describe('pruneToOverridden (write path)', () => {
  it('keeps only the values of the sections that are taken over', () => {
    const override = parseFormSettingsOverride({
      overridden: { budget: true },
      values: { mailBudgetLimit: 4000, showProgress: true, password: 'geheim' },
    });

    const pruned = pruneToOverridden(override);

    expect(pruned.values).toStrictEqual({ mailBudgetLimit: 4000 });
    expect(pruned.overridden).toStrictEqual(override.overridden);
    // Pruning changes what is kept, never what applies.
    expect(effectiveSettings(tenantDefaults, pruned)).toStrictEqual(
      effectiveSettings(tenantDefaults, override),
    );
  });

  /**
   * The **budget section specifically**, because the integration round-trip
   * cannot see it: a row from before the fifth section never carries these two
   * keys, and a no-op resave sends an empty value set — so nothing is there to
   * prune either way, and a budget-shaped break in {@link pruneToOverridden}
   * leaves that test green (measured in a review).
   *
   * Here the values *are* present, so keeping them is visible. Both directions
   * are asserted: an untaken section drops them, a taken one keeps them. Only
   * the pair catches a special case in either direction.
   */
  it('drops the budget values of a section that was not taken over', () => {
    const override = parseFormSettingsOverride({
      overridden: { display: true },
      values: { showProgress: false, mailBudgetLimit: 4000 },
    });

    expect(pruneToOverridden(override).values).toStrictEqual({
      showProgress: false,
    });
  });

  it('keeps the budget values of a section that was taken over — and Verfügbarkeit either way', () => {
    const override = parseFormSettingsOverride({
      overridden: { budget: true },
      values: { maxResponses: 999, mailBudgetLimit: 4000 },
    });

    // Only what was offered — pruning keeps, it never fills in. The window
    // stays absent here and falls to the shipped constant at merge time. And
    // `maxResponses` survives because it belongs to *Verfügbarkeit*, which no
    // switch can lock.
    expect(pruneToOverridden(override).values).toStrictEqual({
      maxResponses: 999,
      mailBudgetLimit: 4000,
    });
  });

  it('leaves nothing behind when no section is taken over', () => {
    const override = parseFormSettingsOverride({
      overridden: {},
      values: { password: 'geheim' },
    });

    expect(pruneToOverridden(override).values).toStrictEqual({});
  });
});

describe('effectiveSettings — the two layers (regression)', () => {
  it('1 — the standard gets through: a section on tenant default follows the tenant', () => {
    // The stored document still carries values for the section — a client that
    // only flipped the switch, or an older write. They must not count: the
    // override *state* decides, not the presence of a value.
    const override = overrideOf({ confirm: false }, { redirectDelay: 9 });

    expect(effectiveSettings(tenantDefaults, override).redirectDelay).toBe(42);

    const changedTenant: TenantFormSettings = {
      ...tenantDefaults,
      redirectDelay: 7,
    };

    // The form was not touched, and it applies with the new value.
    expect(effectiveSettings(changedTenant, override).redirectDelay).toBe(7);
  });

  it('2 — a customised section does not follow the tenant', () => {
    const override = overrideOf({ confirm: true }, { redirectDelay: 9 });
    const before = effectiveSettings(tenantDefaults, override);

    // The organisation moves two values of that very section: one the form
    // states itself, and one it does not carry at all.
    const changedTenant: TenantFormSettings = {
      ...tenantDefaults,
      redirectDelay: 7,
      confirmTitle: 'Neuer Titel der Organisation',
    };

    expect(effectiveSettings(changedTenant, override)).toStrictEqual(before);
    expect(before.redirectDelay).toBe(9);
    // A key the override does not carry falls back to the **shipped** default,
    // not to the organisation's: the section is detached, so its gaps cannot be
    // filled from there without partly re-attaching it.
    expect(before.confirmTitle).toBe(SYSTEM_FORM_SETTINGS.confirmTitle);
  });

  it('leaves the other sections on the tenant standard', () => {
    const override = overrideOf({ confirm: true }, { redirectDelay: 9 });
    const effective = effectiveSettings(tenantDefaults, override);

    expect(effective.allowEdit).toBe(true);
    expect(effective.showProgress).toBe(false);
  });

  it('reads a taken-over section without any values as the shipped defaults', () => {
    // The document an API could write by flipping the switch alone. Not the
    // organisation's values: the section is detached, so its gaps come from the
    // shipped baseline.
    const override = overrideOf({ display: true }, {});
    const effective = effectiveSettings(tenantDefaults, override);

    expect(effective.showProgress).toBe(SYSTEM_FORM_SETTINGS.showProgress);
    expect(tenantDefaults.showProgress).not.toBe(
      SYSTEM_FORM_SETTINGS.showProgress,
    );
  });

  it('applies the tenant standard as a whole to an older form', () => {
    const effective = effectiveSettings(
      tenantDefaults,
      EMPTY_SETTINGS_OVERRIDE,
    );
    expect(effective).toMatchObject(tenantDefaults);
  });
});

/**
 * **„Verfügbarkeit" applies per form only** (ADR-0011, continuation
 * 2026-08-14; review finding 10).
 *
 * Opening period, deadline, time and participant limit decide whether a
 * form is open or closed. That is a property of *this*
 * form; prescribed organisation-wide it would close registrations nobody
 * has looked at.
 *
 * Four questions, and the middle two are the ones on which a
 * reintroduction „through the back door" would fail:
 *
 * 1. The values apply out of the form, without a switch.
 * 2. No value of the Organisation can move them — the type does not carry them.
 * 3. A stored document of an Organisation that does carry a deadline
 *    **does not** parse (fail closed), instead of letting it apply silently.
 * 4. `pruneToOverridden` does not throw them away — it would do so at the next
 *    save, for every deadline of the installation.
 */
describe('Verfügbarkeit — die einzige Einstellung ohne Vererbung', () => {
  it('applies from the form itself, with no section to switch', () => {
    const own = overrideOf({}, { closeAt: '2026-12-24T12:00:00Z' });
    const effective = effectiveSettings(tenantDefaults, own);

    expect(effective.closeAt).toBe('2026-12-24T12:00:00Z');
    // …and every switch stays off: there is nothing here to take over.
    expect(own.overridden).toStrictEqual(EMPTY_SETTINGS_OVERRIDE.overridden);
  });

  it('falls back to the shipped constant and to nothing else', () => {
    const effective = effectiveSettings(
      tenantDefaults,
      EMPTY_SETTINGS_OVERRIDE,
    );

    for (const key of AVAILABILITY_KEYS) {
      expect(effective[key]).toStrictEqual(SYSTEM_FORM_SETTINGS[key]);
    }
  });

  it('is not a key an organisation can even spell', () => {
    // The section map is what the merge walks; a deadline in it would be a
    // deadline the organisation could set.
    for (const section of SETTINGS_SECTIONS) {
      for (const key of AVAILABILITY_KEYS) {
        expect(SETTINGS_SECTION_KEYS[section]).not.toContain(key);
      }
    }
    expect(Object.keys(TENANT_SETTINGS_FLOOR)).not.toContain('closeAt');
  });

  it('makes an organisation document carrying a deadline fail to parse', () => {
    // Fail closed: a hand-written row, an import or a restore that puts a
    // deadline one layer up must not silently close every form of that
    // organisation — it must be unreadable and say so.
    expect(() =>
      parseTenantFormDefaults({ closeAt: '2026-12-24T12:00:00Z' }),
    ).toThrow();
  });

  it('survives the pruning that a save runs', () => {
    // The values belong to no section, so „drop what is not taken over" must
    // not reach them. It once would have — and the next save of every form in
    // the installation would have deleted its deadline.
    const own = overrideOf({}, { closeAt: '2026-12-24T12:00:00Z' });
    expect(pruneToOverridden(own).values.closeAt).toBe('2026-12-24T12:00:00Z');
  });
});

describe('setSectionOverride', () => {
  it('3 — switching to „Angepasst" copies the values that apply', () => {
    // Not a jump to the shipped defaults: the editor continues from what the
    // form was showing a second ago (handoff, Interactions).
    const next = setSectionOverride(
      tenantDefaults,
      EMPTY_SETTINGS_OVERRIDE,
      'confirm',
      true,
    );

    expect(next.overridden.confirm).toBe(true);
    expect(next.values.confirmTitle).toBe(tenantDefaults.confirmTitle);
    expect(next.values.redirectDelay).toBe(tenantDefaults.redirectDelay);
    expect(effectiveSettings(tenantDefaults, next)).toMatchObject(
      tenantDefaults,
    );
  });

  it('touches only its own section', () => {
    const customised = setSectionOverride(
      tenantDefaults,
      EMPTY_SETTINGS_OVERRIDE,
      'display',
      true,
    );
    const next = setSectionOverride(
      tenantDefaults,
      customised,
      'confirm',
      true,
    );

    expect(next.overridden).toStrictEqual({
      access: false,
      confirm: true,
      display: true,
      budget: false,
    });
    expect(next.values.showProgress).toBe(tenantDefaults.showProgress);
  });

  it('4 — switching back to „Tenant-Standard" discards the customised values', () => {
    const customised = setSectionOverride(
      tenantDefaults,
      EMPTY_SETTINGS_OVERRIDE,
      'confirm',
      true,
    );
    const edited: FormSettingsOverride = {
      ...customised,
      values: { ...customised.values, redirectDelay: 9 },
    };

    const back = setSectionOverride(tenantDefaults, edited, 'confirm', false);

    // Gone from the document, not kept quietly: the editor saw them disappear.
    expect(back.overridden.confirm).toBe(false);
    expect(Object.keys(back.values)).not.toContain('redirectDelay');
    for (const key of SETTINGS_SECTION_KEYS.confirm) {
      expect(back.values[key]).toBeUndefined();
    }
    expect(effectiveSettings(tenantDefaults, back).redirectDelay).toBe(
      tenantDefaults.redirectDelay,
    );

    // And a second switch-on starts from the tenant standard rather than
    // resurrecting a number nobody remembers entering.
    const again = setSectionOverride(tenantDefaults, back, 'confirm', true);
    expect(again.values.redirectDelay).toBe(tenantDefaults.redirectDelay);
  });

  it('keeps the values of the sections it does not touch', () => {
    const customised = setSectionOverride(
      tenantDefaults,
      EMPTY_SETTINGS_OVERRIDE,
      'display',
      true,
    );
    const withConfirm = setSectionOverride(
      tenantDefaults,
      customised,
      'confirm',
      true,
    );
    const back = setSectionOverride(
      tenantDefaults,
      withConfirm,
      'confirm',
      false,
    );

    expect(back.values.showProgress).toBe(tenantDefaults.showProgress);
    expect(back.overridden.display).toBe(true);
  });

  it('leaves Verfügbarkeit alone whichever section is flipped', () => {
    // The keys belong to no section, so no switch may copy them in or throw
    // them out — a form's deadline has to survive every take-over and every
    // hand-back of every other section.
    const own = overrideOf({}, { closeAt: '2026-12-24T12:00:00Z' });

    for (const section of SETTINGS_SECTIONS) {
      const on = setSectionOverride(tenantDefaults, own, section, true);
      const off = setSectionOverride(tenantDefaults, on, section, false);

      expect(on.values.closeAt).toBe('2026-12-24T12:00:00Z');
      expect(off.values.closeAt).toBe('2026-12-24T12:00:00Z');
    }
  });

  it('returns a new document instead of mutating the old one', () => {
    const before = structuredClone(EMPTY_SETTINGS_OVERRIDE);
    setSectionOverride(
      tenantDefaults,
      EMPTY_SETTINGS_OVERRIDE,
      'confirm',
      true,
    );

    expect(EMPTY_SETTINGS_OVERRIDE).toStrictEqual(before);
  });

  it('produces a document the override schema accepts', () => {
    const customised = setSectionOverride(
      tenantDefaults,
      EMPTY_SETTINGS_OVERRIDE,
      'access',
      true,
    );

    expect(overrideSchema.safeParse(customised).success).toBe(true);
  });
});

/**
 * The **delivery** gate for the redirect target.
 *
 * The schema above refuses a `javascript:` URL when a document is *parsed*;
 * these cover the second gate, the one that stands between a `FormSettings`
 * value and a browser being sent somewhere. It is a plain TypeScript type, so
 * the fixtures below are built by hand on purpose: that is exactly the state
 * the schema cannot vouch for — a value assembled in code, restored from a
 * backup through another path, or handed over by a caller that parsed with a
 * different version of this file.
 */
describe('effectiveRedirect', () => {
  const withRedirect = (patch: Partial<FormSettings>): FormSettings => ({
    ...SYSTEM_FORM_SETTINGS,
    redirectEnabled: true,
    redirectUrl: 'https://beispielverein.de/',
    redirectDelay: 5,
    ...patch,
  });

  it('hands out the configured target and its delay', () => {
    expect(
      effectiveRedirect(withRedirect({ redirectDelay: 12 })),
    ).toStrictEqual({
      url: 'https://beispielverein.de/',
      delaySec: 12,
    });
  });

  it('hands out nothing while the switch is off', () => {
    // The target survives the switch — the editor's value is not discarded —
    // so reading it regardless would redirect forms nobody meant to redirect.
    expect(
      effectiveRedirect(withRedirect({ redirectEnabled: false })),
    ).toBeNull();
  });

  it('hands out nothing without a target', () => {
    expect(effectiveRedirect(withRedirect({ redirectUrl: null }))).toBeNull();
  });

  it.each([
    ['javascript', 'javascript:alert(document.cookie)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['file', 'file:///etc/passwd'],
    ['not a URL at all', 'beispielverein.de'],
  ])('refuses to hand out a %s target', (_case, url) => {
    expect(effectiveRedirect(withRedirect({ redirectUrl: url }))).toBeNull();
  });

  it('normalises what it does hand out', () => {
    expect(
      effectiveRedirect(withRedirect({ redirectUrl: 'http:evil' }))?.url,
    ).toBe('http://evil/');
  });
});

/**
 * The *read* direction of the same rule („beim Ausliefern").
 *
 * A row written past the API — by hand, by a restore, by an older version —
 * must not become a `FormSettings` carrying a target a browser would follow.
 * These parse the stored shapes both surfaces use, so a refine dropped from
 * `externalUrlSchema` shows up here and not only in an API test.
 */
describe('a stored redirect target is checked on the way out', () => {
  it('refuses a tenant standard carrying a javascript: target', () => {
    expect(() =>
      parseFormSettings({
        ...completeSettings,
        redirectUrl: 'javascript:alert(1)',
      }),
    ).toThrow();
  });

  it('refuses a form override carrying a javascript: target', () => {
    expect(() =>
      parseFormSettingsOverride({
        overridden: { confirm: true },
        values: { redirectEnabled: true, redirectUrl: 'javascript:alert(1)' },
      }),
    ).toThrow();
  });

  /**
   * …and it refuses it even in a section the form has **not** taken over.
   *
   * That is the harsher of the two readings and the deliberate one: the values
   * of a dormant section do not apply, but they are one toggle away from
   * applying, and a document that stores a target nobody may follow is a
   * document that would start following it the moment somebody flips a switch.
   */
  it('refuses it in a section that is not even taken over', () => {
    expect(() =>
      parseFormSettingsOverride({
        overridden: { confirm: false },
        values: { redirectUrl: 'javascript:alert(1)' },
      }),
    ).toThrow();
  });
});

/**
 * **What a settings change does to the edit links that
 * are already out there.**
 *
 * The rule that carries the password gate across the edit route: the edit route hands
 * out the full field definition without asking for the access word, which is
 * only defensible while every token in circulation was issued behind the gate.
 * Switching the gate on afterwards is the case that breaks it, and it is the
 * *usual* case — an organisation sets the word the day the link leaks.
 */
describe('revokesEditLinks', () => {
  const off = parseFormSettings({ passwordEnabled: false, password: '' });
  const on = parseFormSettings({
    passwordEnabled: true,
    password: 'Jahrestagung2026',
  });
  const changed = parseFormSettings({
    passwordEnabled: true,
    password: 'Jahrestagung2027',
  });

  it('revokes when the protection is switched on', () => {
    expect(revokesEditLinks(off, on)).toBe(true);
  });

  it('revokes when the word is changed while the protection is on', () => {
    expect(revokesEditLinks(on, changed)).toBe(true);
  });

  it('does not revoke when the protection is switched off', () => {
    expect(revokesEditLinks(on, off)).toBe(false);
  });

  /**
   * The pair that separates „das Wort hat sich geändert" from „es schützt
   * etwas": a word typed into a form whose protection is off guards nothing, so
   * there is nothing to take back. Switching it on later is the first case.
   */
  it('does not revoke when the word changes while the protection is off', () => {
    const otherWord = parseFormSettings({
      passwordEnabled: false,
      password: 'Nebenbei',
    });
    expect(revokesEditLinks(off, otherWord)).toBe(false);
  });

  it('revokes when the protection is switched off and on again in one save', () => {
    // The same word as before, and it still revokes: „aus und wieder an" is
    // indistinguishable here from „an", and every token from the open phase in
    // between predates the gate.
    expect(revokesEditLinks(off, on)).toBe(true);
  });

  it('does not revoke when nothing about the access word moved', () => {
    // Through one named intermediate variable each, because `revokesEditLinks`
    // now only takes the two fields it reads ({@link AccessWordState}) — an
    // object literal with a third key would already be a type error, and what
    // is to be measured is the function's answer, not the compiler's.
    const otherTitle: FormSettings = { ...on, confirmTitle: 'Anders' };
    const otherEditing: FormSettings = { ...off, allowEdit: true };

    expect(revokesEditLinks(on, otherTitle)).toBe(false);
    expect(revokesEditLinks(off, otherEditing)).toBe(false);
  });
});

/**
 * **The minimum length sits in the write schema, not in
 * the storage schema.**
 *
 * The load-bearing test is the last one: a word stored before this rule existed
 * has to keep parsing. An unparseable settings document means *fail
 * closed*, so a bound in the storage schema would not reject an old word — it
 * would shut the form that word belongs to, and nobody in the organisation would have a
 * way back in. Moving the rule one schema down has to turn „ein kürzeres
 * gespeichertes Wort bleibt lesbar" red.
 */
describe('the access word an editor writes is bounded below', () => {
  const shortWord = 'kurz';

  it('refuses a word shorter than twelve characters and names the field', () => {
    const elevenCharacters = 'elfzeichen!';
    expect(elevenCharacters).toHaveLength(PASSWORD_MIN - 1);

    const result = formSettingsWriteSchema.safeParse({
      passwordEnabled: true,
      password: elevenCharacters,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toStrictEqual(['password']);
  });

  it('counts characters, not spaces', () => {
    expect(
      formSettingsWriteSchema.safeParse({ password: ' '.repeat(20) }).success,
    ).toBe(false);
  });

  it('accepts a long enough word and an empty one', () => {
    expect(
      formSettingsWriteSchema.safeParse({ password: 'Jahrestagung2026' })
        .success,
    ).toBe(true);
    // Empty means „kein Wort gesetzt" — the field exists whether or not the
    // protection is on, and refusing it here would make every write of the
    // section impossible for a form that has no password.
    expect(formSettingsWriteSchema.safeParse({ password: '' }).success).toBe(
      true,
    );
  });

  it('leaves a shorter *stored* word readable — every document that carries one', () => {
    // The old stock. `parseFormSettings` and `parseFormSettingsOverride` are
    // the only way a stored document becomes a `FormSettings`, so this is the
    // whole surface a legacy word has to survive.
    expect(
      parseFormSettings({ passwordEnabled: true, password: shortWord })
        .password,
    ).toBe(shortWord);
    expect(
      parseFormSettingsOverride({
        overridden: { access: true },
        values: { passwordEnabled: true, password: shortWord },
      }).values.password,
    ).toBe(shortWord);
    // The read side of the wire, too: the settings page hands the word back to
    // an editor who may read it out.
    expect(
      formSettingsPatchSchema.safeParse({ password: shortWord }).success,
    ).toBe(true);
  });
});

/**
 * **The form standards of an Organisation are a complete document**
 * (review finding 10) — no switch „Vorgabe ⇄ Angepasst" any more, and therefore
 * no locked section either.
 *
 * What the switch was once meant to achieve is now achieved by the *reading* of
 * the column: a missing key means „die Vorgabe der Anwendung"
 * (`fillTenantSettings`), so an Organisation that has never saved inherits
 * every later change of `SYSTEM_FORM_SETTINGS`.
 *
 * The question below it — what a *form* inherits from its Organisation — is
 * unchanged and stands in `effectiveSettings`; the one a running
 * application needs, in `apps/api/test/settings/tenant-sections.spec.ts`.
 *
 * **Counter-checks, measured while writing this block:**
 *
 * - `fillTenantSettings` returns the patch unchanged instead of laying it on
 *   the floor: „füllt die Lücken" red, because the document is then
 *   incomplete;
 * - the old wrapper `{ overridden, values }` allowed again: „weist die alte
 *   Hülle ab" red — and exactly that case is the one the migration physically
 *   removes from the world;
 * - `AVAILABILITY_MASK` taken out of the schema: „kann keine Frist speichern"
 *   red.
 */
describe('die Formular-Standards einer Organisation', () => {
  it('liest eine Organisation, die nie gespeichert hat, als die Vorgabe der Anwendung', () => {
    for (const stored of [{}, null, undefined]) {
      expect(parseTenantFormDefaults(stored)).toStrictEqual(
        TENANT_SETTINGS_FLOOR,
      );
    }
    // …and as a **copy** at that: whoever changes what was read must not
    // change what „nichts entschieden" means for everybody else.
    expect(parseTenantFormDefaults(null)).not.toBe(TENANT_SETTINGS_FLOOR);
  });

  it('füllt die Lücken einer Zeile aus der Vorgabe der Anwendung', () => {
    // A row that carries exactly one value — written by an older
    // version, by hand or out of a backup.
    const sparse = parseTenantFormDefaults({ mailBudgetLimit: 7 });

    expect(sparse.mailBudgetLimit).toBe(7);
    expect(sparse.mailBudgetWindowMin).toBe(
      SYSTEM_FORM_SETTINGS.mailBudgetWindowMin,
    );
    expect(sparse.confirmTitle).toBe(SYSTEM_FORM_SETTINGS.confirmTitle);
    // As a literal and not as `SYSTEM_FORM_SETTINGS.allowEdit`: checked
    // against the constant would mean „neu === neu" here and would stay green
    // even when the default turns. The default itself has a case of its own.
    expect(sparse.allowEdit).toBe(true);
    // Complete, not „as far as it was saved": every key of the
    // layer stands in it.
    expect(new Set(Object.keys(sparse))).toStrictEqual(
      new Set(Object.keys(TENANT_SETTINGS_FLOOR)),
    );
  });

  it('hält die eigenen Werte einer Organisation, die alles entschieden hat', () => {
    const complete = parseTenantFormDefaults({
      ...TENANT_SETTINGS_FLOOR,
      confirmTitle: 'Danke, Mitglied.',
      showProgress: false,
    });

    expect(complete.confirmTitle).toBe('Danke, Mitglied.');
    expect(complete.showProgress).toBe(false);
  });

  it('kann keine Frist speichern — die sieben Schlüssel der Verfügbarkeit sind nicht ihre', () => {
    const result = tenantFormDefaultsSchema.safeParse(
      Object.fromEntries(
        AVAILABILITY_KEYS.map((key) => [key, SYSTEM_FORM_SETTINGS[key]]),
      ),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
    });
  });

  it('weist „Passwortschutz ohne Passwort" ab', () => {
    // Every section applies now, so every rule inside it applies too — a
    // „nicht übernommen" under which a contradictory pair of values was
    // allowed to survive no longer exists here.
    expect(() => parseTenantFormDefaults({ passwordEnabled: true })).toThrow();
    expect(
      parseTenantFormDefaults({
        passwordEnabled: true,
        password: 'Jahrestagung2026',
      }).passwordEnabled,
    ).toBe(true);
  });

  it('weist einen Schlüssel ab, den keine Fassung dieser Anwendung kennt', () => {
    expect(() => parseTenantFormDefaults({ einstellungAusM9: true })).toThrow();
  });

  it('weist die alte Hülle „overridden/values" ab, statt sie zu deuten', () => {
    // Fail closed. A row in the shape of 2026-08-14 is one this version did
    // not write; to *read* it would mean guessing which section was
    // meant. The migration
    // `20260817120000_tenant_form_defaults_flat` rewrites it physically.
    expect(() =>
      parseTenantFormDefaults({
        overridden: { budget: true },
        values: { mailBudgetLimit: 7 },
      }),
    ).toThrow();
  });

  it('erreicht jedes Formular, das den Abschnitt nicht übernommen hat', () => {
    // The layer below is unchanged: what the Organisation decides
    // applies to every form that does not carry the section itself.
    const raised = parseTenantFormDefaults({ mailBudgetLimit: 5000 });
    expect(
      effectiveSettings(raised, EMPTY_SETTINGS_OVERRIDE).mailBudgetLimit,
    ).toBe(5000);

    const ownBudget = overrideOf({ budget: true }, { mailBudgetLimit: 9000 });
    expect(effectiveSettings(raised, ownBudget).mailBudgetLimit).toBe(9000);
  });
});

/**
 * **The mail budget's own section**, and the reason it needs one: it has to
 * survive a form or an organisation taking over an *unrelated* section, which
 * a field inside `avail` or `confirm` could not (Konzept no. 48's stated
 * failure mode).
 *
 * The inheritance itself is `effectiveSettings` — the same function, the same
 * rule, and no
 * special case for this section anywhere in them. What is asserted here is
 * that the rule actually reaches a *new* value through all three layers —
 * the sharpest probe there is — and that taking over a
 * different section leaves the budget untouched.
 */
describe('mailBudgetLimit / mailBudgetWindowMin', () => {
  it('defaults to 1000 mails per sliding hour', () => {
    expect(SYSTEM_FORM_SETTINGS.mailBudgetLimit).toBe(1000);
    expect(SYSTEM_FORM_SETTINGS.mailBudgetWindowMin).toBe(60);
  });

  it('is its own section, not part of Verfügbarkeit or Nach dem Absenden', () => {
    expect(SETTINGS_SECTIONS).toContain('budget');
    expect(SETTINGS_SECTION_KEYS.budget).toStrictEqual([
      'mailBudgetLimit',
      'mailBudgetWindowMin',
    ]);
    expect(AVAILABILITY_KEYS).not.toContain('mailBudgetLimit');
    expect(SETTINGS_SECTION_KEYS.confirm).not.toContain('mailBudgetLimit');
  });

  it('rejects a limit or a window of zero or less', () => {
    expect(
      firstIssuePath({ ...completeSettings, mailBudgetLimit: 0 }),
    ).toStrictEqual(['mailBudgetLimit']);
    expect(
      firstIssuePath({ ...completeSettings, mailBudgetWindowMin: 0 }),
    ).toStrictEqual(['mailBudgetWindowMin']);
  });

  it('rejects a limit or a window past its bound instead of trusting a typo', () => {
    expect(
      firstIssuePath({ ...completeSettings, mailBudgetLimit: 1_000_001 }),
    ).toStrictEqual(['mailBudgetLimit']);
    expect(
      firstIssuePath({
        ...completeSettings,
        mailBudgetWindowMin: 24 * 60 + 1,
      }),
    ).toStrictEqual(['mailBudgetWindowMin']);
  });

  it('has neither an enable switch nor a sentinel value for „unbegrenzt"', () => {
    // The specification forecloses "unbegrenzt" outright, not only as a default —
    // there is no key this section could carry that would express it, and a
    // document that tries fails to parse like any other unknown key.
    const result = settingsSchema.safeParse({
      ...completeSettings,
      mailBudgetEnabled: false,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['mailBudgetEnabled'],
    });
  });

  it('reaches through both layers — the sharpest probe', () => {
    // Organisation → form, none of it touched by the form: what the
    // organisation raised is what the form sees.
    const untouched = parseTenantFormDefaults({});
    expect(
      effectiveSettings(untouched, EMPTY_SETTINGS_OVERRIDE).mailBudgetLimit,
    ).toBe(SYSTEM_FORM_SETTINGS.mailBudgetLimit);

    const raisedTenant = parseTenantFormDefaults({ mailBudgetLimit: 5000 });
    expect(
      effectiveSettings(raisedTenant, EMPTY_SETTINGS_OVERRIDE).mailBudgetLimit,
    ).toBe(5000);

    // The form raises it further, on top of its own Organisation.
    const formOverride = overrideOf(
      { budget: true },
      { mailBudgetLimit: 9000 },
    );
    expect(effectiveSettings(raisedTenant, formOverride).mailBudgetLimit).toBe(
      9000,
    );
  });

  it('Konzept Nr. 48 — taking over an unrelated section does not lose the organisation’s raised budget', () => {
    // The failure mode this section is built to rule out: a form with its own
    // confirmation texts (`confirm`) must still see the organisation's raised
    // budget, because that value lives in a section of its own and `confirm`
    // cannot detach it. *Verfügbarkeit* cannot detach it either, and now for a
    // second reason: it is not a section at all any more.
    const raisedTenant = parseTenantFormDefaults({ mailBudgetLimit: 4000 });

    const ownDeadline = overrideOf({}, { openEnabled: true });
    expect(effectiveSettings(raisedTenant, ownDeadline).mailBudgetLimit).toBe(
      4000,
    );

    const ownConfirmation = overrideOf(
      { confirm: true },
      { confirmTitle: 'Eigener Titel' },
    );
    expect(
      effectiveSettings(raisedTenant, ownConfirmation).mailBudgetLimit,
    ).toBe(4000);
  });

  it('an organisation that has never decided its budget inherits the shipped one', () => {
    const untouched = parseTenantFormDefaults({});
    expect(untouched.mailBudgetLimit).toBe(
      SYSTEM_FORM_SETTINGS.mailBudgetLimit,
    );
  });
});

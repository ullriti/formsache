import { z } from 'zod';

/**
 * Form settings and their tenant inheritance.
 *
 * Two things live here and nowhere else:
 *
 * 1. **What a setting is** — the five sections of the handoff (plus
 *    *Versandbudget*) as one Zod schema with shipped defaults. Types come
 *    from `z.infer`, so a schema change cannot leave a hand-kept interface
 *    behind (`CONTRIBUTING.md`).
 * 2. **What applies** — `effectiveSettings()` is the *single* place where a
 *    tenant default and a form override become a value that counts. Everything
 *    that later enforces a rule (deadline, response limit, password) and every
 *    mail that is triggered reads the result of this one function. Without it,
 *    the public endpoint, the editor UI and the mail trigger would each answer
 *    "is this form open?" for themselves — the duplication this file exists
 *    to end.
 *
 * **Two layers, not three, and one section that has only one**
 * ([ADR-0011](../../../docs/architecture/0011-systemweite-einstellungen.md)):
 *
 * | Layer | Where it lives | What „not set" means |
 * |---|---|---|
 * | Organisation | `tenant.form_defaults` (per section) | {@link SYSTEM_FORM_SETTINGS}, the shipped constant |
 * | Form | `form.settings_override` (per section) | the organisation's standard |
 *
 * *Verfügbarkeit* ({@link AVAILABILITY_KEYS}) is the exception and sits **only**
 * on a form: an opening period, a deadline, a time limit and a participant
 * limit are properties of *this* form, and an organisation-wide default for
 * them makes no sense. The organisation's document cannot even spell those
 * keys ({@link TenantFormSettings}), so the rule is a typecheck rather than a
 * convention.
 *
 * **The merge is section-wise, not field-wise.** A section is customised as a
 * whole or not at all, which is exactly what the editor's toggle
 * "Tenant-Standard ↔ Angepasst" promises. Field-wise would make a tenant change
 * leak into a section a form has taken over — see the two merge tests that go
 * red when the section check is replaced by a field check.
 *
 * **The setting „Nur eine Antwort pro Person" (`onePerPerson`) does not exist.**
 * It was dropped by the client on 2026-07-27,
 * and dropping it means the key is *unknown*, not tolerated: a document
 * carrying it fails to parse. The handoff still shows the switch; that
 * difference is deliberate and recorded there. **„Bestätigung an Teilnehmer
 * senden" (`copyToSubmitter`) went the same way** on 2026-08-14 (review finding
 * 24): it was a second gate in front of the participant's mail, and whoever
 * sets up a notification addressed to the person filling the form in has
 * already decided that it goes out. The migration
 * `20260814120000_two_layer_form_settings` takes the key out of every stored
 * document and switches the affected notifications off, so „aus" stays „aus".
 */

/** Bounds on the admin-authored free text of a settings document. */
const TITLE_MAX = 200;
const MESSAGE_MAX = 2000;
/**
 * Longest access word a settings document may hold — **exported**, because the
 * public password gate has to bound the word a stranger offers
 * with the same number the editor was bounded by. A second literal there would
 * be a bound that can disagree with this one, and the one that disagrees is
 * always the one facing the internet.
 */
export const PASSWORD_MAX = 200;
/**
 * Shortest access word an **editor may write** .
 *
 * **Only the write path knows this number, and that is the whole decision.**
 * The bound sits in {@link formSettingsWriteSchema}, which validates what a
 * request carries — never in the storage schema, which also parses documents
 * that are *already stored*. A word saved before this rule existed has to keep
 * parsing: an unparseable settings document means *fail closed*, so
 * moving this check one schema down would not reject an old word, it would shut
 * the form it belongs to. This is stated explicitly: the load-bearing proof
 * is the old stock, not the rejection.
 */
export const PASSWORD_MIN = 12;

/**
 * Stands in for the access word wherever a code path has no business reading
 * it — the public fill-in path, and the settings page of a form opened by
 * somebody who may not manage the organisation's standards (ADR-0021).
 *
 * **Not the empty string**, and that is not cosmetic: this schema rejects
 * „Passwortschutz an" without a word, so blanking the field would turn a
 * password-protected form into a document that no longer parses — an
 * unreadable *form* instead of an unreadable *field*. The marker is non-empty
 * for that reason, and it carries a NUL byte for two more: nobody can type it,
 * so the public gate's comparison against a configured word cannot accidentally
 * succeed (`accessRequestSchema` refuses control characters outright, which is
 * what makes „unguessable by construction" true rather than merely likely) —
 * and PostgreSQL refuses U+0000 inside `jsonb`, so a redacted document that
 * ever found its way back into a write would fail loudly instead of quietly
 * replacing the real word with a placeholder.
 *
 * **It lives here, in the shared package, because it is on the wire.** The
 * redaction happens in the API (`apps/api/src/settings/settings-document.ts`),
 * but the value it writes travels to the browser inside `tenantDefaults` and
 * `effective` — and a client that does not know the marker renders it into the
 * *Zugangspasswort* field as the raw string it is. Two spellings of one
 * constant, one on each side of the connection, is the shape in which the
 * browser eventually shows a NUL byte to an editor.
 */
export const REDACTED_PASSWORD = '\u0000redacted';

/**
 * Wie lang eine Adresse werden darf, die jemand in ein Feld tippt.
 *
 * **Exportiert seit Review-Runde 5 (Nachtrag)** und aus demselben Grund wie
 * {@link safeExternalUrl} nebenan: der Rechtstext-Verweis
 * (`legal.ts`, `mode: 'link'`) braucht dieselbe Zahl, und zwei Schreibweisen
 * einer Obergrenze sind zwei, die auseinanderlaufen. Eine Adresse, die länger
 * ist, hat niemand abgetippt.
 */
export const EXTERNAL_URL_MAX = 2000;

/**
 * A time limit longer than a day is a limit nobody meant to set.
 *
 * Exported for the reason {@link REDIRECT_DELAY_MAX} is: the number now also
 * travels to strangers (`publicFormSchema.timeLimitMin`), and the public
 * contract bounds it with the **same** constant the settings are bounded with.
 * Two bounds for one value are two bounds that drift.
 */
export const TIME_LIMIT_MIN_MAX = 24 * 60;
/** Upper bound on the total response limit — larger numbers are typos. */
const MAX_RESPONSES_MAX = 1_000_000;
/**
 * Upper bound on the mail budget's count — larger numbers are typos, not events. Same order of
 * magnitude as {@link MAX_RESPONSES_MAX} and for the same reason: a bound
 * exists so a stray digit is rejected at the edge instead of becoming the
 * installation's new ceiling.
 *
 * Exported for the same reason {@link REDIRECT_DELAY_MAX} is: the bound the
 * server enforces on save has to be the number the editor's field shows as
 * `max`, or „auf den Höchstwert setzen" (*the* way to say „kein
 * Limit") is something an organisation can only find out by guessing and hitting a 400.
 */
export const MAIL_BUDGET_LIMIT_MAX = 1_000_000;
/**
 * Upper bound on the mail budget's window, in minutes.
 *
 * A day, for the same reason {@link TIME_LIMIT_MIN_MAX} is one: a *sliding*
 * window longer than that stops behaving like a rate limit and starts
 * behaving like a differently-spelled total — which is the response limit's
 * job, not this one's.
 *
 * Exported for the same reason {@link MAIL_BUDGET_LIMIT_MAX} is.
 */
export const MAIL_BUDGET_WINDOW_MIN_MAX = 24 * 60;
/**
 * Redirect countdown, in seconds — five minutes.
 *
 * Exported because the **wire** has to carry the same bound: `publicRedirectSchema`
 * (`public-form.ts`) re-validates the target a participant's browser will follow,
 * and a bound enforced only when a document is *saved* is no bound at all for a
 * value that arrives over the network. Without it `delaySec: 86_400` parsed
 * cleanly and the confirmation page counted down for a day.
 */
export const REDIRECT_DELAY_MAX = 300;

/**
 * A point in time, stored as a UTC instant (`2026-08-15T21:59:00Z`).
 *
 * The editor's input is a `datetime-local` field and therefore carries no zone
 * (design handoff). **The assumption (open point 1)
 * is applied at the edge, not here:** the UI converts its local input to an
 * instant (proposal `Europe/Berlin`), and what is stored is unambiguous — a
 * value without a zone would mean different things to the browser and to the
 * server clock it is compared against, daylight saving included.
 *
 * **Only `Z` is accepted, an explicit offset (`…+02:00`) is not.** Not because
 * an offset would be ambiguous — it would not — but so that the same instant
 * has exactly one spelling in the JSONB column: two spellings of one deadline
 * are two things to compare, to export and to explain.
 */
const utcInstantSchema = z.iso.datetime();

/**
 * A redirect target a stranger's browser will follow.
 *
 * `http`/`https` only: an editor is not an outsider, but `javascript:` plus a
 * configurable redirect on a page the public opens is stored XSS. The check
 * sits in the schema so it holds when the value is *saved* and again when it is
 * read back out of the database — `parseFormSettings` and
 * `parseFormSettingsOverride` are the only way a stored document becomes a
 * `FormSettings`, so a row written past the API (by hand, by an older version,
 * by a restore) fails to parse instead of being handed on.
 */
export const externalUrlSchema = z
  .string()
  .min(1)
  .max(EXTERNAL_URL_MAX)
  .refine((raw) => safeExternalUrl(raw) !== null, {
    error: 'Nur http- oder https-Adressen sind erlaubt.',
  })
  // Stored normalised (`http:evil` → `http://evil/`), because otherwise what
  // sits in the database is not what a browser follows — and the read path has
  // to be able to look at the stored value and say where it goes.
  //
  // The `.refine()` above has already rejected everything `safeExternalUrl`
  // answers `null` for, so the transform is only ever reached for a value it
  // normalises. A `?? raw` fallback used to stand here and could not fire; what
  // it *would* have done is let an unnormalisable target through under the
  // name of the checked one, which is the opposite of what this schema is for.
  .transform((raw) => {
    const normalised = safeExternalUrl(raw);
    if (normalised === null) {
      // Not a fallback: the refine above cannot have let this through, so
      // reaching it means the two disagree — and guessing at that point is how
      // a `javascript:` target would end up stored as „checked".
      throw new Error('externalUrlSchema: refine and transform disagree');
    }
    return normalised;
  });

/**
 * The normalised URL behind a redirect target, or `null` if it is not one any
 * surface of this application may send a browser to.
 *
 * Exported because the check is needed in three places that must not each own a
 * copy: the schema above (saving and reading a stored document), the delivery
 * gate {@link effectiveRedirect}, and the wire contract of the public
 * confirmation (`public-form.ts`).
 */
export function safeExternalUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  return parsed.href;
}

/**
 * *Verfügbarkeit* — when and how often the form can be filled in.
 *
 * **The one section without an inheritance**, and that is the decision of
 * review finding 10 (ADR-0011, continuation 2026-08-14). Whether a form is
 * open is a property of *that* form: its opening period, its deadline, its
 * time limit and participant limit. An organisation-wide „ab Montag
 * geschlossen" would be a switch that closes forms nobody looked at, and every
 * editor who ever needed one has set it on the form anyway.
 *
 * The keys therefore never appear in `tenant.form_defaults` and there is no
 * *Verfügbarkeit* switch on that page — see {@link AVAILABILITY_KEYS} for the
 * half of that rule the type system carries.
 */
const availFields = {
  openEnabled: z.boolean(),
  /** Opening instant, or null for „ab sofort". */
  openAt: utcInstantSchema.nullable(),
  /** Closing instant, or null for „ohne Ende". */
  closeAt: utcInstantSchema.nullable(),
  timeLimitEnabled: z.boolean(),
  timeLimitMin: z.number().int().positive().max(TIME_LIMIT_MIN_MAX),
  maxResponsesEnabled: z.boolean(),
  maxResponses: z.number().int().positive().max(MAX_RESPONSES_MAX),
};

/** *Zugriff & Sicherheit*. */
const accessFields = {
  passwordEnabled: z.boolean(),
  /**
   * The shared access word. Stored **encrypted** and readable again for
   * `can_manage_settings` (client decision 3) — it is a word an
   * editor reads out and passes on, not a user credential. The encryption
   * itself is the follow-up work item; this is the field it applies to.
   *
   * **Two consequences the encryption work item has to take along**, both of
   * them following from the section-wise inheritance rather than from this
   * field: taking the section over copies the word into the form's own
   * `settings_override` (`setSectionOverride`), so (a) *both* JSONB columns
   * carry a secret and both have to be encrypted, and (b) changing the word in
   * the tenant does not reach the forms that copied it — the old one keeps
   * opening them until each is changed.
   */
  password: z.string().max(PASSWORD_MAX),
  /**
   * *Zwischenspeichern* — **live**. It decides
   * three things and they are one rule read in three places: whether the public
   * read offers the button (`canSaveDraft` on the wire), whether the save route
   * accepts anything, and whether an address handed out last week still opens —
   * because the switch is evaluated on **every** access and not when the address
   * was minted (the rule stated for `allowEdit`).
   *
   * It arrived with no effect and invisible in the editor; that is why
   * this comment used to say „has no effect … so this is an additive change".
   *
   * **The shipped default has been `true` since 2026-08-17** — an
   * explicit product decision (review finding 16), and it reverses the
   * earlier one. Here it said „die Vorgabe bleibt `false`", because a `true` would
   * have pulled every existing form unasked into the storing of half-finished
   * personal data. The argument has not become
   * wrong, it has been **decided**: an intermediate state that is lost when
   * the browser is closed costs the person filling in more
   * than the retention period of the drafts (`draft-retention.ts`) demands
   * of them. Whoever does not want that for a form switches it off there;
   * whoever does not want it for a whole Organisation, in its form standards.
   *
   * What is user-visible about it does not stand in the dark: every form
   * that has **not** taken the section *Zugriff & Sicherheit* over itself
   * and whose Organisation has not decided it offers
   * „Zwischenspeichern" from this version on.
   */
  allowSaveDraft: z.boolean(),
  /**
   * *Bearbeiten nach Absenden* — read on **every** access, not at the
   * issuing of the address: a link from last week opens nothing any more
   * once the switch is off.
   *
   * **The shipped default has been `true` since 2026-08-17**, out of the same
   * product decision as with {@link allowSaveDraft} (review finding 16,
   * `CHANGELOG.md`) — and with the sharper price: whoever has the address
   * overwrites somebody else's answer without the change being attributed
   * to anybody. It bears that because the address itself is the secret
   * (an unguessable token, only in the confirmation and in the mail to the
   * person filling in), and because „ich habe mich vertippt" otherwise only goes
   * through the office. Whoever does not want that for a form switches it off
   * there; whoever does not want it for a whole Organisation, in its
   * form standards.
   */
  allowEdit: z.boolean(),
};

/** *Nach dem Absenden*. */
const confirmFields = {
  confirmTitle: z.string().min(1).max(TITLE_MAX),
  confirmMsg: z.string().min(1).max(MESSAGE_MAX),
  /*
   * **`copyToSubmitter` stood here and is gone** (review finding 24,
   * 2026-08-14). It was a second gate in front of the participant's mail: a
   * notification could be addressed to the person filling the form in, be
   * active, resolve an address — and still send nothing, because a switch in a
   * different section of a different page was off. The editor had to explain
   * that in three places (`NotificationEditor.tsx`), which is the symptom
   * rather than the fault. Setting up a notification to the submitter *is* the
   * decision that it goes out.
   *
   * Dropped means *unknown*, exactly as `onePerPerson` is: a stored document
   * carrying the key fails to parse. What keeps that from turning „aus" into
   * „geht jetzt raus" is the migration, not this schema — see the file header.
   */
  redirectEnabled: z.boolean(),
  /** null while no target has been entered. */
  redirectUrl: externalUrlSchema.nullable(),
  redirectDelay: z.number().int().nonnegative().max(REDIRECT_DELAY_MAX),
};

/** *Darstellung*. */
const displayFields = {
  showProgress: z.boolean(),
  showPageNumbers: z.boolean(),
  showRequiredHint: z.boolean(),
};

/**
 * *Versandbudget* — the ceiling on mails a form's mailer may send in a
 * sliding window.
 *
 * **Its own section, not a field of *Verfügbarkeit* or *Nach dem Absenden*,
 * and that placement is the load-bearing decision.** The
 * inheritance is section-wise: taking a section over detaches it from the
 * Organisation *as a whole*, and a gap in it falls to the *system* floor, never to
 * the organisation. Sitting the budget in either of those two sections would mean a
 * form with its own deadline (`avail`) or its own confirmation texts
 * (`confirm` — the section almost every form customises, because that is
 * where the notification switch lives) silently lost an organisation's raised budget
 * back down to the system default of 1000, at the one moment — Anmeldestart
 * — that a Jahrestagung with hundreds of registrations needs it raised. A
 * fifth section is the only placement under which taking over an unrelated
 * section cannot touch this one.
 *
 * **Neither an enable switch nor a sentinel value — a deliberate departure
 * from how `maxResponsesEnabled`/`maxResponses` and
 * `timeLimitEnabled`/`timeLimitMin` answer the same-shaped question.** Both
 * of those settings are legitimate business choices a form may opt out of
 * entirely ("kein Antwortlimit", "kein Zeitlimit"), and the toggle records
 * that choice as its own fact — the flaw named in an earlier work order is
 * that the toggle and the number can then drift apart, which is a real cost
 * this section does not have to pay: **Konzept explicitly forecloses
 * "unbegrenzt" for the mail budget**, not merely as a shipped default. Only
 * "raise it" is on the table ("je Organisation und je Formular anhebbar" — Konzept
 * never says "abschaltbar"), because a public form is a mailer
 * with a stranger-chosen recipient and this is that mailer's
 * one built-in abuse ceiling. A toggle would reopen exactly the door Konzept
 * closes, one layer down, for whichever Organisation or form switches it off
 * — and a sentinel (`0` or `-1` meaning "kein Limit") would smuggle the same
 * door back in under a number that stops meaning what it says. So there is
 * a third answer here, and it is the plainest one: two required, bounded,
 * always-active positive integers, the same shape {@link PASSWORD_MIN}/
 * {@link PASSWORD_MAX} give a bound with nothing to switch.
 */
const budgetFields = {
  /** Mails per window — 1000 by default, raisable, never off. */
  mailBudgetLimit: z.number().int().positive().max(MAIL_BUDGET_LIMIT_MAX),
  /**
   * The window's length in minutes — **sliding**, not "seit Beginn"
   * (exists for exactly that distinction).
   * The system default is 60; see {@link SYSTEM_FORM_SETTINGS}.
   */
  mailBudgetWindowMin: z
    .number()
    .int()
    .positive()
    .max(MAIL_BUDGET_WINDOW_MIN_MAX),
};

/**
 * The **inherited** sections — the unit the organisation ↔ form inheritance
 * works in, and therefore the unit that has a „Standard ↔ Angepasst" switch.
 *
 * *Verfügbarkeit* is deliberately **not** in this list. It is a section of the
 * editor's page like the four below, but it has no layer to inherit from and
 * no switch to flip; its keys are {@link AVAILABILITY_KEYS} and they always
 * come from the form itself. Leaving it in the enum „because the page shows
 * five cards" would put a switch into every document and every write path that
 * decides nothing — the kind of dead state a later reader has to guess the
 * meaning of.
 */
export const settingsSectionSchema = z.enum([
  'access',
  'confirm',
  'display',
  'budget',
]);
export type SettingsSection = z.infer<typeof settingsSectionSchema>;

export const SETTINGS_SECTIONS: readonly SettingsSection[] =
  settingsSectionSchema.options;

/**
 * A complete settings document.
 *
 * Strict: an unknown key is an error, not something to ignore. That is what
 * makes the dropped `onePerPerson` fail instead of travelling along as dead
 * weight, and it is what stops a typo (`maxResponse`) from looking saved while
 * the real setting keeps its old value.
 */
const completeSettingsSchema = z.strictObject({
  ...availFields,
  ...accessFields,
  ...confirmFields,
  ...displayFields,
  ...budgetFields,
});

/** The effective settings of a form — and the shape a tenant default has. */
export type FormSettings = z.infer<typeof completeSettingsSchema>;

/**
 * A settings document as it may be *stored*: every key may be missing.
 *
 * This is the shape of a form's override values and of a document written by
 * an earlier version. It is Zod's own partial type rather than
 * `Partial<FormSettings>`, because the two are not the same under
 * `exactOptionalPropertyTypes`: Zod's admits an explicitly written
 * `{ closeAt: undefined }`, `Partial<…>` does not — and a caller handing that
 * over should get the system default, not a type error at a seam that has
 * nothing to do with the question.
 */
export const partialSettingsSchema = completeSettingsSchema.partial();
export type PartialFormSettings = z.infer<typeof partialSettingsSchema>;

/**
 * What applies when nobody has decided anything.
 *
 * Nothing in here restricts, closes or promises: no deadline, no limits, no
 * password. The confirmation texts are the fixed ones the application first shipped
 * (`public-forms.service.ts`), so an older form keeps saying
 * what it said — this design makes the texts configurable, it does not change them.
 */
export const SYSTEM_FORM_SETTINGS: FormSettings = Object.freeze({
  openEnabled: false,
  openAt: null,
  closeAt: null,
  timeLimitEnabled: false,
  timeLimitMin: 30,
  maxResponsesEnabled: false,
  maxResponses: 250,

  passwordEnabled: false,
  password: '',
  // On, ex works (review finding 16) — the reasoning stands at the field itself.
  allowSaveDraft: true,
  allowEdit: true,

  confirmTitle: 'Vielen Dank!',
  confirmMsg:
    'Die Antwort wurde übermittelt. Diese Seite kann jetzt geschlossen werden.',
  redirectEnabled: false,
  redirectUrl: null,
  redirectDelay: 5,

  showProgress: true,
  showPageNumbers: true,
  showRequiredHint: true,

  // Measured against "400 Anmeldungen in zwei Stunden müssen
  // durchgehen", never against "unbegrenzt": 1000 mails per form and sliding
  // hour.
  mailBudgetLimit: 1000,
  mailBudgetWindowMin: 60,
  // Frozen, and not out of tidiness: this object is read on every request in a
  // long-lived server process. A single stray assignment would change what
  // „no deadline" means for every tenant at once, silently and until restart.
});

/**
 * The seven settings the **organisation's layer deliberately does not carry** —
 * *Verfügbarkeit* (ADR-0011, continuation 2026-08-14; review finding 10).
 *
 * Derived from {@link availFields}, never written out a second time: a field
 * added to *Verfügbarkeit* is a field the organisation's document must not be
 * able to carry either, and a hand-kept list is one that would be forgotten
 * exactly then.
 *
 * **Declared here, above every module-level value that uses it.**
 * {@link TENANT_SETTINGS_FLOOR} calls {@link omitAvailabilityKeys} while this
 * module initialises, so a `const` further down would be in its temporal dead
 * zone and every importer of this file would fail to load.
 */
export const AVAILABILITY_KEYS: readonly (keyof FormSettings)[] =
  keysOf(availFields);

/** @see AVAILABILITY_KEYS */
export type AvailabilityKey = keyof typeof availFields;

/**
 * The same list once more, as the mask `.omit()` takes — Zod wants an object,
 * not an array, and this is the one place that difference is spelled out.
 *
 * Written as a literal because a mask built at runtime loses the *type* the
 * omission is worth having (`TenantFormSettings` would collapse back to
 * `Partial<…>`). The test „an organisation cannot store a deadline" holds it to
 * {@link AVAILABILITY_KEYS}, so the two spellings cannot drift apart unnoticed.
 */
const AVAILABILITY_MASK = {
  openEnabled: true,
  openAt: true,
  closeAt: true,
  timeLimitEnabled: true,
  timeLimitMin: true,
  maxResponsesEnabled: true,
  maxResponses: true,
} as const;

/** The same list as a set — see {@link AVAILABILITY_KEYS}. */
const AVAILABILITY_KEY_SET: ReadonlySet<string> = new Set(AVAILABILITY_KEYS);

/**
 * What an **organisation** may decide — `FormSettings` minus *Verfügbarkeit*.
 *
 * A type rather than a convention on purpose: „eine Organisation kann keine
 * Frist vorgeben" is then checked by `pnpm typecheck` at every seam that passes
 * one, not by a reviewer reading a write path. It is the same shape the earlier
 * three-layer design gave the system row for the access word, used here for the
 * one distinction that is left.
 */
export type TenantFormSettings = Omit<FormSettings, AvailabilityKey>;

/**
 * What an organisation that has decided **nothing** stands for — the shipped
 * constant without the keys its layer does not carry.
 *
 * The *floor*, not the layer itself: an organisation that has saved once
 * carries its own complete document ({@link parseTenantFormDefaults}), and this
 * is what the gaps of one that has not are filled from
 * ({@link fillTenantSettings}).
 */
export const TENANT_SETTINGS_FLOOR: TenantFormSettings = Object.freeze(
  omitAvailabilityKeys(SYSTEM_FORM_SETTINGS),
);

/** {@link AVAILABILITY_KEYS} dropped from a complete document. */
export function omitAvailabilityKeys(
  settings: FormSettings,
): TenantFormSettings {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!AVAILABILITY_KEY_SET.has(key)) {
      rest[key] = value;
    }
  }
  // Safe: `settings` is complete and exactly the keys of `AVAILABILITY_KEYS`
  // are left out — which is what the target type omits. Driven off that one
  // list rather than off seven literals here, so the decision has a single
  // spelling (`form-settings.test.ts` asserts it against the section map).
  return rest as TenantFormSettings;
}

/**
 * Which key belongs to which section — **derived from the schema**, not
 * written out a second time.
 *
 * The prototype keeps this list by hand (`secKeys()`), and a hand-kept list is
 * one a new setting can be left out of: it would then silently inherit
 * "unassigned" and be merged by nobody. Deriving it means a new field is added to
 * one of the four shapes above and the merge covers it.
 */
function keysOf(shape: object): readonly (keyof FormSettings)[] {
  // Safe: the four shapes are the object literal `completeSettingsSchema` is
  // built from, so every key of a shape is a key of `FormSettings`. The test
  // „assigns every setting to exactly one section" holds this to it.
  return Object.keys(shape) as (keyof FormSettings)[];
}

export const SETTINGS_SECTION_KEYS: Record<
  SettingsSection,
  readonly (keyof FormSettings)[]
> = {
  access: keysOf(accessFields),
  confirm: keysOf(confirmFields),
  display: keysOf(displayFields),
  budget: keysOf(budgetFields),
};

/**
 * The rules that need more than one field, applied to a **complete** set.
 *
 * Written once and used by both schemas below: the tenant default validates its
 * whole document, the form override validates the document it *would* apply —
 * its own values on top of the system defaults. Otherwise an override could
 * store „Passwortschutz an" without a password and only fail when a participant
 * stands in front of it.
 *
 * `scope` is what keeps that from overreaching. An override may carry values for
 * a section it has *not* taken over (the prototype writes a full value set
 * either way), and those values do not apply — rejecting the document for them
 * would make a row nobody can read any more. Every rule below spans fields of
 * one section only, so filtering per key is the right grain.
 */
export function checkSettingsConsistency(
  values: FormSettings,
  ctx: z.RefinementCtx,
  options: {
    readonly prefix?: readonly string[];
    readonly scope?: ReadonlySet<string>;
  } = {},
): void {
  const complain = (key: keyof FormSettings, message: string): void => {
    if (options.scope && !options.scope.has(key)) {
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: [...(options.prefix ?? []), key],
      message,
    });
  };

  if (values.openAt !== null && values.closeAt !== null) {
    // Checked regardless of `openEnabled`: the values outlive the switch, and a
    // window that ends before it starts is one nobody can fill in — including
    // the moment somebody flips the switch back on.
    if (Date.parse(values.closeAt) <= Date.parse(values.openAt)) {
      complain('closeAt', '„Schließt am" muss nach „Öffnet am" liegen.');
    }
  }

  if (values.passwordEnabled && values.password.trim().length === 0) {
    // Trimmed: a word of spaces is no protection, and it is unusable as
    // something an editor reads out and passes on.
    complain('password', 'Passwortschutz ohne Passwort ist kein Schutz.');
  }

  if (values.redirectEnabled && values.redirectUrl === null) {
    complain('redirectUrl', 'Weiterleitung ohne Ziel-URL.');
  }
}

/** A partial document with `undefined` entries removed, on top of a base. */
function withValues(
  base: FormSettings,
  patch: PartialFormSettings,
  keys: readonly (keyof FormSettings)[],
): FormSettings {
  const result: Record<string, unknown> = { ...base };
  for (const key of keys) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // Safe: `result` starts out complete and every assignment takes the value
  // `patch` holds under that very key, whose type is the field's type.
  return result as FormSettings;
}

/**
 * A partial document without its `undefined` entries.
 *
 * Needed because `exactOptionalPropertyTypes` makes `{ closeAt: undefined }` and
 * „no `closeAt`" two different things, while JSON and every writer of a patch
 * treat them as one. Spreading a patch onto stored values without this would
 * either not compile or would store an explicit `undefined` — and an
 * `undefined` in the override document is a key that *exists* and carries
 * nothing, which the merge would then have to interpret.
 *
 * It lives here rather than in the API for the reason the whole file exists:
 * a second copy is a second answer. `withValues` above does the same filtering
 * against a fixed key list; this is the same rule for a document whose keys are
 * whatever the writer sent.
 */
export function definedOnly(patch: PartialFormSettings): PartialFormSettings {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // Safe: every entry is copied under its own key from a value of that key's
  // type, and the `undefined` ones — the only members the target type would
  // otherwise have to admit — are exactly the ones left out.
  return result;
}

/**
 * Every key of a settings document — the four inherited sections **and**
 * *Verfügbarkeit*, which belongs to no section map because it inherits from
 * nobody.
 */
const ALL_SETTINGS_KEYS: readonly (keyof FormSettings)[] = [
  ...AVAILABILITY_KEYS,
  ...SETTINGS_SECTIONS.flatMap((section) => SETTINGS_SECTION_KEYS[section]),
];

/**
 * Fill the gaps of a stored document from the shipped constant.
 *
 * „Ein fehlender Schlüssel heißt: nichts entschieden" is written here once and
 * used by every schema below, so a document read back out of the database and a
 * document on its way in cannot disagree about what an absence means.
 */
export function fillSettings(patch: PartialFormSettings): FormSettings {
  return withValues(SYSTEM_FORM_SETTINGS, patch, ALL_SETTINGS_KEYS);
}

/**
 * A stored **complete** settings document, read against the shipped constant.
 *
 * **A missing key falls back to the shipped constant, not to `undefined`.** A
 * document written by an earlier version has to keep parsing into something
 * every comparison can be run against; otherwise a missing deadline is not "no
 * deadline" but a crash at the moment a participant submits.
 * An *unknown* key is the opposite case and stays an error.
 *
 * The alternative shape — have the parsers hand out the *partial* document and
 * let `effectiveSettings` do all filling — was rejected because `FormSettings`
 * is complete by contract on the wire (`tenantDefaults`, `effective`),
 * in `availabilityOf` and in every enforcement path; making it partial would
 * push the question „and what if this key is missing?" into two dozen call
 * sites instead of answering it once, here.
 *
 * **This is a read/replace schema, not a patch schema.** It answers "what does
 * this stored document mean" and therefore returns a *complete* set. Feeding a
 * partial write through it and storing the result would reset every field the
 * writer did not mention back to the shipped constant — use
 * `formSettingsPatchSchema` together with `mergeSettings` for that.
 */
export const formSettingsSchema: z.ZodType<FormSettings> = partialSettingsSchema
  .superRefine((values, ctx) => {
    checkSettingsConsistency(fillSettings(values), ctx);
  })
  .transform((values) => fillSettings(values));

/**
 * A settings document that is **already complete** — what a server response
 * carries and what a merged write produces.
 *
 * Separate from {@link formSettingsSchema} on purpose: there is no gap to fill
 * here, so a schema that would silently complete a truncated document from the
 * shipped constant would hide exactly the case this one exists to catch. A
 * client that receives fewer keys than promised now hears about it.
 */
export const completeFormSettingsSchema = completeSettingsSchema.superRefine(
  (values, ctx) => {
    checkSettingsConsistency(values, ctx);
  },
);

/**
 * A settings document of an **organisation** that is already complete — what a
 * server response carries for the four inherited sections.
 *
 * {@link completeFormSettingsSchema} minus *Verfügbarkeit*, so a client that
 * receives fewer keys than promised hears about it, and one that receives a
 * deadline in an organisation's document hears about that too.
 */
export const completeTenantSettingsSchema: z.ZodType<TenantFormSettings> =
  completeSettingsSchema.omit(AVAILABILITY_MASK).superRefine((values, ctx) => {
    // Judged on the document it would apply as: the rules span fields, and the
    // ones that could fire here (the access word, the redirect target) are all
    // inside the four sections this document has.
    checkSettingsConsistency(fillSettings(values), ctx);
  });

/**
 * A partial settings document of an organisation — its own values, and never
 * those of *Verfügbarkeit*.
 */
export const tenantSettingsPatchSchema =
  partialSettingsSchema.omit(AVAILABILITY_MASK);

/**
 * A partial settings document as it travels — a stored override's `values`, a
 * form's own values on the way back to the editor.
 *
 * Validates each field it carries and says nothing about the ones it does not.
 * **Deliberately without the minimum length of {@link PASSWORD_MIN}:** this
 * schema is on the *read* side too, and a word stored before this bound
 * existed has to keep parsing. The bound lives in
 * {@link formSettingsWriteSchema}.
 */
export const formSettingsPatchSchema = partialSettingsSchema;

/**
 * An access word **as a request offers it** .
 *
 * Empty stays allowed and means „kein Wort gesetzt": the section carries the
 * field whether or not the protection is on, and `checkSettingsConsistency` is
 * what refuses „Passwortschutz an" without a word. Trimmed before counting, for
 * the same reason that rule trims — twelve spaces are not twelve characters of
 * protection.
 */
const writtenPasswordSchema = z
  .string()
  .max(PASSWORD_MAX)
  .refine((raw) => raw.length === 0 || raw.trim().length >= PASSWORD_MIN, {
    error: `Das Zugangswort muss mindestens ${String(PASSWORD_MIN)} Zeichen lang sein.`,
  });

/**
 * A partial settings document **on its way in** .
 *
 * The same shape as {@link formSettingsPatchSchema} with one bound added: an
 * access word an editor *writes* has to be at least {@link PASSWORD_MIN}
 * characters. Everything a request carries goes through this; nothing that is
 * merely *read back* does.
 */
export const formSettingsWriteSchema = partialSettingsSchema.extend({
  password: z.optional(writtenPasswordSchema),
});

/**
 * The same, **as an organisation's page may write it** — without
 * *Verfügbarkeit*.
 *
 * The narrowing belongs on the way in and not only in the storage schema: a
 * request that names `closeAt` on the organisation's standards is a client that
 * believes in a setting this application no longer has, and it should hear
 * „unbekanntes Feld" at the edge instead of having the value quietly dropped by
 * the pruning and then rediscovered as missing.
 */
export const tenantSettingsWriteSchema =
  formSettingsWriteSchema.omit(AVAILABILITY_MASK);

/**
 * Apply a partial write to a stored document.
 *
 * The result still has to go through {@link completeFormSettingsSchema} before
 * it is stored: the cross-field rules („Passwortschutz an" without a password)
 * can only be decided on the merged document, not on the patch.
 *
 * **A patch can only move a value the document already has.** For a complete
 * `FormSettings` that is every key and the rule is invisible; for a
 * {@link TenantFormSettings} it is what keeps an editor's patch from putting a
 * deadline into a document that has no *Verfügbarkeit* — the same guarantee the
 * schema gives one layer down, applied where the two pages share this function.
 *
 * `undefined` is dropped, `null` is not: for `openAt`, `closeAt` and
 * `redirectUrl`, `null` is a *value* („keine Frist", „kein Weiterleitungsziel"),
 * and a `??` here once put a cleared deadline straight back on screen.
 */
export function mergeSettings<T extends Partial<FormSettings>>(
  stored: T,
  patch: PartialFormSettings,
): T {
  const result: Record<string, unknown> = { ...stored };
  for (const key of Object.keys(stored) as (keyof FormSettings)[]) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // Safe: every assignment takes the value `patch` holds under a key `stored`
  // already has, and that value has the type the key declares.
  return result as T;
}

/**
 * Which sections a form has taken over from its tenant.
 *
 * Four, not five: *Verfügbarkeit* has no layer to be taken over *from*
 * ({@link AVAILABILITY_KEYS}), so a switch for it would be a stored fact that
 * decides nothing. A document written before 2026-08-14 carries one anyway and
 * fails to parse — which is why the migration takes the key out of every row
 * rather than leaving the schema to tolerate it.
 */
export const settingsOverriddenSchema = z.strictObject({
  access: z.boolean().prefault(false),
  confirm: z.boolean().prefault(false),
  display: z.boolean().prefault(false),
  budget: z.boolean().prefault(false),
});
export type SettingsOverridden = z.infer<typeof settingsOverriddenSchema>;

/**
 * The *shape* of an override document, without the cross-field rules.
 *
 * Split out so {@link FormSettingsOverride} stays a `z.infer` of one schema
 * (`CONTRIBUTING.md` — never a schema and an interface side by side) while the
 * validating schema adds rules that only mean something for a *whole*
 * document.
 *
 * **Exported's Nacharbeit**, because there is a second document that carries
 * an override: the content of a form template (`form-templates.ts`). The split
 * this constant stands for is exactly the one that case needs — *shape* (which
 * keys exist and what type they have) is a property of the document alone,
 * while the cross-field rules only mean something for the sections that
 * actually apply.
 */
export const formSettingsOverrideShape = z.strictObject({
  overridden: settingsOverriddenSchema.prefault({}),
  values: partialSettingsSchema.prefault({}),
});

/**
 * A form's `settings_override`.
 *
 * **The override state is modelled separately from the value** (* `ov`/`v` in the prototype). Reading "is this section customised?" off the
 * values — say, by comparing them against the tenant's — would make the answer
 * depend on a coincidence: a form that deliberately sets the same deadline its
 * tenant happens to have would silently start following the tenant again.
 *
 * `values` stays **as it was written**: partial. It is not padded out with
 * shipped defaults at parse time, because then the override document would
 * claim values its editor never set, and the merge below would no longer be the
 * only place where a default enters the picture.
 *
 * **The scope of the cross-field rules is what this schema adds.** They span
 * fields, so they can only be judged on a *complete* document — the document's
 * own values on top of the shipped constant — and they may only be *applied*
 * where the values count: in a section the form has taken over, and in
 * *Verfügbarkeit*, which always counts because it is the form's own
 * ({@link AVAILABILITY_KEYS}).
 */
export const formSettingsOverrideSchema: z.ZodType<FormSettingsOverride> =
  formSettingsOverrideShape
    // The consistency rules are checked here rather than on `values` alone,
    // because whether a value has to make sense depends on whether its section
    // applies at all — and only this level knows both.
    .superRefine(({ overridden, values }, ctx) => {
      const scope = new Set<string>(AVAILABILITY_KEYS);
      for (const section of SETTINGS_SECTIONS) {
        if (overridden[section]) {
          for (const key of SETTINGS_SECTION_KEYS[section]) {
            scope.add(key);
          }
        }
      }

      checkSettingsConsistency(fillSettings(values), ctx, {
        prefix: ['values'],
        scope,
      });
    });

export type FormSettingsOverride = z.infer<typeof formSettingsOverrideShape>;

/**
 * A form that has never had its settings touched: all four inherited sections
 * follow the tenant, and *Verfügbarkeit* is what the shipped constant says.
 *
 * This is what an untouched form means — no backfill, no migration
 * of existing rows, the absence *is* the meaning. `budget` is younger
 * than the other three but reads exactly the same way: a form that has never
 * had its settings touched has not taken *that* section over either.
 */
export const EMPTY_SETTINGS_OVERRIDE: FormSettingsOverride = Object.freeze({
  overridden: Object.freeze({
    access: false,
    confirm: false,
    display: false,
    budget: false,
  }),
  values: Object.freeze({}),
});

/**
 * Parse a **complete** stored settings document.
 *
 * **An absent document reads as "nothing decided yet"**, the same way an absent
 * override does. Making every caller remember `?? {}` would be a rule that
 * holds until the first one forgets.
 *
 * **This is not how an organisation's `form_defaults` is read.** That column
 * carries no *Verfügbarkeit* and is read through
 * {@link parseTenantFormDefaults}; what is left here is the plain „ein
 * vollständiges Dokument, gelesen gegen die Vorgabe" that the tests of the two
 * documents are written against.
 */
export function parseFormSettings(source: unknown): FormSettings {
  if (source === null || source === undefined) {
    return { ...SYSTEM_FORM_SETTINGS };
  }
  return formSettingsSchema.parse(source);
}

/**
 * Parse a stored `settings_override`. A missing column means "all four
 * inherited sections on tenant default, Verfügbarkeit as shipped" — an
 * untouched form is not a broken document.
 */
export function parseFormSettingsOverride(
  source: unknown,
): FormSettingsOverride {
  if (source === null || source === undefined) {
    // A copy, not the shared constant: a caller that edits what it parsed must
    // not be able to change what „untouched" means for every other form.
    return structuredClone(EMPTY_SETTINGS_OVERRIDE);
  }
  return formSettingsOverrideSchema.parse(source);
}

// ---------------------------------------------------------------------------
// An organisation's form standards — one complete document
// ---------------------------------------------------------------------------

/**
 * Every key an organisation's document carries — the four inherited sections,
 * and never *Verfügbarkeit* ({@link AVAILABILITY_KEYS}).
 *
 * Derived from the section map for the reason that map is derived from the
 * schema: a setting added to one of the four shapes has to become part of an
 * organisation's document without anybody remembering a second list.
 */
const TENANT_SETTINGS_KEYS: readonly (keyof TenantFormSettings)[] =
  SETTINGS_SECTIONS.flatMap(
    (section) => SETTINGS_SECTION_KEYS[section],
  ) as (keyof TenantFormSettings)[];

/** An organisation's own values as they may be *stored* or *written*: partial. */
export type PartialTenantFormSettings = z.infer<
  typeof tenantSettingsPatchSchema
>;

/**
 * Fill the gaps of an organisation's document from the shipped constant —
 * {@link fillSettings} for the narrower document.
 *
 * The one place „ein fehlender Schlüssel heißt: die Vorgabe der Anwendung" is
 * decided for this layer, so a row written by an older version, a row written
 * by hand and a row this application has just saved all mean the same thing.
 */
export function fillTenantSettings(
  patch: PartialTenantFormSettings,
): TenantFormSettings {
  const result: Record<string, unknown> = { ...TENANT_SETTINGS_FLOOR };
  for (const key of TENANT_SETTINGS_KEYS) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  // Safe: the base is complete and every assignment takes the value `patch`
  // holds under that very key, whose type is the field's type.
  return result as TenantFormSettings;
}

/**
 * An organisation's stored `form_defaults` — **a complete set of values,
 * always**, and no switch beside it any more (review finding 10).
 *
 * ## Why the state beside the value is gone
 *
 * Until 2026-08-17 this column carried `{ overridden, values }`: one switch
 * „Vorgabe ⇄ Angepasst" per section, exactly as on the form. On the form this
 * switch says something — „follow the Organisation" against „decide for
 * yourself" —, and both sides are reachable and both are explainable. One layer
 * further down it said nothing any more: below the Organisation lies no second
 * administration but the values this application is shipped with. That an
 * application has default values is the normal case and no state one
 * administers — the switch locked fields for that which an Organisation admin
 * wanted to change, and the page had to explain in four hint lines why.
 *
 * What is **not** lost thereby: the application's default is still
 * what a missing key means ({@link fillTenantSettings}). An
 * Organisation that has never saved carries `{}` and thereby inherits every
 * later change of {@link SYSTEM_FORM_SETTINGS} — the point the
 * switches were once meant to save hangs on the *reading* of the column and
 * never on the switch. As soon as it saves once, its set stands complete in
 * the row, and that is the intended direction: it has seen the values and
 * kept them.
 *
 * **On the form the switch stays** ({@link formSettingsOverrideSchema}) —
 * there is a layer below it there that it means.
 */
export const tenantFormDefaultsSchema: z.ZodType<TenantFormSettings> =
  tenantSettingsPatchSchema
    .superRefine((values, ctx) => {
      // Judged on the document it would apply as: the rules span fields, and
      // every rule that can fire here (the access word, the redirect target)
      // sits inside the four sections this document has.
      checkSettingsConsistency(fillSettings(values), ctx);
    })
    .transform((values) => fillTenantSettings(values));

/**
 * Parse a stored `tenant.form_defaults`.
 *
 * An absent column — and an organisation that has never saved — means „die
 * Vorgabe der Anwendung", spelled out as a complete document so that no caller
 * has to ask „und wenn der Schlüssel fehlt?" a second time.
 *
 * **A row in the old `{ overridden, values }` shape fails to parse**, and that
 * is the *fail closed* direction: the migration
 * `20260817120000_tenant_form_defaults_flat` rewrites every one of them into
 * this shape physically, so a document that still carries the wrapper is one
 * this application did not write.
 */
export function parseTenantFormDefaults(source: unknown): TenantFormSettings {
  if (source === null || source === undefined) {
    // A copy, not the shared constant — a caller that edits what it parsed must
    // not be able to change what „nichts entschieden" means for everybody else.
    return { ...TENANT_SETTINGS_FLOOR };
  }
  return tenantFormDefaultsSchema.parse(source);
}

/**
 * What actually applies to a form — the one place the two layers become a
 * value.
 *
 * Section by section: a section the form has taken over is read from the
 * override, everything else from the tenant's current standard. That is why a
 * tenant changing its default reaches every form that has *not* taken the
 * section over, without any of them being touched — and why it reaches none
 * that has.
 *
 * Inside a taken-over section, a key the override does not carry falls back to
 * the **shipped constant**, not to the tenant's value: the section is detached
 * from the tenant, so its gaps cannot be filled from there without partly
 * re-attaching it.
 *
 * **`Verfügbarkeit` is not part of that at all** (review finding 10): its keys
 * come from this form's own values, filled from the shipped constant, and there
 * is no `tenantDefaults` to consult — the type has no such keys. A deadline is
 * a property of one form, and this loop is where that stops being a sentence
 * and becomes the mechanism.
 */
export function effectiveSettings(
  tenantDefaults: TenantFormSettings,
  override: FormSettingsOverride,
): FormSettings {
  const result: Record<string, unknown> = {};

  for (const section of SETTINGS_SECTIONS) {
    const keys = SETTINGS_SECTION_KEYS[section];
    // The one section-wise decision. Replacing it with a per-field test is the
    // mistake the negative probe describes.
    //
    // Read as a bare record, because the two branches are two *different*
    // complete sets — a form's document has the availability keys, an
    // organisation's cannot ({@link TenantFormSettings}) — and the keys walked
    // here belong to neither difference.
    const source: Record<string, unknown> = override.overridden[section]
      ? withValues(SYSTEM_FORM_SETTINGS, override.values, keys)
      : tenantDefaults;

    for (const key of keys) {
      result[key] = source[key];
    }
  }

  // No switch and no fallback layer: the form's own values on top of the
  // shipped constant, always.
  const availability = withValues(
    SYSTEM_FORM_SETTINGS,
    override.values,
    AVAILABILITY_KEYS,
  );
  for (const key of AVAILABILITY_KEYS) {
    result[key] = availability[key];
  }

  // Safe: every key of `FormSettings` belongs to exactly one section or to
  // `AVAILABILITY_KEYS` (both derived from the same field shapes), and each is
  // copied from a complete set — asserted in the tests.
  return result as FormSettings;
}

/**
 * The two fields {@link revokesEditLinks} looks at, and nothing else.
 *
 * Narrower than `FormSettings` on purpose: the rule is asked on a form's
 * effective settings **and** on an organisation's standard, and those are two
 * different complete types since *Verfügbarkeit* stopped existing one layer up
 * ({@link TenantFormSettings}). Naming what the rule actually reads is what
 * lets both be passed without a cast that would also let anything else through.
 */
export type AccessWordState = Pick<
  FormSettings,
  'passwordEnabled' | 'password'
>;

/**
 * Whether moving from `before` to `after` has to **revoke the addresses a
 * participant is holding** .
 *
 * The edit route deliberately does not ask for the access word again —
 * the link is a stronger capability than the word and travels in a mail that
 * carries no word. That holds only as long as every token in circulation was
 * issued *behind* the gate. It is not automatic: a form that was open and
 * unprotected hands out tokens, and switching the protection on afterwards —
 * which is what an organisation does the day the link leaked — would leave those tokens
 * pointing at an unauthenticated `GET` that serves the full field definition.
 * The requirement („ein `GET` ohne gültigen Nachweis liefert … **keine** Felddefinition")
 * would then be false, with no carve-out anywhere saying so.
 *
 * **Two kinds of address are taken back, and the name of this function is older
 * than the second one.** A form now also hands out the address of a
 * *zwischengespeicherter Entwurf*, and that one is the sharper case: an edit
 * link opens one answer, a draft address opens the **complete field
 * definition** — the very thing the requirement promises cannot be read past the gate. What
 * this function decides is unchanged and is deliberately *one* decision; what
 * the two write paths do with a `true` is take back both (`tenant-scope.ts`,
 * `revokeParticipantLinks`).
 *
 * Three cases, and the third is the reason this is a function rather than an
 * `if`:
 *
 * 1. **Switched on** — every token issued so far predates the gate. Revoke.
 * 2. **Word changed while on** — the usual reason to change it is that the old
 *    one leaked, and „das Wort ist weg" and „die Links sind weg" have to mean
 *    the same thing, or the change is only half a revocation.
 * 3. **Switched off** — *no* revocation. There is nothing left to protect, and
 *    throwing away every participant's link to *loosen* a restriction would be
 *    a data loss nobody asked for.
 *
 * A word edited while the protection is **off** likewise revokes nothing: it
 * guards no form yet, and switching it on later is case 1.
 *
 * Compared on the **effective** settings of a form, never on the override
 * alone: a form that has not taken *Zugriff & Sicherheit* over gets its word
 * from the organisation, so „eingeschaltet" can happen in either document.
 *
 * **There is no third document that could reach this rule, and there is not
 * going to be one.** While the installation carried a system layer of its own,
 * „eingeschaltet" could in principle have happened in a *third* document — and
 * every inheriting form of every organisation would have had to revoke its
 * edit links on a write nobody in that organisation made. That layer was kept
 * out of the two access keys for exactly this reason and has since been removed
 * altogether (ADR-0011, continuation 2026-08-14), so both arguments of this
 * function can now only move within one organisation.
 */
export function revokesEditLinks(
  before: AccessWordState,
  after: AccessWordState,
): boolean {
  if (!after.passwordEnabled) {
    return false;
  }
  return !before.passwordEnabled || before.password !== after.password;
}

/**
 * Where a participant is sent after submitting — the *delivery* gate.
 */
export interface RedirectTarget {
  /** Absolute `http`/`https` URL, normalised by {@link safeExternalUrl}. */
  readonly url: string;
  /** Seconds the confirmation stays on screen before the browser follows. */
  readonly delaySec: number;
}

/**
 * The redirect that applies to a form — `null` when none does.
 *
 * Three things make it `null`, and the third is the one that matters for
 * security: the switch is off, no target was entered, **or the stored target is
 * not an `http`/`https` URL**. The last check is made here again rather than
 * left to the schema alone. The schema refuses such a value when a *document*
 * is parsed; this function refuses it when a value is *handed out*, and it is
 * the only gate between `FormSettings` — a plain TypeScript type any caller can
 * construct — and a browser being told where to go.
 *
 * Nothing here decides *when* to redirect; the delay travels with the target so
 * the surface that renders the countdown does not look the settings up twice.
 */
export function effectiveRedirect(
  settings: FormSettings,
): RedirectTarget | null {
  if (!settings.redirectEnabled || settings.redirectUrl === null) {
    return null;
  }
  const url = safeExternalUrl(settings.redirectUrl);
  if (url === null) {
    return null;
  }
  return { url, delaySec: settings.redirectDelay };
}

/**
 * Flip a section between „Tenant-Standard" and „Angepasst" (* cases 3 and 4). Pure — it returns the next override, it does not mutate.
 *
 * Switching **on** copies the values that apply right now, so the editor
 * continues from what the form was showing instead of jumping to system
 * defaults (handoff, *Interactions*).
 *
 * Switching **off** *discards* the section's values. Keeping them would mean a
 * second switch-on silently resurrects numbers nobody remembers entering —
 * and the editor showed them as gone.
 *
 * For *Zugriff & Sicherheit* the copy includes the access word; what that means
 * for the encryption is written at the `password` field.
 */
export function setSectionOverride(
  tenantDefaults: TenantFormSettings,
  override: FormSettingsOverride,
  section: SettingsSection,
  overridden: boolean,
): FormSettingsOverride {
  const sectionKeys = new Set<string>(SETTINGS_SECTION_KEYS[section]);
  // Assembled key by key, so it is built untyped and handed back as the partial
  // document it is: every entry is either carried over unchanged or taken from
  // a complete set under its own key.
  const values: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(override.values)) {
    if (!sectionKeys.has(key)) {
      values[key] = value;
    }
  }

  if (overridden) {
    const applying = effectiveSettings(tenantDefaults, override);
    for (const key of SETTINGS_SECTION_KEYS[section]) {
      values[key] = applying[key];
    }
  }

  return {
    overridden: { ...override.overridden, [section]: overridden },
    values,
  };
}

/**
 * Drop the values of every section that is not taken over — what the write path
 * stores.
 *
 * The merge already ignores them (that is what makes „the standard gets
 * through" true), so this changes nothing about what *applies*. It is about
 * what is *kept*: a locked section whose values a client still sends must not
 * leave a trace in the document, and a stale value nobody can
 * see is a value that surprises whoever reads the row later — or that the
 * password field has to keep encrypting long after the section stopped counting.
 *
 * **The keys of *Verfügbarkeit* are always kept**, and that is not an
 * exception to the rule but the rule applied: they belong to no section that
 * could be „nicht übernommen", they are the form's own
 * ({@link AVAILABILITY_KEYS}). Dropping them here would delete every deadline
 * in the installation on the next save.
 */
export function pruneToOverridden(
  override: FormSettingsOverride,
): FormSettingsOverride {
  const kept = new Set<string>(AVAILABILITY_KEYS);
  for (const section of SETTINGS_SECTIONS) {
    if (override.overridden[section]) {
      for (const key of SETTINGS_SECTION_KEYS[section]) {
        kept.add(key);
      }
    }
  }

  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(override.values)) {
    if (kept.has(key)) {
      values[key] = value;
    }
  }

  return { overridden: { ...override.overridden }, values };
}

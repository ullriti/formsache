import {
  AVAILABILITY_KEYS,
  REDACTED_PASSWORD,
  SETTINGS_SECTIONS,
  SETTINGS_SECTION_KEYS,
  mergeSettings,
  type FormSettings,
  type LegalDocument,
  type PartialFormSettings,
  type PartialTenantFormSettings,
  type SettingsOverridden,
  type SettingsSection,
  type TenantFormSettings,
} from '@formsache/shared';

/**
 * The unsaved state of a section-wise settings page, and the rules that turn it
 * into something to show and something to send.
 *
 * **The merge is not repeated here.** `effectiveSettings()` runs on the server
 * and arrives as `document.effective`; what this module adds is only the layer
 * the editor has typed and not yet saved. Which document a section reads from
 * is a question the interface has to answer anyway — it is the same question as
 * „is this section locked?" — so answering it is not a second truth, it is the
 * lock and the display agreeing on one source.
 *
 * **Switching a section on copies nothing.** The server does that
 * (`setSectionOverride`), and doing it here as well would produce two answers
 * to “which values apply now?” that only agree while nobody else is editing.
 * A section that has just been switched on shows `effective` — which for such a
 * section *is* the organisation's standard, and is therefore exactly what the server
 * will copy into it on save.
 */

export interface SettingsDraft {
  readonly overridden: SettingsOverridden;
  /** Only fields the editor changed since loading — a patch, like the wire. */
  readonly values: PartialFormSettings;
  /**
   * This form's privacy notice — **whole**, not as a patch
   * (ADR-0028 no. 4).
   *
   * It stands in *this* draft and not in a second one next to it, because it is
   * edited on the same page and saved with the same `PUT`:
   * a second draft would be a second “unsaved” state, a second
   * save button and a second opportunity to lose the wrong half when leaving
   * the page.
   *
   * **Whole and not section by section**, unlike {@link values}: the
   * document carries two halves side by side (a filled-in template *and*
   * one's own text), and a partial transfer would have to be able to say how an
   * *emptied* field is to be told apart from an *unmentioned* one —
   * precisely the distinction at which a patch protocol would lose data here.
   *
   * There is no inheritance: an organization has no
   * form-specific notice that a form could take over, so there is
   * no „Vorgabe ⇄ Angepasst" switch here either.
   */
  readonly privacyNotice: LegalDocument;
}

/**
 * What this module needs of a loaded document — **and both pages have it**.
 *
 * A form takes sections over from its organisation, an organisation from the
 * shipped constant. Which layer sits below is the *only* difference, so it is
 * the only thing this interface names ({@link inherited}) instead of the two
 * documents being served by two copies of the same rules.
 *
 * `T` is what the page's *own* document is: a form has
 * {@link FormSettings} (including *Verfügbarkeit*), an organisation has
 * {@link TenantFormSettings} (which cannot carry it — ADR-0011, continuation
 * 2026-08-14). `inherited` is a `TenantFormSettings` on **both** pages, and
 * that is not a coincidence: the layer below a form is an organisation, and the
 * layer below an organisation is the shipped constant read as one.
 */
export interface SectionedDocument<T extends TenantFormSettings> {
  readonly overridden: SettingsOverridden;
  /** What applies right now, as the **server** merged it. */
  readonly effective: T;
  /** The layer a section that is *not* taken over reads from. */
  readonly inherited: TenantFormSettings;
}

/**
 * The draft a freshly loaded document starts from: no local change at all.
 *
 * `privacyNotice` comes as an argument of its own and not from
 * {@link SectionedDocument}: this interface describes the *inheritance* and is
 * also used by the organization page, which has no form-specific notice.
 * Writing it in there would mean declaring a field that one half of the callers
 * can never fill.
 */
export function draftOf(
  document: SectionedDocument<TenantFormSettings>,
  privacyNotice: LegalDocument,
): SettingsDraft {
  return { overridden: document.overridden, values: {}, privacyNotice };
}

/** The draft with a new state of the privacy notice. */
export function withPrivacyNotice(
  draft: SettingsDraft,
  privacyNotice: LegalDocument,
): SettingsDraft {
  return { ...draft, privacyNotice };
}

/**
 * The complete set of values the page currently displays.
 *
 * Section by section, because that is the grain the inheritance works in:
 * a section that follows the organisation shows the organisation's standard, a section the form
 * has taken over shows what applies plus whatever has been typed since.
 *
 * **The overlay goes through `mergeSettings`, not through `??`.** For `openAt`,
 * `closeAt` and `redirectUrl`, `null` is a *value* — “no deadline”, “no
 * redirect target” — and `??` treats it as “nothing entered”. A review
 * reproduced what that costs: clearing „Schließt am" put the old date straight
 * back into the field and left the badge saying „Geöffnet · bis 15.08.2026,
 * while the save quietly sent `closeAt: null` and removed the deadline. The
 * screen said one thing and the stored document another. `mergeSettings` (the
 * same function `TenantFormDefaultsView` uses, so both pages treat `null`
 * alike) drops only `undefined` and lets a deliberate `null` through.
 */
export function shownSettings(
  document: SectionedDocument<FormSettings>,
  draft: SettingsDraft,
): FormSettings {
  const result: Record<string, unknown> = {
    ...inheritedSections(document, draft),
  };

  // *Verfügbarkeit* has no switch and no layer below: it is the form's own,
  // always, so what is shown is what is stored plus what has been typed
  // (ADR-0011, continuation 2026-08-14).
  const edited = mergeSettings(document.effective, draft.values);
  for (const key of AVAILABILITY_KEYS) {
    result[key] = edited[key];
  }

  // Safe: every key of `FormSettings` belongs to exactly one section or to
  // `AVAILABILITY_KEYS`, and each is filled from a complete set.
  return result as FormSettings;
}

// ---------------------------------------------------------------------------
// The page **below** the form — an organization's standards
// ---------------------------------------------------------------------------
//
// Three small functions instead of the three above, and the difference is the
// subject, not the size (review finding 10): an organization has no
// section that could be “not taken over”, so there is nothing here to
// lock, nothing to throw away and nothing to read section by section. What
// remains is a stored complete set and a patch on top of it.

/**
 * The patch of a page without inheritance — only what was typed.
 *
 * `PartialTenantFormSettings` and not `PartialFormSettings`: the page
 * writes against `tenantSettingsWriteSchema`, which refuses *Verfügbarkeit*
 * with a 400. A draft type that carried `closeAt` would hold open until the
 * server an error the type here already knows about.
 */
export type TenantSettingsDraft = PartialTenantFormSettings;

/**
 * What the page shows: the stored state with the typed state on top of it.
 *
 * Via `mergeSettings` and not via `??`, for the same reason as in
 * {@link shownSettings}: for `redirectUrl`, `null` is a *value* (“no target”),
 * and `??` would read it as “nothing entered” and put the old one back.
 */
export function shownTenantValues(
  stored: TenantFormSettings,
  draft: TenantSettingsDraft,
): TenantFormSettings {
  return mergeSettings(stored, draft);
}

/**
 * One field change, leaving the draft unchanged.
 *
 * A spread and **no** `mergeSettings`: the draft is a patch, and
 * `mergeSettings` moves only keys the target already has — the first
 * change to a field would thereby fall by the wayside.
 */
export function withTenantValue(
  draft: TenantSettingsDraft,
  patch: PartialTenantFormSettings,
): TenantSettingsDraft {
  return { ...draft, ...patch };
}

/** Whether a save would change something the server has. */
export function isTenantDirty(
  stored: TenantFormSettings,
  draft: TenantSettingsDraft,
): boolean {
  const values: Record<string, unknown> = stored;
  return Object.entries(draft).some(
    ([key, value]) => value !== undefined && values[key] !== value,
  );
}

/** The four inherited sections, section by section — see {@link shownSettings}. */
function inheritedSections(
  document: SectionedDocument<TenantFormSettings>,
  draft: SettingsDraft,
): Record<string, unknown> {
  const edited = mergeSettings(document.effective, draft.values);
  const result: Record<string, unknown> = {};

  for (const section of SETTINGS_SECTIONS) {
    // The one section-wise decision, and the only one this module makes: a
    // locked section reads the layer below, an unlocked one reads what applies
    // with the unsaved edits laid over it.
    const source: Record<string, unknown> = draft.overridden[section]
      ? edited
      : document.inherited;
    for (const key of SETTINGS_SECTION_KEYS[section]) {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * The `values` patch a save may carry.
 *
 * Fields of a locked section are dropped rather than sent. The server ignores
 * them anyway — that is what makes the lock a boundary rather than a look — but
 * a client that sends what it has just greyed out is a client whose next
 * refactor sends it into a section that *is* writable.
 */
export function writableValues(draft: SettingsDraft): PartialFormSettings {
  return keptValues(draft.values, writableKeys(draft.overridden));
}

/**
 * Every settings key a save may carry: the sections that are taken over, and
 * *Verfügbarkeit* — which is always writable on the page that has it, because
 * it belongs to no section that could be locked. The organisation's page has no
 * such fields, so nothing there can put one into a draft.
 */
function writableKeys(overridden: SettingsOverridden): ReadonlySet<string> {
  const keys = new Set<string>(AVAILABILITY_KEYS);
  for (const section of SETTINGS_SECTIONS) {
    if (overridden[section]) {
      for (const key of SETTINGS_SECTION_KEYS[section]) {
        keys.add(key);
      }
    }
  }
  return keys;
}

/**
 * A patch reduced to the keys of `kept`.
 *
 * Rebuilt rather than pruned with `delete`: the result is a fresh object, so no
 * caller can be holding the version that still had the dropped entries.
 */
function keptValues(
  values: PartialFormSettings,
  kept: ReadonlySet<string>,
): PartialFormSettings {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (kept.has(key) && value !== undefined) {
      result[key] = value;
    }
  }
  // Assignable without an assertion: every entry was copied from `values` under
  // its own key, so each value still has the type that key declares.
  return result;
}

/** Applies one field change, keeping the draft immutable. */
export function withValue(
  draft: SettingsDraft,
  patch: PartialFormSettings,
): SettingsDraft {
  return {
    ...draft,
    values: { ...draft.values, ...patch },
  };
}

/**
 * Whether the access word on screen is the API's redaction marker rather than a
 * word — “the organization has set one, this caller may not see it”
 * (ADR-0021).
 *
 * The server replaces the word with {@link REDACTED_PASSWORD} for a caller
 * without `can_manage_settings` (`settings-document.ts`), so it can reach this
 * module through `document.inherited` and through the `document.effective` of a
 * form that has not taken *Zugriff & Sicherheit* over. It is a value nobody can
 * type — it carries a NUL byte — so an equality check is the whole test.
 *
 * The organisation's **own** standards page never sees it: that route stands
 * behind the very right the redaction asks about, so this answers `false`
 * there and everything below is a form's business alone.
 */
export function isWithheldPassword(password: string): boolean {
  return password === REDACTED_PASSWORD;
}

/**
 * Flips one section between „Tenant-Standard" and „Angepasst".
 *
 * Switching **off** drops the section's local edits: they cannot be saved any
 * more, and keeping them would mean a second switch-on silently resurrects
 * numbers the editor watched disappear (the same rule `setSectionOverride`
 * follows on the server).
 *
 * ## The one exception to “switching on copies nothing here”
 *
 * The head of this file says that taking a section over copies nothing here —
 * the server does that, and a second computation would be a second answer to
 * “which values apply now?”. For a **withheld access word** it is the other way
 * round, and for the very same reason: the server does *not* copy it
 * (`copyableTenantDefaults`, ADR-0021). Without the two values here, after the
 * click on „Angepasst" a „Passwortschutz: an" switch would stand above a field
 * that becomes empty and off on save — screen and column would say different
 * things, exactly the divergence against which {@link shownSettings} takes the
 * detour via `mergeSettings`.
 *
 * What is set is therefore **the same** state the server will write, and it
 * travels along as an ordinary local change: visible, overwritable (whoever
 * types a word of their own right away replaces it) and discarded on switching
 * back like any other.
 */
export function withSection(
  document: SectionedDocument<TenantFormSettings>,
  draft: SettingsDraft,
  section: SettingsSection,
  overridden: boolean,
): SettingsDraft {
  // **All four switches travel together.** `PUT` replaces the whole switch
  // document, so a spread that dropped the three unchanged ones would send them
  // as `false` and make the server discard their values — a review reproduced
  // exactly that data loss against the live route.
  const next: SettingsOverridden = {
    ...draft.overridden,
    [section]: overridden,
  };

  if (overridden) {
    // Only *Zugriff & Sicherheit* has a word, and only a withheld one is not
    // copied along — for every other section and for every visible word it
    // remains the case that the server copies on its own.
    //
    // And only on the **switch** from „Vorgabe" to „Angepasst": a second call
    // on a section that has already been taken over would otherwise empty a
    // word of one's own that has just been typed — `document.effective` remains
    // the server's state and carries the placeholder as long as nothing has
    // been saved. Through the interface this is not reachable (an already
    // selected radio button fires no `change`); it is the difference between
    // “works today” and “is right”.
    if (
      section === 'access' &&
      !draft.overridden.access &&
      isWithheldPassword(document.effective.password)
    ) {
      return {
        ...draft,
        overridden: next,
        values: { ...draft.values, password: '', passwordEnabled: false },
      };
    }
    return { ...draft, overridden: next };
  }

  // Switched off: the section's edits cannot be saved any more, and keeping
  // them would let a second switch-on resurrect numbers the editor watched
  // disappear.
  const dropped = new Set<string>(SETTINGS_SECTION_KEYS[section]);
  const kept = new Set(
    Object.keys(draft.values).filter((key) => !dropped.has(key)),
  );
  return { ...draft, overridden: next, values: keptValues(draft.values, kept) };
}

/**
 * Whether saving would change anything the server has.
 *
 * `storedPrivacyNotice` is again an argument of its own, for the reason
 * {@link draftOf} names. The comparison goes via `JSON.stringify` and not field
 * by field: the document is a tree with two open maps (`fills`, `conditions`),
 * and a hand-written comparison would be the place where a future third field
 * is forgotten — the same construction `notification-draft.ts` chooses for the
 * same case.
 */
export function isDirty(
  document: SectionedDocument<TenantFormSettings>,
  draft: SettingsDraft,
  storedPrivacyNotice: LegalDocument,
): boolean {
  const switchesChanged = SETTINGS_SECTIONS.some(
    (section) => draft.overridden[section] !== document.overridden[section],
  );
  if (switchesChanged) {
    return true;
  }

  if (
    JSON.stringify(draft.privacyNotice) !== JSON.stringify(storedPrivacyNotice)
  ) {
    return true;
  }

  const effective: Record<string, unknown> = document.effective;
  return Object.entries(writableValues(draft)).some(
    ([key, value]) => effective[key] !== value,
  );
}

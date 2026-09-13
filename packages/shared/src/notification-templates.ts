import { z } from 'zod';

import {
  notificationTemplateSchema,
  systemPlaceholderToken,
  type NotificationTemplate,
} from './mail.ts';

/**
 * The notifications an organisation gets **without setting anything up** — the
 * **floor** of an installation-wide setting rather than the setting itself
 * ([ADR-0011](../../../docs/architecture/0011-systemweite-einstellungen.md)).
 *
 * Until this existed, „eine Benachrichtigung anlegen" meant an empty subject
 * line, an empty body and a chip row — and the three mails every organisation actually
 * needs (Bestätigung an den Teilnehmer, Meldung ans Büro, Änderungsmeldung) had
 * to be written from scratch by somebody who first had to learn what
 * `{{antworten}}` does. A new Organisation is supposed to be able to work on the day it
 * is created; this is what that sentence costs in text.
 *
 * ## Three rules, decided rather than emergent
 *
 * 1. **A template is a starting point, not a binding.** Applying one copies its
 *    text into the draft and that is the end of the relationship: nothing is
 *    stored about which template a notification came from, and editing the text
 *    afterwards is editing ordinary text. A notification that stayed *linked*
 *    would be a second truth beside its own body — and the day the template
 *    changes, every mail built on it would change with it, silently, including
 *    the ones somebody had already adjusted. That is not a limitation of the
 *    implementation but a deliberate decision: a form *setting* takes effect
 *    retroactively, a notification **text** is written content, and changing it
 *    retroactively would mean writing into a mail that has already been
 *    promised.
 * 2. **Offered while there is nothing to lose.** The picker appears for a new
 *    notification and for an existing one **whose text is empty**
 *    ({@link acceptsTemplate}). A button that overwrites typed text is a
 *    data-loss button, and „ich wollte nur sehen, was da drinsteht" is exactly
 *    how it would be pressed.
 * 3. **German, and usable as they are.** These are not skeletons with `TODO` in
 *    them; the point of the exercise is that sending one unmodified is a
 *    reasonable thing to do.
 *
 * ## The move happened — this is the floor, not a second copy
 *
 * The templates are stored in `system_setting.notification_templates` and the
 * editor is offered **that** document (`NotificationTemplatesService` in the
 * API, delivered on the notification list route). {@link
 * NOTIFICATION_TEMPLATES_FLOOR} is what „keine Zeile, nichts entschieden"
 * means, exactly as `SYSTEM_FORM_SETTINGS` is for the settings layers — read at
 * **one** place, the service above.
 *
 * That it stays *one* place is not left to discipline: `single-source.test.ts`
 * fails if this identifier is defined anywhere else, or if any of these texts
 * turns up in a second file. A fallback that nobody edits and that quietly
 * differs from what the superadmin wrote is the drift this package exists to
 * prevent, and the harder half of it is that both would look right.
 */

const ANSWERS = systemPlaceholderToken('antworten');
const CHANGES = systemPlaceholderToken('aenderungen');
const EDIT_LINK = systemPlaceholderToken('bearbeiten');
const FORM = systemPlaceholderToken('formular');
const TENANT = systemPlaceholderToken('formularorganisation');
const DATE = systemPlaceholderToken('datum');

/**
 * The three, in the order the picker offers them — **the floor**, used when the
 * installation has decided nothing.
 *
 * HTML throughout, which is the format `notificationCreateSchema` defaults to
 * and the one the tables of `{{antworten}}`/`{{aenderungen}}` are laid out for;
 * a plain-text notification renders the same template through the text path, so
 * choosing „Nur Text" afterwards costs nothing but the table borders.
 *
 * Named `…_FLOOR` rather than `NOTIFICATION_TEMPLATES`, in the shape
 * `SYSTEM_FORM_SETTINGS` established for the settings layers: a reader who
 * types the old name gets a compile error instead of quietly reading the
 * shipped text where the stored document was meant.
 *
 * ## Why no `<p>` stands in these bodies any more (2026-08-15, finding 31)
 *
 * Up to here they were set in `<p>` paragraphs. That was the way of writing one
 * knows from a web page, and in a mail of this system it is the wrong one — for
 * a reason that lies one level deeper:
 *
 * **The template editor is a textarea, and `renderMailTemplate` knows that.**
 * Every line break in literal text becomes a `<br />` (`neutraliseLiteral`),
 * because a paragraph in a textarea is exactly that: a pressed Enter. If the
 * text additionally stands in `<p>` elements, the spacing counts twice — the
 * margin of the paragraph *and* the break out of the line change. In the
 * delivered mail two and a half lines therefore gaped between two sentences,
 * and a whole blank line between „Mit freundlichen Grüßen" and the name of the
 * organisation.
 *
 * The bodies are therefore now **text with a little markup**: lines and blank
 * lines make the structure, `<strong>` emphasises, and block elements come only
 * from the placeholders that render a table. That is at the same time the
 * version that looks in the textarea exactly the way it arrives — which a
 * template somebody is supposed to be able to edit has to be anyway.
 *
 * **`neutraliseLiteral` stays untouched**, and that is deliberate: suppressing
 * a line break „between two block elements" there would be a rule that would
 * also take away the blank line an editor deliberately put between two
 * `<p>`. Changing a template costs this file; changing a render rule costs
 * every template of every installation.
 */
export const NOTIFICATION_TEMPLATES_FLOOR: readonly NotificationTemplate[] = [
  {
    id: 'confirmation',
    name: 'Bestätigung an Teilnehmer',
    description:
      'Geht an die E-Mail-Adresse aus dem Formular, sobald jemand abgesendet hat.',
    triggers: ['submit'],
    format: 'html',
    toSubmitter: true,
    subject: `Deine Anmeldung zu ${FORM}`,
    // An empty string is a blank line — that is the whole structure a
    // textarea template has, and since this version also the whole structure
    // it needs (see the section above).
    body: [
      'Hallo,',
      '',
      `vielen Dank für deine Anmeldung. Wir haben folgende Angaben zu <strong>${FORM}</strong> von dir erhalten:`,
      '',
      ANSWERS,
      '',
      // The link is the whole reason a confirmation is worth sending twice:
      // without it a typo can only be corrected by writing to the office.
      `Solltest du etwas ändern wollen, kannst du deine Anmeldung hier bearbeiten: ${EDIT_LINK}`,
      '',
      // Greeting and sender on **one** line, with the `<br />` spelled out:
      // two entries would be two line breaks and thereby a blank line in the
      // middle of the closing formula. `stripMarkup` turns the `<br />` back
      // into a real break in the text version (`html-text.ts`), so the two
      // formats say the same thing.
      `Mit freundlichen Grüßen<br />${TENANT}`,
    ].join('\n'),
  },
  {
    id: 'office',
    name: 'Meldung ans Büro',
    description:
      'Geht an eine feste Adresse, sobald eine neue Antwort eingegangen ist.',
    triggers: ['submit'],
    format: 'html',
    toSubmitter: false,
    subject: `Neue Antwort: ${FORM}`,
    body: [
      `Zum Formular <strong>${FORM}</strong> ist am ${DATE} eine neue Antwort eingegangen.`,
      '',
      ANSWERS,
      '',
      TENANT,
    ].join('\n'),
  },
  {
    id: 'change',
    name: 'Änderungsmeldung',
    description:
      'Geht heraus, wenn eine bereits abgesendete Antwort nachträglich geändert wurde.',
    triggers: ['edit'],
    format: 'html',
    toSubmitter: false,
    subject: `Änderung: ${FORM}`,
    body: [
      `Eine bereits abgesendete Antwort zum Formular <strong>${FORM}</strong> wurde nachträglich geändert, am ${DATE}.`,
      '',
      // The comparison stands **before** the complete state and under a
      // heading of its own: whoever gets this mail wants to know first *what*
      // has moved — the remaining values are the evidence for it, not the
      // message.
      '<strong>Das hat sich geändert:</strong>',
      '',
      CHANGES,
      '',
      '<strong>Der vollständige Stand:</strong>',
      '',
      ANSWERS,
      '',
      TENANT,
    ].join('\n'),
  },
];

// Frozen, and for the reason `SYSTEM_FORM_SETTINGS` is: this is what „nichts
// entschieden" means for every organisation at once, so a single stray assignment would
// change the offer of the whole installation — silently and until restart. The
// entries as well as the array, because freezing only the array leaves every
// text writable.
for (const template of NOTIFICATION_TEMPLATES_FLOOR) {
  Object.freeze(template);
}
Object.freeze(NOTIFICATION_TEMPLATES_FLOOR);

/**
 * How many templates one installation may offer.
 *
 * A bound rather than an open list, for the reason `MAIL_RECIPIENT_LIMIT` has
 * one: the document is handed out to every editor who opens the notifications
 * page, and a row written straight into the database has never seen a request
 * schema. Twenty is far more than the three that ship and far less than a
 * payload worth worrying about.
 */
export const NOTIFICATION_TEMPLATE_LIMIT = 20;

/**
 * The stored `system_setting.notification_templates` document.
 *
 * Strict per entry (`notificationTemplateSchema`) and bounded as a whole. The
 * **empty list is allowed and means something**: „diese Installation bietet
 * keine Vorlagen an". That is a different statement from „nichts entschieden",
 * which is the *absence* of the column value and is answered by
 * {@link NOTIFICATION_TEMPLATES_FLOOR} — the same distinction ADR-0011 draws
 * for the settings layer, one level down.
 *
 * Ids are unique because the picker uses them as its React key and because a
 * second entry under an existing id is two answers to „welche Vorlage ist
 * `confirmation`?".
 */
export const systemNotificationTemplatesSchema = z
  .array(notificationTemplateSchema)
  .max(NOTIFICATION_TEMPLATE_LIMIT)
  .refine(
    (templates) =>
      new Set(templates.map((template) => template.id)).size ===
      templates.length,
    { message: 'Jede Vorlage braucht eine eigene id.' },
  );

/**
 * Reads a stored template document, or throws.
 *
 * Like the settings parsers of `form-settings.ts` it does **not** tolerate
 * `null`/`undefined`:
 * telling „keine Zeile / nichts entschieden" apart from „da, aber unlesbar" is
 * the caller's job, because only the caller can see whether there is a row
 * (`NotificationTemplatesService` in the API). Softening it here would blur the
 * two states this design deliberately keeps separate.
 */
export function parseSystemNotificationTemplates(
  source: unknown,
): NotificationTemplate[] {
  return systemNotificationTemplatesSchema.parse(source);
}

/**
 * Whether a template may be applied to what is currently in the editor —
 * rule 2 above.
 *
 * Asked about the **body as it stands on screen**, not about the stored row:
 * text that has been typed but not saved yet is exactly the text that would be
 * lost, and it is the text nobody could get back. „Leer" ignores whitespace,
 * because a stray newline is not something anybody meant to keep.
 */
export function acceptsTemplate(body: string): boolean {
  return body.trim() === '';
}

/**
 * ---------------------------------------------------------------------------
 * The **write path** of the templates — `GET`/`PUT
 * /admin/system-settings/notification-templates` (ADR-0022, continuation
 * 2026-08-18).
 *
 * Up to here there was only one reader: `NotificationTemplatesService` passed
 * the document on to the notification editor, and the column was written by
 * nothing. `system-settings.module.ts` recorded that explicitly — „whoever adds
 * that route adds the column with it" —, and that is exactly what has happened
 * here: `system_setting.notification_templates_revision` comes with this route,
 * because an optimistic counter on a document nobody writes would be a promise
 * without a counterparty.
 *
 * Two things these two schemas do **not** do:
 *
 * 1. **They invent no second limit.** What a template is, is said by
 *    `notificationTemplateSchema`; how many there may be and that the
 *    identifiers are unique is said by {@link
 *    systemNotificationTemplatesSchema}. The request schema uses both instead
 *    of copying them out — a second version would be the half that is milder
 *    later.
 * 2. **They know no „patch".** As with
 *    `updateSystemMailSettingsRequestSchema` this is a full replacement: the
 *    page holds the whole document, so it names it whole. A partial change to a
 *    *list* would anyway be the question „welcher Eintrag ist gemeint", and a
 *    full replacement does not raise it in the first place.
 * ---------------------------------------------------------------------------
 */

/**
 * What the templates page gets.
 *
 * `templates` is **always** a usable list — the stored one, or {@link
 * NOTIFICATION_TEMPLATES_FLOOR} when nothing has been decided. Which of the two
 * cases applies is said by {@link
 * systemNotificationTemplatesResponseSchema.shape.decided}, and that is no
 * cosmetics: „das sind die ausgelieferten Vorlagen" and „das hat hier jemand so
 * hinterlegt" are two different sentences for the same three cards, and without
 * the difference nobody would know whether they are changing something or
 * confirming something.
 */
export const systemNotificationTemplatesResponseSchema = z.strictObject({
  templates: z.array(notificationTemplateSchema),
  /**
   * Whether the row decides the templates (`true`) or the shipping does
   * (`false`).
   *
   * `false` means „keine Zeile, keine Spalte, nichts entschieden" — **and**
   * „ein Dokument, das nicht parst". The two are deliberately not
   * distinguished here: for the editor the action is the same (they see the
   * shipped templates and save them or something else), and the unreadable case
   * is the situation this page has to be able to repair. The difference that
   * counts stands in the server's log.
   */
  decided: z.boolean(),
  /** `notification_templates_revision` — this column's **own** counter. */
  lock: z.number().int().positive(),
});
export type SystemNotificationTemplatesResponse = z.infer<
  typeof systemNotificationTemplatesResponseSchema
>;

/**
 * A write onto the installation's templates.
 *
 * The **empty list is allowed and means something**: „diese Installation
 * bietet keine Vorlagen an" — not „nichts entschieden". The difference is the
 * same one {@link systemNotificationTemplatesSchema} describes, and it survives
 * precisely because the request schema uses the same check.
 */
export const updateSystemNotificationTemplatesRequestSchema = z.strictObject({
  templates: systemNotificationTemplatesSchema,
  /**
   * The counter value this superadmin assumed.
   *
   * Never `null`, as with the two counters next door: a fresh installation
   * without a row reports the number at which the column starts, so that the
   * first write can name it instead of making the lock optional.
   */
  lock: z.number().int().positive(),
});
export type UpdateSystemNotificationTemplatesRequest = z.infer<
  typeof updateSystemNotificationTemplatesRequestSchema
>;

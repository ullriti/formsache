import { z } from 'zod';

import { emailAddressSchema } from './auth.ts';
import { normaliseBaseUrl } from './base-url.ts';
import { DEFAULT_TENANT_BRANDING, isBrandColor } from './branding.ts';
import {
  collapseWhitespace,
  escapeHtml,
  neutraliseHtml,
  stripMarkup,
} from './html-text.ts';
import {
  MAIL_SUBJECT_MAX,
  questionPlaceholderToken,
  scanPlaceholders,
  type MailFormat,
  type NotificationRecipient,
  type PlaceholderMatch,
} from './mail.ts';

/**
 * Rendering a notification — and the escaping that makes it safe.
 *
 * **The grammar is not defined here.** What a `{{…}}` token is, which six
 * system placeholders exist and how a question is addressed lives in `mail.ts`
 * and is imported; this module only turns a template plus an answer into
 * subject, body and recipients. Two spellings of the grammar is the drift the
 * shared package exists to prevent — the editor would offer chips the renderer
 * does not resolve.
 *
 * ## Why this is core logic and not part of the mail module
 *
 * **The values behind a placeholder are typed by strangers into a public form.**
 * Everything in this file exists because of that one sentence: a rendered
 * notification mixes three sources with three different levels of trust, and
 * the mistake that gets made is to treat them as one string.
 *
 * - The **template** (subject, body) is written by an organisation's administrator. It is
 *   trusted for its own format: in an HTML notification the administrator's
 *   markup is markup.
 * - The **values** substituted for placeholders come from an answer. They are
 *   never trusted: in HTML they are escaped, in plain text their markup is
 *   removed, and in a subject line their control characters are removed before
 *   they can open a second SMTP header (`Bcc:` on the next line).
 * - The **addresses** of the recipient list are validated one by one, so a
 *   value carrying `,` or `Max <…>` cannot add a recipient nobody chose.
 *
 * Every function here is pure. No transport, no database, no I/O — the queue
 * and the SMTP side live in `apps/api/src/mail`; what a rendered mail *looks*
 * like is decided here, once, for the server that sends it and the preview
 * that shows it.
 */

/**
 * One answer as the renderer needs it: the id it is addressed by, the caption
 * it is shown under, and the value already rendered to a string.
 *
 * Formatting an answer *value* (a choice's captions, a German decimal comma, a
 * date as `TT.MM.JJJJ`) is `csv.ts`' `formatAnswerCell` and stays there —
 * repeating it here would be the second spelling that drifts. The caller
 * resolves the answer against **the form version of the response**, not
 * against the draft, or `{{antworten}}` shows columns that did not exist when
 * the participant pressed the button.
 */
export const mailAnswerRowSchema = z.object({
  questionId: z.uuid(),
  label: z.string(),
  value: z.string(),
});
export type MailAnswerRow = z.infer<typeof mailAnswerRowSchema>;

/**
 * One labelled row, as {@link renderAnswerTable} needs it — **caption and
 * value only**.
 *
 * Deliberately narrower than {@link MailAnswerRow}: the table does not read
 * the `questionId`, and ever since the test mail and the operational alerts
 * use the same table (ADR-0023, point 20 of the second review round) they
 * would have had to invent one just to have it thrown away. A `z.uuid()` as
 * the entry ticket into a layout function is exactly the kind of ceremony
 * that later turns into two tables.
 *
 * {@link MailAnswerRow} is structurally assignable; the caller on the public
 * path does not change.
 */
export interface MailLabelledValue {
  readonly label: string;
  readonly value: string;
}

/**
 * One answer that **changed** in this edit — what `{{aenderungen}}` is made of.
 *
 * Both values are already formatted strings, by the *same* function that fills
 * {@link MailAnswerRow.value} (`formatAnswerCell`, `csv.ts`). Two formattings
 * of one answer type drift apart, and the one that drifts is the one nobody
 * looks at — a change mail saying `4.5` where the export says `4,5` for the
 * same number.
 *
 * Which rows exist at all is **not** decided here: the caller compares the
 * stored answer before the write with the one after it, against the form
 * version of the response, and leaves out everything that did not move
 * (`answerChanges` in `apps/api/src/notifications/notification-render.ts`).
 */
export const mailChangeRowSchema = z.object({
  questionId: z.uuid(),
  label: z.string(),
  /** The value as it stood **before** this edit; empty when it was blank. */
  previous: z.string(),
  /** The value as it stands now; empty when the question was cleared. */
  current: z.string(),
});
export type MailChangeRow = z.infer<typeof mailChangeRowSchema>;

/** Everything a template may refer to. */
export const mailTemplateContextSchema = z.object({
  formularorganisation: z.string(),
  formular: z.string(),
  datum: z.string(),
  /**
   * In the order of the form. `{{antworten}}` renders them in this order and
   * `{{frage:<id>}}` looks them up here — one list, so a question can never be
   * in the table but missing from the lookup.
   */
  answers: z.array(mailAnswerRowSchema),
  /**
   * What this edit changed, in the order of the form — empty for everything
   * that is not one.
   *
   * **Required, not optional**, although „leer" is what a submission always
   * passes: a caller that has not thought about the previous values would
   * otherwise silently produce a change mail with an empty change block, which
   * is the one failure mode of `{{aenderungen}}` nobody would notice. Spelling
   * it out is one line at each of the two call sites and turns the omission
   * into a compile error.
   */
  changes: z.array(mailChangeRowSchema),
});
export type MailTemplateContext = z.infer<typeof mailTemplateContextSchema>;

// ---------------------------------------------------------------------------
// `{{bearbeiten}}` — the one placeholder that survives the enqueue
// ---------------------------------------------------------------------------

/**
 * What `{{bearbeiten}}` becomes in **this** render.
 *
 * Two answers, because the body of a queued mail is rendered twice in two
 * different situations:
 *
 * - at the **enqueue**, where everything else is frozen but the link is not
 *   knowable yet — `deferred`, which leaves {@link EDIT_LINK_MARK} behind;
 * - at the **send** and in the editor's preview, where the answer is
 *   `resolved` — with a URL, or with `null` when this answer has no working
 *   link at all.
 *
 * A discriminated union rather than `string | null | undefined`, because the
 * three states are genuinely different and the cheap spelling would let
 * „defer" and „there is no link" collapse into the same `undefined` — the one
 * confusion that would put a `{{bearbeiten}}` mark in a delivered mail.
 */
export type EditLinkSlot =
  | { readonly kind: 'deferred' }
  | { readonly kind: 'resolved'; readonly url: string | null };

/** Leave the slot open; the send step fills it. */
export const DEFERRED_EDIT_LINK: EditLinkSlot = { kind: 'deferred' };

/**
 * There is no link for this answer — the placeholder renders to nothing.
 *
 * Also the **default** of {@link renderMailTemplate}: a caller that has not
 * thought about the link gets no link, never a broken one. That is the safe
 * direction for a subject line (which is never filled in later) and for every
 * caller that renders a template outside the mail queue.
 */
export const NO_EDIT_LINK: EditLinkSlot = { kind: 'resolved', url: null };

/**
 * What a deferred `{{bearbeiten}}` leaves in the stored body, and what
 * {@link insertEditLink} replaces at send time.
 *
 * **Spelled like a tag on purpose, and that is the whole security argument.**
 * The mark has to be something no *other* contributor to the body can produce,
 * or a participant who types it into a public form would have their own edit
 * link spliced into a mail going to the organisation's office. Everything untrusted
 * passes through {@link escapeHtml} or {@link stripMarkup} on its way into the
 * body: the first turns `<` into `&lt;`, the second removes anything spelled
 * like a tag. So a value carrying this string cannot survive as this string in
 * either format, and no extra defusing pass is needed — the escaping that was
 * already there does it.
 *
 * The argument holds against **foreign** contributions, which is what it is
 * for. It is not absolute: an administrator writing an HTML template may type
 * `<formsache-edit-link>` into it literally, and literal template text passes through
 * unescaped by design. That is not an escalation — the link that lands there is
 * the same recipient's own — but it is a mark this module put no boundary
 * around, and reading the paragraph above as one would be wrong.
 *
 * Readable rather than a control character, so a row in `mail_log` can be read
 * with `psql` and a delivery that somehow skipped the substitution says so in
 * the mail instead of arriving subtly wrong.
 */
export const EDIT_LINK_MARK = '<formsache-edit-link>';

/**
 * What a reader sees in place of the mark when the **address itself** must
 * not travel — the mail log's detail route, see
 * `apps/api/src/mail-log/mail-log.service.ts`.
 *
 * The edit link is an owner *capability*, not a fact about the mail: whoever
 * holds it can overwrite a stranger's answer, unattributed. A view that only
 * proves `can_view_responses` — read rights — must not become a way to
 * acquire that capability, so the slot still says whether a link exists
 * without ever spelling out where it goes.
 */
export const EDIT_LINK_REDACTED_LABEL = '[Bearbeiten-Link]';

/**
 * Whether {@link renderEditLink} writes the real address or
 * {@link EDIT_LINK_REDACTED_LABEL} in its place. Defaults to `'real'`
 * everywhere below, which is what the worker has always done.
 */
export type EditLinkPresentation = 'real' | 'redacted';

/**
 * The link as one format writes it — or nothing at all.
 *
 * **HTML gets an anchor, plain text gets the bare address**, and the
 * difference is not decoration: „Hier ändern: https://…" is the whole link in
 * a text mail, while in HTML a bare URL is only clickable if the recipient's
 * client happens to auto-link it. The address is used as href *and* as the
 * visible text, so a client that shows the source and one that shows the
 * rendering both show where the link goes.
 *
 * Escaped although the value is the installation's own `PUBLIC_BASE_URL` plus
 * a base64url token: this is the project's first placeholder inside an
 * attribute, and „it is safe today" is the reasoning that ages worst.
 *
 * `presentation: 'redacted'` keeps the „is there a link at all" answer —
 * still empty when `url` is `null` — but writes
 * {@link EDIT_LINK_REDACTED_LABEL} in place of the address, and **replaces
 * the anchor rather than wrapping the label in one**: `href` is exactly the
 * one thing a redacted read must not carry. The label is neutralised through
 * the same {@link escapeHtml}/plain-text path every other inserted value
 * takes, so a caption cannot happen to read `[Bearbeiten-Link]` and produce
 * markup here — it is fixed text, not a value from the row.
 */
export function renderEditLink(
  url: string | null,
  format: MailFormat,
  presentation: EditLinkPresentation = 'real',
): string {
  if (url === null) {
    return '';
  }
  if (presentation === 'redacted') {
    return format === 'text'
      ? EDIT_LINK_REDACTED_LABEL
      : escapeHtml(EDIT_LINK_REDACTED_LABEL);
  }
  if (format === 'text') {
    return url;
  }
  const escaped = escapeHtml(url);
  return `<a href="${escaped}">${escaped}</a>`;
}

/**
 * Fills the slot {@link EDIT_LINK_MARK} left open, in a body that is otherwise
 * frozen.
 *
 * The **only** thing the send step does to a stored body. Everything else —
 * the template, the answers, the organisation, the date — was rendered when the answer
 * arrived and stays as it was, so a confirmation confirms what held at the
 * moment it was sent rather than what somebody edited three days later.
 *
 * `url === null` removes the mark instead of leaving it standing: a form
 * without „Bearbeiten erlaubt", a token revoked with the access word
 *  or an answer that is gone all mean „there is no link", and a
 * mark in a delivered mail would be the one outcome worse than no link.
 *
 * `presentation` is the **one** switch between the worker's real send and a
 * redacted read (`apps/api/src/mail-log/mail-log.service.ts`) — both go
 * through this same call, only the value {@link renderEditLink} substitutes
 * differs. A second `replaceAll(EDIT_LINK_MARK, …)` next to this one would be
 * exactly the duplicated resolution the doc comments around
 * `MailBodyRenderer` warn against.
 */
export function insertEditLink(
  body: string,
  format: MailFormat,
  url: string | null,
  presentation: EditLinkPresentation = 'real',
): string {
  return body.replaceAll(
    EDIT_LINK_MARK,
    renderEditLink(url, format, presentation),
  );
}

/**
 * What a password reset link leaves behind in the **stored** body (ADR-0020).
 *
 * ## Why a second placeholder and not simply the address
 *
 * `mail_log.body_text` is frozen and gets read — by the mail log
 * (`mailLogDetailSchema`) and by anybody who has the table in front of them. A
 * reset link, though, is not text about a mail but **the capability itself**:
 * whoever reads it can take over the account. Were it to stand in that column,
 * an organisation's mail log — a read view behind
 * `can_manage_settings` — would be a way into every local account whose reset
 * mail landed there. So the row may say everything about the delivery and must
 * not contain this one value.
 *
 * Hence the same construction as {@link EDIT_LINK_MARK}: the body carries a
 * mark, the value only comes into being at send time (`QueuedBodyRenderer`),
 * and the detail view gets a label instead of the address.
 *
 * The mark is written like a tag, and the reasoning of
 * {@link EDIT_LINK_MARK} carries here just the same: everything foreign goes
 * through `escapeHtml`/`stripMarkup` and so cannot survive as this string.
 * For **this** mail the body is fixed text of this application anyway and
 * contains nothing anybody would have typed.
 */
export const PASSWORD_RESET_LINK_MARK = '<formsache-password-reset-link>';

/**
 * What a reader of the mail log sees in place of the address.
 *
 * For the same reason as {@link EDIT_LINK_REDACTED_LABEL}, only sharper: the
 * edit link is the capability over *one answer*, this one the capability over
 * *one account*.
 */
export const PASSWORD_RESET_LINK_REDACTED_LABEL = '[Passwort-Link]';

/**
 * The state of the reset link when it is inserted — **„is there one" and „what
 * does it say" are two questions** (ADR-0020).
 *
 * Two fields instead of one `string | null`, and the reason is the redacted
 * view: it is meant to say *that* a link stands in the mail without knowing
 * it. With a single field the caller would have to hand in some string for
 * that, one that never goes out only because the presentation throws it away
 * in the end — a capability that travels one step too far and whose safety
 * hangs on the last line. Here `url` is simply `null` in the redacted case,
 * and with that the outcome is not *handled* but **impossible**.
 */
export interface PasswordResetLinkSlot {
  /** Does this mail carry a (still valid) reset link? */
  readonly present: boolean;
  /**
   * The address — only for the real send. `null` in the redacted case, and the
   * caller is not supposed to resolve it there in the first place
   * (`QueuedBodyRenderer` then signs nothing).
   */
  readonly url: string | null;
}

/**
 * Fills the mark {@link PASSWORD_RESET_LINK_MARK} — with the address at send
 * time, with the label in the detail view.
 *
 * `present: false` **removes** the mark instead of leaving it standing: a mark
 * in a delivered mail would be the one outcome worse than no link. That a
 * reset mail would then go out empty of content is prevented by the caller —
 * it lets the delivery fail (`QueuedBodyRenderer`).
 */
export function insertPasswordResetLink(
  body: string,
  format: MailFormat,
  link: PasswordResetLinkSlot,
  presentation: EditLinkPresentation = 'real',
): string {
  return body.replaceAll(
    PASSWORD_RESET_LINK_MARK,
    renderPasswordResetLink(link, format, presentation),
  );
}

/** The link as one format writes it — see {@link renderEditLink}. */
function renderPasswordResetLink(
  link: PasswordResetLinkSlot,
  format: MailFormat,
  presentation: EditLinkPresentation,
): string {
  if (!link.present) {
    return '';
  }
  if (presentation === 'redacted') {
    return format === 'text'
      ? PASSWORD_RESET_LINK_REDACTED_LABEL
      : escapeHtml(PASSWORD_RESET_LINK_REDACTED_LABEL);
  }
  if (link.url === null) {
    // „There is one, but I do not have it" is not a state the real send may
    // be in — it would only arise if somebody mixed the redacted form with
    // `'real'`. Inserting nothing is the quiet variant; failing loudly is the
    // one that shows the mistake before a mail goes out.
    throw new Error(
      'password reset link marked as present without an address — refusing to render',
    );
  }
  if (format === 'text') {
    return link.url;
  }
  const escaped = escapeHtml(link.url);
  return `<a href="${escaped}">${escaped}</a>`;
}

/**
 * The placeholders a preview has to mark, verbatim and without duplicates.
 *
 * They stay in the sent mail unchanged — turning them
 * into empty text is the variant nobody notices until the mail is out — so the
 * preview is the only place where the administrator can see that `{{vorname}}`
 * is not a placeholder this system has.
 *
 * `knownQuestionIds` is optional, and the difference is the whole reason this
 * function exists next to `scanPlaceholders`: **without** the set every
 * well-formed `{{frage:<id>}}` counts as known — that is the editor's view,
 * where the form is not at hand. **With** it, a reference to a question that
 * does not (or no longer) exist comes back as unknown, which is what the
 * preview and the publish check ask for.
 */
export function unknownPlaceholders(
  template: string,
  knownQuestionIds?: Iterable<string>,
): string[] {
  const known =
    knownQuestionIds === undefined ? null : new Set(knownQuestionIds);
  const seen = new Set<string>();

  for (const { raw, placeholder } of scanPlaceholders(template)) {
    if (placeholder.kind === 'unknown') {
      seen.add(raw);
      continue;
    }

    if (
      placeholder.kind === 'question' &&
      known !== null &&
      !known.has(placeholder.questionId)
    ) {
      seen.add(raw);
    }
  }

  return [...seen];
}

/**
 * **The vocabulary of neutralisation, at its old address.**
 *
 * `escapeHtml` and `stripMarkup` moved to `html-text.ts`, together
 * with the escape-and-break rule they are the halves of: they defuse a value
 * for an *alphabet*, not for a mail, and the HTML export needs the very same
 * two functions. Re-exported here because this module is the address every
 * caller and every test knows them by, and a proof one has to edit in order to
 * keep it passing is not one.
 */
export { escapeHtml, stripMarkup } from './html-text.ts';

/**
 * How an untrusted value is made safe for one format.
 *
 * **The choice of alphabet is all that is left here.** The HTML half — escape
 * first, break second — is {@link neutraliseHtml} (`html-text.ts`), where the
 * HTML export reaches it too; writing those two steps out again on this side
 * would be the same drift rebuilt, one module further along.
 *
 * The line breaks are the same ones {@link renderAnswerTable} already inserts
 * in its cells. Without them a multi-line answer substituted through
 * `{{frage:<id>}}` arrived as one run-on line while the *same* answer inside
 * `{{antworten}}` broke correctly — one mail, two renderings of one value.
 */
function neutralise(value: string, format: MailFormat): string {
  return format === 'html' ? neutraliseHtml(value) : stripMarkup(value);
}

// ---------------------------------------------------------------------------
// What a mail looks like — the continuation of the „kein Styling" decision
// ---------------------------------------------------------------------------

/**
 * **This file does after all decide what a mail looks like — and that is a
 * deliberate continuation, not carelessness** (ADR-0004, continuation
 * 2026-08-15).
 *
 * Up to here {@link renderAnswerTable} carried the sentence: *„Rendered without
 * styling beyond `border-collapse` — how a notification looks is the template
 * author's business, and inline styles here would be a design decision baked
 * into a shared package."* The sentence was coherent in itself and has not
 * proven itself in the application, for three reasons:
 *
 * 1. **There is no template author for what is rendered here.**
 *    `{{antworten}}` and `{{aenderungen}}` are *this* application's tables; an
 *    editor can only place them or leave them out, not design them. Leaving
 *    the design open therefore did not mean „the author decides" but „nobody
 *    decides" — and what came out was a borderless three-column table that
 *    nobody could read on a phone.
 * 2. **A mail has no place at all where an author could design.** There is no
 *    stylesheet a mail client reliably loads; whoever wants something to look
 *    a certain way in an HTML mail writes inline styles. The decision „no
 *    inline styles here" was thereby equivalent to „no design, anywhere".
 * 3. **The body of a notification is a fragment.** Without `<html>`, `<head>`
 *    and `<meta charset>` every client supplies its own default — serif type,
 *    full window width, in part a wrong character-set assumption.
 *
 * What is **not** continued is the separation of the trust levels underneath:
 * values are still defused via {@link neutralise}, and the styles here are
 * fixed strings of this module — no value from outside is ever written into a
 * `style` attribute. The one exception is the organisation colour in
 * {@link wrapMailHtml}, and it goes through {@link isBrandColor} before it
 * sees an attribute.
 *
 * ## Why this here is e-mail HTML and not web HTML
 *
 * Mail clients are not a browser. What holds here and does not in `apps/web`:
 *
 * - **Tables instead of flexbox/grid.** Outlook renders with the Word engine;
 *   `display:flex` does not exist there.
 * - **Inline styles instead of a `<style>` block.** Gmail and some webmailers
 *   throw the block away; a `class` without a rule is then nothing.
 * - **No web fonts, no `var()`, no `color-mix()`.** All three are runtime
 *   resolutions a client does not owe — and a `var()` that does not resolve is
 *   not a colour but no declaration at all.
 * - **Width capped.** {@link MAIL_CONTENT_WIDTH} pixels, centred, plus
 *   `width:100%` on the inner table so that a phone does not scroll sideways.
 * - **A single colour scheme, spelled out.** `color-scheme: light only` tells
 *   the clients that read it (Apple Mail, iOS) that they should not invert
 *   these colours. The others invert anyway, and the only thing that helps
 *   against that is the choice of values: mid greys instead of pure black on
 *   pure white stay readable even inverted.
 */
const MAIL_FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

/**
 * How wide the content of a mail gets at most — pixels, as is customary in
 * mail building.
 *
 * As a string, because the value lands in markup in two places (the `width`
 * attribute that Outlook reads, and `max-width` in the `style` that everybody
 * else reads) and `restrict-template-expressions` rightly does not let a
 * number through there: letting a number slip into a string is the
 * construction with which `undefined` eventually stands in the markup as
 * „undefined".
 */
const MAIL_CONTENT_WIDTH = '600';

/**
 * The colours of the shell and of the tables, in one place.
 *
 * **Literals, and that is right here.** `formsache/no-hardcoded-colors`
 * demands design tokens instead of colour values in `apps/web/src/**` —
 * because a `var(--…)` resolves there. In a mail nothing resolves: there is no
 * stylesheet a client reliably loads, and a `var()` that does not resolve is
 * not a colour but no declaration at all. The rule therefore deliberately does
 * not reach into this package (`eslint.config.js` binds it to `apps/web`), and
 * the values stand together here **once** instead of scattered through the
 * strings below.
 */
const MAIL_COLORS = {
  /** Behind the card. */
  page: '#eceef1',
  /** The card itself. */
  card: '#ffffff',
  /** Body text. */
  text: '#1f2328',
  /** Captions, footer, „Bisher". */
  muted: '#5b6470',
  /** Separator lines. */
  rule: '#dfe3e8',
  /** The shaded area of a change. */
  panel: '#f4f6f8',
  /** „Neu" — the one colour accent a comparison really needs. */
  current: '#1a6f3c',
  /**
   * The link in the footer.
   *
   * **Not the organisation colour**, tempting as that would be: `accent` is a
   * freely chosen column and may be any `#rrggbb` — including `#ffffff`, and
   * then the only link of the mail would be invisible. A fixed value with
   * checked contrast on `card` (about 6.4:1) plus an underline, so that the
   * link is recognisable as one even where a client inverts the colour.
   */
  link: '#2f5aa8',
} as const;

/**
 * The organisation colour, as a `style` attribute may see it.
 *
 * **The value comes out of a database column, and a column is an arbitrary
 * string.** `style="background-color:${wert}"` with an unchecked value would
 * be exactly the injection `branding.ts` built its `HEX_COLOR` against — there
 * for CSS custom properties, here for an attribute in a mail. Hence **the
 * same** predicate call and no second spelling of it: `isBrandColor` is, by
 * its own documentation, „the single predicate behind both gates", and this is
 * the third.
 *
 * A value that does not get through costs the colour and not the mail — the
 * same direction `safeColor` in `branding.ts` takes for the screen.
 */
function shellAccent(accent: string | undefined): string {
  return accent !== undefined && isBrandColor(accent)
    ? accent
    : DEFAULT_TENANT_BRANDING.accent;
}

/**
 * Whom the base address in the footer belongs to — and thereby under which
 * brand the link stands there.
 *
 * **The label follows the address, never the other way round** (see
 * {@link MailShellLink}): an address of the organisation carries its name, the
 * one of the installation the name of the application. Were they two
 * independent statements, there would be a state in which the footer promises
 * „Formulare von „Ortsgruppe"" and points at a completely different host —
 * exactly the claim a recipient cannot check.
 */
export type MailShellLinkOwner = 'organisation' | 'installation';

/** Where the footer links to. */
export interface MailShellLink {
  /**
   * The base address, **without** a path — the start page, not a destination
   * in the application.
   *
   * It is sent through {@link normaliseBaseUrl} a second time here (see
   * {@link footerOf}); a value that does not pass that costs the link and not
   * the mail.
   */
  readonly url: string;
  /** See {@link MailShellLinkOwner}. */
  readonly owner: MailShellLinkOwner;
}

/** What {@link wrapMailBody} knows about the sender — all of it optional. */
export interface MailShell {
  /**
   * The accent colour of the organisation as `#rrggbb`.
   *
   * If it is missing or unusable, {@link DEFAULT_TENANT_BRANDING} applies —
   * the same default the screen shows for an organisation without an
   * appearance of its own.
   */
  readonly accent?: string;
  /**
   * The name of the organisation for the footer and the document title.
   *
   * ⚠️ **A foreign value like any other** (ADR-0026): somebody with
   * `can_manage_settings` typed it, and since the footer also stands in the
   * **text version**, a `\n` in it is no longer a trifle but an additional
   * line in a mail that goes out under a foreign identity. It therefore runs
   * through {@link collapseWhitespace} (gate 2) and, in the HTML version,
   * additionally through {@link escapeHtml}.
   *
   * If it is missing — or nothing is left after the folding — the footer stays
   * with the sentence that gets by without a name; never a placeholder a
   * recipient would have to read.
   */
  readonly organisation?: string;
  /**
   * The link into the system that the footer carries — or none at all.
   *
   * **Which of the two base addresses stands here is the caller's decision**,
   * and on the same condition it also picks the mail server by: if the row
   * belongs to the installation (`trigger = 'system'`), it is the
   * installation's address, otherwise the organisation's. This function does
   * not know the rule and must not know it — it has no database and no row.
   *
   * If it is missing, the footer stays without a link. **A mail without a link
   * is better than one with a broken one**, and the link is not a
   * load-bearing one here: it announces nothing that would be missing without
   * it. That is why „keine Adresse hinterlegt" is an `undefined` here and not
   * the `kind: 'dead'` with which `QueuedBodyRenderer` answers a missing
   * **reset** link.
   */
  readonly link?: MailShellLink;
}

/**
 * The name of the application, as a footer shows it.
 *
 * Only the label of the **installation's own** address — whoever gets an
 * operational alert, an invitation or a reset mail has an account and knows
 * the word. It says nothing to a participant, and they do not see it either:
 * their confirmation comes from an organisation and carries its name (see
 * {@link footerOf}).
 */
const MAIL_APP_NAME = 'Formsache';

/**
 * The sentence in the footer of every mail.
 *
 * Fixed text of this application, German like every interface text, and
 * deliberately without a call to action: a confirmation, a notice to the
 * office and a reset mail have nothing in common that one could advise about
 * here. What they do have in common is that nobody typed them.
 */
const MAIL_FOOTER_NOTE = 'Diese E-Mail wurde automatisch erzeugt.';

/**
 * The footer, computed **once** — for both versions.
 *
 * What comes out here is unescaped plain text: the text version takes it as it
 * is, the HTML version sends every part through {@link escapeHtml}
 * individually. Two computations would be two footers drifting apart — the
 * mistake `html-text.ts` describes in its own header.
 *
 * ## The second gate for the address
 *
 * `normaliseBaseUrl` stands here a second time, although every caller in the
 * server has already read it normalised (`PublicUrlService`). The same
 * two-gate construction that `branding.ts` describes for the colours and
 * ADR-0026 for the names — and here with a weight of its own, because this
 * value is the only one that gets into an `href`:
 *
 * - `safeExternalUrl` below lets **only** `http:` and `https:` through, so
 *   never a `javascript:` or `data:` — the attack an `href` otherwise
 *   carries;
 * - `URL.href` escapes `"`, `<` and `>` in the path itself, but **not** `'`.
 *   The attribute therefore stands in double quotes *and* goes through
 *   {@link escapeHtml}; either one on its own would be a hole.
 *
 * A value that does not get through costs the link and not the mail — the
 * same direction {@link shellAccent} takes for the colour.
 */
function footerOf(shell: MailShell): MailFooter {
  const organisation = collapseWhitespace(shell.organisation ?? '');
  const note =
    organisation === ''
      ? MAIL_FOOTER_NOTE
      : `${organisation} · ${MAIL_FOOTER_NOTE}`;

  if (shell.link === undefined) {
    return { organisation, note, link: null };
  }
  const url = normaliseBaseUrl(shell.link.url);
  if (url === null) {
    return { organisation, note, link: null };
  }
  return {
    organisation,
    note,
    link: {
      url,
      // **Not the bare address.** What a participant recognises is the name
      // of their organisation; „Formsache" says nothing to them. If the name is
      // missing (a deleted row), the brand of the installation remains — that
      // is the statement that is still true then.
      label:
        shell.link.owner === 'organisation' && organisation !== ''
          ? `Formulare von „${organisation}"`
          : `Zu ${MAIL_APP_NAME}`,
    },
  };
}

/** The footer as plain text, before either of the two versions inserts it. */
interface MailFooter {
  /** The folded name of the organisation, or `''`. */
  readonly organisation: string;
  /** The first line: origin and the sentence nobody typed. */
  readonly note: string;
  /** The second line, or none at all. */
  readonly link: { readonly url: string; readonly label: string } | null;
}

/**
 * **The shell: a rendered body becomes a deliverable mail** — in both
 * versions, in one place.
 *
 * ## Why it is *one* function for both versions
 *
 * `text` and `html` are two versions of **the same** message, and the text
 * version is the half that gets forgotten (ADR-0026 says that about the
 * foreign values, and it holds for the frame just as much). Two exported
 * functions would be two opportunities not to call one of them — and what
 * would have come out is an HTML mail with a footer next to a text version
 * without one. That is why this function takes both and returns both;
 * `wrapMailHtml` and `wrapMailText` below it are module-private.
 *
 * ## What it carries — and what expressly not
 *
 * A `<!doctype>`, a `<head>` with character set and viewport, a centred card
 * of fixed maximum width, a stripe in the organisation colour, a footer with
 * the link into the system. **No image** — not as a `cid:` attachment, not as
 * a logo, not as a product mark, and that is a decision of the user and not an
 * omission: an embedded image would need the attachment machinery of the
 * transport, would be loaded by many clients only on request and is a known
 * cause of delivery problems. What the mail shows of the organisation is its
 * colour, its name and its address.
 *
 * ## Why the shell comes into being at **delivery** and not at the enqueue
 *
 * `mail_log.body_html` holds the body that was frozen at the enqueue: the
 * words of the notification, the answer values, the date — everything a
 * confirmation *promises*. The shell promises nothing; it is frame. Laying it
 * at delivery (`QueuedBodyRenderer`) has three consequences, all of which
 * point in the right direction:
 *
 * 1. Every delivered mail gets it — including the system mails, which write
 *    their body in a completely different place, and every one there will be
 *    in future. A shell at the enqueue would have to stand at every enqueue
 *    path individually.
 * 2. The detail view of the mail log goes through the same renderer
 *    and therefore shows exactly what went out.
 * 3. Colour, name and base address of the organisation do not have to be
 *    passed through the enqueue path, where they would be three columns right
 *    across three modules.
 *
 * The price is named: if an organisation changes its colour or its address
 * while a mail lies in the queue, it goes out with the new one. That is the
 * frame, not the promise — and for the frame „die Adresse von heute" is the
 * right answer, because the old one may well no longer answer at all.
 *
 * ## Wrapping twice must not happen
 *
 * Three callers: `QueuedBodyRenderer` (the queue and, redacted, the detail
 * view of the mail log), `TestMailService` and `OpsAlertService`. The
 * latter two go past the queue and therefore have to call it themselves — an
 * operational alert about the backlog of the queue that landed in that queue
 * itself would stand behind the backlog it reports. A second call on an
 * already wrapped document would give an `<html>` inside a `<body>`; the
 * function does not check for that, because a check of that kind would be a
 * text search and text searches in bodies are exactly what
 * `QueuedBodyRenderer` expressly avoids elsewhere. Instead: **one** call per
 * path, and that is recorded here.
 */
export function wrapMailBody(
  body: MailBodyPair,
  shell: MailShell = {},
): MailBodyPair {
  const footer = footerOf(shell);
  return {
    text: wrapMailText(body.text, footer),
    ...(body.html === undefined
      ? {}
      : { html: wrapMailHtml(body.html, shell, footer) }),
  };
}

/**
 * Both versions of a mail, as the transport takes them — `text` always, `html`
 * optionally.
 *
 * The same shape `RenderedMailBody` already has on the send side; it stands
 * here because {@link wrapMailBody} takes it and returns it and a caller thus
 * has nothing to repack.
 */
export interface MailBodyPair {
  readonly text: string;
  readonly html?: string;
}

/**
 * The footer of the **plain-text version** — two lines behind two blank lines.
 *
 * ## A link is an address here
 *
 * In `text/plain` there is no label behind which anything could be hidden:
 * what stands there is the URL, and it has to stay readable. It therefore
 * stands at the **end of the line**, behind a colon — that way every client
 * that makes addresses clickable recognises it, and no punctuation mark sticks
 * to its end. (A closing full stop would be exactly the mistake: half the
 * clients would take it along into the address.)
 *
 * ## No `--` as a separator
 *
 * The obvious choice would be the signature mark from RFC 3676, and it would
 * be wrong: quite a few clients **hide** everything behind it or show it
 * greyed out and collapsed. The link would then be gone in precisely those
 * mailboxes where it is needed. Two blank lines separate just as clearly and
 * hide nothing.
 *
 * `trimEnd` on the body, so that the trailing `\n` of most bodies and the two
 * blank lines here do not become three. It removes whitespace at the end only
 * — it cannot touch an already filled mark, which the order in
 * `QueuedBodyRenderer` presupposes.
 */
function wrapMailText(body: string, footer: MailFooter): string {
  const lines = [
    body.trimEnd(),
    '',
    '',
    footer.note,
    ...(footer.link === null
      ? []
      : [`${footer.link.label}: ${footer.link.url}`]),
  ];
  return `${lines.join('\n')}\n`;
}

/** The HTML version of the shell — see {@link wrapMailBody}. */
function wrapMailHtml(
  body: string,
  shell: MailShell,
  footer: MailFooter,
): string {
  const accent = shellAccent(shell.accent);
  const title =
    footer.organisation === '' ? 'Nachricht' : escapeHtml(footer.organisation);

  return [
    '<!doctype html>',
    '<html lang="de">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    // Both names, because the clients do not agree on which one they read.
    '<meta name="color-scheme" content="light only" />',
    '<meta name="supported-color-schemes" content="light only" />',
    `<title>${title}</title>`,
    '</head>',
    `<body style="margin:0;padding:0;width:100%;background-color:${MAIL_COLORS.page};-webkit-text-size-adjust:100%">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;background-color:${MAIL_COLORS.page}">`,
    '<tbody><tr>',
    '<td align="center" style="padding:24px 12px">',
    `<table role="presentation" width="${MAIL_CONTENT_WIDTH}" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:${MAIL_CONTENT_WIDTH}px;background-color:${MAIL_COLORS.card}">`,
    '<tbody>',
    // The stripe. `font-size:0;line-height:0` and an `&nbsp;`, because an
    // empty cell collapses in Outlook and the stripe is then missing.
    `<tr><td style="height:4px;background-color:${accent};font-size:0;line-height:0">&nbsp;</td></tr>`,
    `<tr><td style="padding:28px 28px 20px 28px;font-family:${MAIL_FONT};font-size:15px;line-height:1.55;color:${MAIL_COLORS.text};word-break:break-word">`,
    body,
    '</td></tr>',
    `<tr><td style="padding:16px 28px 24px 28px;border-top:1px solid ${MAIL_COLORS.rule};font-family:${MAIL_FONT};font-size:12px;line-height:1.5;color:${MAIL_COLORS.muted}">`,
    `<div>${escapeHtml(footer.note)}</div>`,
    // The link stands on a line of **its own** and carries a label, not an
    // address: a bare URL wraps in a 600-wide card and says less to a
    // participant than the name of their organisation anyway.
    ...(footer.link === null
      ? []
      : [
          `<div style="margin-top:6px"><a href="${escapeHtml(
            footer.link.url,
          )}" style="color:${MAIL_COLORS.link};text-decoration:underline">${escapeHtml(
            footer.link.label,
          )}</a></div>`,
        ]),
    '</td></tr>',
    '</tbody></table>',
    '</td></tr></tbody></table>',
    '</body>',
    '</html>',
  ].join('\n');
}

/**
 * `{{antworten}}` — the table of all answers.
 *
 * **Its own render path**, and that is the point: escaping the values that a
 * `{{frage:…}}` substitutes says nothing about the cells of this table. Both
 * paths are proven separately in the tests, because a fix applied to one of
 * them has repeatedly not reached the other.
 *
 * What both paths *share* is the defusing itself: every cell goes through
 * {@link neutralise}, the same function a substituted `{{frage:…}}` uses, in
 * the same order (escape first, break second). This table used to spell that
 * out a second time inline, and the line break in a cell was added there while
 * the substituted value went without one for a while — one mail, two
 * renderings of one answer. A third spelling is what {@link renderChangeTable}
 * below deliberately does not add.
 *
 * **Styled ever since {@link wrapMailHtml} exists** — the paragraph there
 * gives the reason for the about-turn from the „kein Styling" sentence that
 * stood here. Two columns with `valign="top"`, a separator line per row,
 * `width:100%` on the table: that is the form that is still readable on a
 * phone without a client having to evaluate a media query. The caption column
 * is narrower than the value column and is not set to fixed pixels, so that a
 * long question wording wraps instead of pushing the values out.
 *
 * **`margin:0` — the spacing around the table belongs to the template**, not
 * to this function. A margin of its own here would come on top of the `<br />`
 * that a blank line in the template produces anyway (`neutraliseLiteral`), and
 * the spacing would count twice — exactly the mistake the default templates
 * had with their `<p>` paragraphs. This way the same rule holds in both
 * formats: a blank line in the template is a blank line in the mail.
 */
export function renderAnswerTable(
  answers: readonly MailLabelledValue[],
  format: MailFormat,
): string {
  if (answers.length === 0) {
    return '';
  }

  if (format === 'text') {
    return answers
      .map(
        (row) =>
          `${neutralise(row.label, format)}: ${neutralise(row.value, format)}`,
      )
      .join('\n');
  }

  const rows = answers
    .map(
      (row) =>
        `<tr><th align="left" valign="top" style="width:38%;padding:9px 14px 9px 0;border-bottom:1px solid ${MAIL_COLORS.rule};font-family:${MAIL_FONT};font-size:14px;font-weight:600;line-height:1.45;color:${MAIL_COLORS.muted};text-align:left">` +
        `${neutralise(row.label, format)}</th>` +
        `<td valign="top" style="padding:9px 0;border-bottom:1px solid ${MAIL_COLORS.rule};font-family:${MAIL_FONT};font-size:15px;line-height:1.45;color:${MAIL_COLORS.text};word-break:break-word">` +
        `${neutralise(row.value, format)}</td></tr>`,
    )
    .join('');

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;margin:0">` +
    `<tbody>${rows}</tbody></table>`
  );
}

/**
 * What an empty side of a change reads as — „vorher nichts", „jetzt nichts".
 *
 * A newly answered question and a cleared one are changes like any other, and
 * an empty cell next to a filled one would look like a rendering fault rather
 * than like the statement it is. Our own literal, never neutralised: it is not
 * a value and does not come from anybody outside.
 */
const BLANK_CHANGE_VALUE = '(leer)';

/**
 * What the two sides of a change are called — **and the caption now stands at
 * every value, not once above a column.**
 *
 * Before, those were three column headings (`Frage | Bisher | Neu`) of a table
 * that collapsed to about a hundred pixels per column on a phone. A heading
 * that stands three lines away from its value no longer helps there; it is the
 * reason the assignment „which value is the old one" had to be established
 * anew on every read. Now every value carries its own word — in HTML as in the
 * text.
 */
const CHANGE_LABELS = { previous: 'Bisher', current: 'Neu' } as const;

/**
 * What stands before the two values in the text, brought to the same width.
 *
 * The alignment is the whole purpose: values standing below one another with a
 * flush left edge are read as a comparison, indented ones with different
 * starting columns as two unconnected lines. Fixed spaces, no tabs — a tab is
 * a different width in every mail client.
 */
const CHANGE_TEXT_PREFIX = {
  previous: `  ${CHANGE_LABELS.previous}: `,
  current: `  ${CHANGE_LABELS.current}:    `,
} as const;

/**
 * How the **continuation lines** of a multi-line value are indented.
 *
 * Without it the second line of a remark starts at the left edge and looks
 * like a new question — a text version that becomes unreadable precisely where
 * the value is long enough to be interesting. A value can be multi-line as
 * soon as somebody presses Enter in a text field; `stripMarkup` passes these
 * breaks through, and that is right.
 *
 * Both prefixes are the same length (ten characters), so that the values stand
 * flush — this indentation hangs on that, and a test records it.
 */
const CHANGE_TEXT_INDENT = ' '.repeat(CHANGE_TEXT_PREFIX.previous.length);

/** One value for the text version, with indented continuation lines. */
function indentContinuation(value: string): string {
  return value.replace(/\n/g, `\n${CHANGE_TEXT_INDENT}`);
}

/** One side of a change, defused — or the marker when there is nothing to show. */
function changeValue(value: string, format: MailFormat): string {
  return value.trim() === '' ? BLANK_CHANGE_VALUE : neutralise(value, format);
}

/**
 * `{{aenderungen}}` — what this edit changed, old value beside new one.
 *
 * **The same escaping as everything else a stranger contributed**
 * ({@link neutralise}), and that is not a detail: *both* sides come out of a
 * public form, the old one having sat in the database in between. A second
 * defusing path here is precisely the duplication that let a substituted value
 * lose its line breaks while the literal template text kept them (Review zu
 * `8797060`) — and this time it would sit on a security boundary rather than on
 * a formatting one.
 *
 * **Empty when nothing changed, and empty is also what a submission gets**: the
 * caller passes no changes for anything that is not an edit, exactly as
 * `{{bearbeiten}}` resolves to nothing when there is no link. The text around
 * the placeholder stands either way.
 *
 * ## Why this is no longer a three-column table (finding 34)
 *
 * Until 2026-08-15 it was exactly that: `Frage | Bisher | Neu`, without a
 * frame, without emphasis. On a phone a client divides 320 pixels among three
 * columns, and what is left is a question over four lines next to two values
 * over three each — side by side, but no longer comparable. That was precisely
 * the finding: „sehr schwer zu lesen".
 *
 * The form now is **one card per changed question**, one below the other:
 *
 * ```
 * ▌ Vorname
 * ▌ Bisher  Max        (grau, durchgestrichen)
 * ▌ Neu     Moritz     (dunkelgrün, fett)
 * ```
 *
 * Three decisions behind it, each against an alternative:
 *
 * 1. **Stacked instead of side by side.** A wrap then hits *one* value and not
 *    the grid. The card keeps its readability at any width, without a media
 *    query — which many clients do not evaluate anyway.
 * 2. **Two signals per side, not one.** „Bisher" is grey *and* struck
 *    through, „Neu" is dark green *and* bold, and both carry their word
 *    beside them. Whoever does not see the colour — colour blindness, an
 *    inverting dark mode, a client that discards colours — still reads the
 *    assignment off the word and the strikethrough (WCAG 1.4.1: colour never
 *    as the only means).
 * 3. **The bar on the left is not the organisation colour.** The colour of the
 *    organisation is carried by the shell ({@link wrapMailHtml}); here colour
 *    means „alt gegen neu" and not „wir". A comparison that means something
 *    different in the club red of one organisation and the club blue of
 *    another would be the worse of the two statements.
 *
 * **The text version has moved along**, for the same reason: `Label: alt → neu`
 * is, with two long values, one line in which one searches for the arrow. Now
 * the question stands on a line of its own and below it the two values, with
 * flush-aligned captions and a blank line between the entries.
 */
export function renderChangeTable(
  changes: readonly MailChangeRow[],
  format: MailFormat,
): string {
  if (changes.length === 0) {
    return '';
  }

  if (format === 'text') {
    return changes
      .map(
        (row) =>
          `${neutralise(row.label, format)}\n` +
          `${CHANGE_TEXT_PREFIX.previous}${indentContinuation(changeValue(row.previous, format))}\n` +
          `${CHANGE_TEXT_PREFIX.current}${indentContinuation(changeValue(row.current, format))}`,
      )
      .join('\n\n');
  }

  const rows = changes.map((row) => changeCard(row, format)).join('');

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;margin:0">` +
    `<tbody>${rows}</tbody></table>`
  );
}

/**
 * One card — the row of the outer table plus the inner one that carries the
 * background and the bar.
 *
 * Two tables nested and not one with `padding-bottom`: the spacing *between*
 * the cards belongs to the outer cell, the area *below* the content to the
 * inner one. A single table would have to accommodate both in the same cell,
 * and the background would then run into the spacing.
 *
 * The bar is a cell of its own with a fixed width and not a `border-left`,
 * because Outlook treats borders on cells differently but draws a shaded cell
 * everywhere. `font-size:0;line-height:0` plus `&nbsp;` for the reason the
 * stripe of the shell has it.
 */
function changeCard(row: MailChangeRow, format: MailFormat): string {
  const label = neutralise(row.label, format);
  const previous = changeValue(row.previous, format);
  const current = changeValue(row.current, format);

  const side = (caption: string, value: string, valueStyle: string): string =>
    `<div style="margin:0;padding:2px 0">` +
    `<span style="display:inline-block;min-width:56px;font-size:12px;color:${MAIL_COLORS.muted}">${caption}</span>` +
    `<span style="${valueStyle}">${value}</span></div>`;

  return (
    `<tr><td style="padding:0 0 10px 0">` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;background-color:${MAIL_COLORS.panel}">` +
    `<tbody><tr>` +
    `<td width="4" style="width:4px;background-color:${MAIL_COLORS.muted};font-size:0;line-height:0">&nbsp;</td>` +
    `<td style="padding:10px 14px;font-family:${MAIL_FONT};font-size:15px;line-height:1.5;color:${MAIL_COLORS.text};word-break:break-word">` +
    `<div style="margin:0 0 4px 0;font-weight:700;color:${MAIL_COLORS.text}">${label}</div>` +
    side(
      CHANGE_LABELS.previous,
      previous,
      `color:${MAIL_COLORS.muted};text-decoration:line-through`,
    ) +
    side(
      CHANGE_LABELS.current,
      current,
      `color:${MAIL_COLORS.current};font-weight:600`,
    ) +
    `</td></tr></tbody></table>` +
    `</td></tr>`
  );
}

export interface RenderMailTemplateInput {
  /** Subject or body of one notification. */
  readonly template: string;
  readonly format: MailFormat;
  readonly context: MailTemplateContext;
  /**
   * What `{{bearbeiten}}` becomes here. Defaults to {@link NO_EDIT_LINK}.
   *
   * The default is „kein Link", not „defer": a caller that has not decided must
   * not be able to ship a mark into a finished string. Only the enqueue of a
   * queued mail passes {@link DEFERRED_EDIT_LINK}, and it is the only place
   * whose output is filled in later.
   */
  readonly editLink?: EditLinkSlot;
}

/**
 * Renders one template field.
 *
 * The template is walked segment by segment, and **each segment is handled on
 * its own**:
 *
 * - literal text is the administrator's — in `'html'` it passes through as
 *   written (that is what choosing the HTML format means), in `'text'` its
 *   markup is removed, so a template pasted from a rich editor does not send
 *   tags to somebody reading plain text;
 * - a substituted value is a stranger's and is escaped or stripped;
 * - an **unknown** placeholder stays exactly as it was written. Including `{{frage:<id>}}` for a question the context does
 *   not carry: visible in the mail beats silently empty, and the publish lock
 *   built on `notificationQuestionIds` is what keeps it from happening.
 */
export function renderMailTemplate(input: RenderMailTemplateInput): string {
  const { template, format, context, editLink = NO_EDIT_LINK } = input;
  const byId = new Map(context.answers.map((row) => [row.questionId, row]));

  let out = '';
  let cursor = 0;

  for (const match of scanPlaceholders(template)) {
    out += neutraliseLiteral(template.slice(cursor, match.start), format);
    out += renderPlaceholder(match, format, context, byId, editLink);
    cursor = match.end;
  }

  const rendered = out + neutraliseLiteral(template.slice(cursor), format);

  /*
    A leading `<p>` and a trailing `</p>` now each leave a line break behind
    (see `stripMarkup`), and a mail that starts with a blank line is the kind
    of detail that gets „fixed" by removing the line breaks again. Trimmed
    **here**, on the assembled string, and never per segment: a segment ends
    where a placeholder begins, so trimming there would eat the space in
    „Hallo {{frage:…}} ," — the one place where whitespace is the author's.
    Blank lines *inside* stay as they are; they may be an answer's own.
  */
  return format === 'html' ? rendered : rendered.trim();
}

/**
 * Literal template text: trusted for its own format, see `renderMailTemplate`.
 *
 * **In HTML the line breaks the author typed become `<br />`.** The template
 * editor is a plain textarea, so a paragraph break in it is a real `\n` — and
 * HTML folds those away. A confirmation that read as three paragraphs in the
 * editor and in the `text/plain` alternative arrived at the recipient as one
 * run-on line ending in „… Mit freundlichen Grüßen Ortsgruppe
 * Musterstadt".
 *
 * Nothing is escaped here and nothing may start to be: this segment is the
 * administrator's markup, which is what choosing the HTML format means. The
 * `\n` is *added to*, not derived from, untrusted input — every stranger's
 * value goes through {@link neutralise} instead, where the order is escape
 * first, break second (as in {@link renderAnswerTable}), so a value can never
 * contribute the `<` of a `<br />`.
 *
 * The `\n` is kept alongside the tag rather than replaced by it, so the source
 * of the mail stays readable in a client that shows it and in `mail_log`.
 */
function neutraliseLiteral(literal: string, format: MailFormat): string {
  return format === 'html'
    ? literal.replace(/\n/g, '<br />\n')
    : stripMarkup(literal);
}

function renderPlaceholder(
  match: PlaceholderMatch,
  format: MailFormat,
  context: MailTemplateContext,
  byId: ReadonlyMap<string, MailAnswerRow>,
  editLink: EditLinkSlot,
): string {
  const { placeholder } = match;

  if (placeholder.kind === 'system') {
    switch (placeholder.name) {
      case 'formularorganisation':
        return neutralise(context.formularorganisation, format);
      case 'formular':
        return neutralise(context.formular, format);
      case 'datum':
        return neutralise(context.datum, format);
      case 'antworten':
        return renderAnswerTable(context.answers, format);
      case 'aenderungen':
        // Empty for a mail that is not a correction — the caller carries no
        // changes then, and the surrounding text stays whole (see
        // `renderChangeTable`).
        return renderChangeTable(context.changes, format);
      case 'bearbeiten':
        // The one placeholder whose value is not in the context: either a mark
        // for the send step, or the finished link (see {@link EditLinkSlot}).
        return editLink.kind === 'deferred'
          ? EDIT_LINK_MARK
          : renderEditLink(editLink.url, format);
    }
  }

  if (placeholder.kind === 'question') {
    const row = byId.get(placeholder.questionId);

    if (row !== undefined) {
      return neutralise(row.value, format);
    }
  }

  // Unknown, or a question the context does not carry: verbatim. Passed
  // through the literal handling so a template author cannot smuggle markup
  // into a plain-text mail by writing it between braces.
  return neutraliseLiteral(match.raw, format);
}

/**
 * Removes everything from a subject line that could start a second header.
 *
 * A subject is one SMTP header field. A CR or LF in it and the rest of the
 * value becomes a header of its own — `Bcc:` on the second line is the
 * textbook case, and the value comes from a public form, so „could happen" is
 * „will be tried". Every C0 control character goes, not only CR and LF: they
 * have no business in a subject and the ones that are not CR/LF are the ones a
 * filter written for CR/LF alone would let through.
 *
 * A run of them becomes **one space**, not nothing: `Anmeldung\r\nBcc: …`
 * should stay readable as text rather than fuse into one word. The rest of the
 * subject is kept — a sanitiser that dropped the tail would „pass" a test for
 * absence of CR/LF while quietly sending empty subjects.
 */
export function sanitizeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex -- that is precisely the point.
  return subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** What a shortened subject ends with, so „gekürzt" is visible rather than guessed. */
const SUBJECT_ELLIPSIS = '…';

/**
 * Cuts a rendered subject down to {@link MAIL_SUBJECT_MAX} characters.
 *
 * **The limit on the template is not a limit on the result** — that is the
 * whole reason this exists. `MAIL_SUBJECT_MAX` bounds what an administrator may
 * *write*, and a written subject is mostly placeholders: `{{antworten}}` or a
 * `{{frage:…}}` pointing at a long-text question expands to whatever a stranger
 * typed into a public form, and an answer has no length limit of its own unless
 * the question sets one (`maxLength` defaults to `null`). Without this, a
 * 100 000-character subject reaches the recipient as an SMTP header and is kept
 * in `mail_log.subject` — the same asymmetry the recipient address was given
 * `.max(320)` for, and the one the address got and the subject did not.
 *
 * Applied **after** sanitising, because sanitising can only ever make a subject
 * shorter or equally long; the other order would allow a trailing run of
 * control characters to eat the last visible words.
 */
export function truncateSubject(subject: string): string {
  if (subject.length <= MAIL_SUBJECT_MAX) {
    return subject;
  }

  let cut = MAIL_SUBJECT_MAX - SUBJECT_ELLIPSIS.length;
  const last = subject.charCodeAt(cut - 1);
  // Never cut between the two halves of a surrogate pair — the result would be
  // a lone code unit, which is not text any more (an emoji in an answer is
  // enough to hit this).
  if (last >= 0xd800 && last <= 0xdbff) {
    cut -= 1;
  }

  return subject.slice(0, cut).trimEnd() + SUBJECT_ELLIPSIS;
}

/**
 * Subject line of one notification: rendered as **plain text** — a subject is
 * never markup — sanitised, and then bounded.
 *
 * **`{{bearbeiten}}` renders to nothing here**, by taking the default slot. A
 * subject is written to `mail_log.subject` when the answer arrives and is never
 * touched again, so a mark in it would still be a mark on the way out; and a
 * URL in a subject line is not a link in any mail client anyway. The link
 * belongs in the body, where the send step can fill it in.
 */
export function renderMailSubject(input: {
  readonly template: string;
  readonly context: MailTemplateContext;
}): string {
  return truncateSubject(
    sanitizeSubject(
      renderMailTemplate({
        template: input.template,
        format: 'text',
        context: input.context,
      }),
    ),
  );
}

/**
 * Result of reading a recipient list.
 *
 * `invalid` carries the rejected entries **verbatim**, because they are
 * rejected rather than silently dropped: the editor shows
 * them back to the administrator, and the log says which address a notification
 * did not reach.
 */
export interface RecipientList {
  readonly addresses: string[];
  readonly invalid: string[];
}

/**
 * What separates two entries **in the editor's input box**: comma — as its hint
 * says — and line breaks, because a list gets pasted.
 *
 * **`;` is deliberately not a separator.** German mail clients use it, but
 * splitting on it would mean accepting `a@b.de;c@d.de` as two addresses, and
 * then the same reasoning would accept the next separator somebody's value
 * happens to contain. An entry with a semicolon in it fails validation and is
 * reported — visible beats convenient.
 */
const RECIPIENT_SEPARATOR = /[,\r\n]/;

/**
 * One address, as strictly as the rest of the system reads one — **the one
 * spelling** from `auth.ts` and not a fourth copy of it (review finding 10).
 */
const addressSchema = emailAddressSchema;

function splitEntries(raw: string): string[] {
  return raw
    .split(RECIPIENT_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * Reads what the administrator **typed** into the recipient box — one comma-
 * separated string — on its way into the stored, structured form.
 *
 * This is the editor's input path, **not** the render path: what a notification
 * stores is a list of {@link NotificationRecipient} entries, and what goes out
 * is resolved by {@link resolveRecipients}. Splitting a string is acceptable
 * here precisely because the string is the administrator's own typing; it is
 * never applied to a value that came out of an answer.
 *
 * **Every entry is validated on its own**, and an invalid one is *reported*,
 * never dropped. `Max <evil@example.com>` is one entry and one rejection — not
 * a display name that is quietly discarded, and not an extra recipient. The
 * whole point is that the number of addresses that come out is the number of
 * addresses somebody chose.
 *
 * Addresses are lower-cased and de-duplicated: the mail log keeps one row per
 * recipient, and the same person twice in one list is a typo, not
 * a request for two mails.
 */
export function parseRecipientList(raw: string): RecipientList {
  return validateEntries(splitEntries(raw));
}

/** Validation and de-duplication, shared by both readers of a list. */
function validateEntries(entries: readonly string[]): RecipientList {
  const addresses: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const parsed = addressSchema.safeParse(entry);

    if (!parsed.success) {
      invalid.push(entry);
      continue;
    }

    if (!seen.has(parsed.data)) {
      seen.add(parsed.data);
      addresses.push(parsed.data);
    }
  }

  return { addresses, invalid };
}

/**
 * The stored recipient list of a notification, resolved against one answer
 * (a recipient may come from a question too).
 *
 * **One entry resolves to exactly one address, or to none — never to two.**
 * That is the whole safety property of this function, and the reason the stored
 * shape is a list of entries rather than one string: a participant who types
 * `me@example.de, victim@example.com` into the e-mail question would otherwise
 * turn one chosen recipient into two, and the form is public — that is an open
 * relay, not an edge case. Resolved per entry, such a value stays one entry,
 * and one entry containing a comma is not an address, so it lands in `invalid`.
 * Nothing here splits, and nothing here may start to.
 *
 * An entry that resolves to nothing (an optional question left blank) is
 * skipped: there is no address to reject. A question the response does not
 * carry at all is different — it is reported as its placeholder token, because
 * a notification whose recipient reference points into the void must be visible
 * rather than silently short of one address. A list that resolves to no address
 * at all therefore comes back empty, which the caller has to handle; it is not
 * an error of this function.
 */
export function resolveRecipients(
  recipients: readonly NotificationRecipient[],
  context: MailTemplateContext,
): RecipientList {
  const byId = new Map(context.answers.map((row) => [row.questionId, row]));
  const entries: string[] = [];

  for (const recipient of recipients) {
    if (recipient.kind === 'literal') {
      entries.push(recipient.address);
      continue;
    }

    const row = byId.get(recipient.questionId);

    if (row === undefined) {
      entries.push(questionPlaceholderToken(recipient.questionId));
      continue;
    }

    const value = row.value.trim();

    if (value !== '') {
      entries.push(value);
    }
  }

  return validateEntries(entries);
}

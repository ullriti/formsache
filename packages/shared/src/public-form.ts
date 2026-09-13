import { z } from 'zod';

import {
  UPLOAD_CONTENT_TYPES,
  fileRefSchema,
  isFileRef,
} from './file-types.ts';
import { formDefinitionSchema } from './form-schema.ts';
import { tenantBrandingSchema, tenantLogoSchema } from './branding.ts';
import { publicFormPrivacyNoticeSchema } from './legal.ts';
import {
  availabilityStateSchema,
  type PublicAvailability,
} from './form-availability.ts';
import {
  PASSWORD_MAX,
  REDIRECT_DELAY_MAX,
  TIME_LIMIT_MIN_MAX,
  effectiveRedirect,
  externalUrlSchema,
  type FormSettings,
  type RedirectTarget,
} from './form-settings.ts';

/**
 * Wire contract of the public fill-in endpoints.
 *
 * These are the only routes of the application anyone on the internet may
 * call, and the contract is written with that in mind: the answer carries
 * exactly what the fill-in view has to render and **nothing else**. No form
 * id, no tenant id, no counts, no status — a participant needs the questions
 * and the organisation's name above them; everything further would be information the
 * public did not have before.
 *
 * ## Where the line runs: what binds, not what defends
 *
 * „Ein Verdikt, nie die Konfiguration dahinter" was the rule this payload was
 * built on, and it was too coarse: it forbade the **time limit**, which is a
 * configured number *and* a condition somebody has to work under. Finding 32
 * paid for that in the only currency this surface has — a participant who typed
 * thirty fields, pressed *Absenden* and met a `time_limit`-409 that nothing had
 * announced.
 *
 * The line since then is narrower and, unlike the old one, holds a reason:
 *
 * - **Public is what *binds* the participant** — the deadline, the time limit, that
 *   a Veranstaltung is „ausgebucht", which actions this view offers. A binding
 *   is a condition somebody can only *keep* if they know it, and they learn it
 *   anyway, at the latest from the refusal it produces. Hiding it does not
 *   protect anything; it only moves the moment of learning to the point where
 *   their work is already done.
 * - **Not public is what *defends* the form** — whether an access word is set
 *   and what it is, the Antwortlimit and how full it is, the mail budgets, the
 *   rate limits, ids and counts. Two different things live here, and both fail
 *   the same test: a defence that works by not being known is weakened by being
 *   published, and a number like „noch 4 von 200" is a statement about the
 *   *organisation's* registration state, which belongs to nobody outside it.
 *
 * The test to apply to the next field is therefore not „is this configuration"
 * but: **can the participant do something differently by knowing it, and does
 * knowing it tell anyone anything about the organisation or about how the form
 * defends itself?** The deadline and the time limit answer yes/no; `maxResponses`
 * answers no/yes and stays behind its verdict (`availability.state ===
 * 'limit_reached'`), which is what a verdict is for.
 */

/**
 * What an accepted upload answers with (ADR-0014).
 *
 * **Here rather than in the API**, like every other message of the public
 * routes: the browser parses this answer and then carries `ref` and `fileName`
 * straight into the answer it submits, so „was kommt zurück" and „was geht
 * hinein" are two halves of one contract. The API's own return type is
 * `z.infer` of this, so the two cannot drift.
 *
 * Everything in it is the **server's** reading of the upload, never the
 * caller's: `contentType` is derived from the signature of the content,
 * `fileName` is the NFC-normalised name as it was stored, `byteSize` is what
 * `put()` reported it wrote. The participant's view has to show what the server
 * actually kept, or „hochgeladen" is a claim about a different file.
 */
export const uploadedFileSchema = z.object({
  ref: z.string().refine(isFileRef, { error: 'Kein gültiger Dateiverweis.' }),
  fileName: z.string().min(1),
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
  byteSize: z.number().int().nonnegative(),
});
export type UploadedFile = z.infer<typeof uploadedFileSchema>;

export function parseUploadedFile(source: unknown): UploadedFile {
  return uploadedFileSchema.parse(source);
}

/** The organisation a public form belongs to, as its header shows it. */
export const publicTenantSchema = z.object({
  name: z.string().min(1),
  shortName: z.string().min(1),
  /**
   * The logo — a shipped asset, the organisation's own upload, or none.
   *
   * This is the page **strangers** open, so it is the one place where a
   * `logo_ref` that is neither would decide what an unauthenticated visitor's
   * browser goes and fetches. `z.string()` here made that a promise of the
   * resolver alone; the union carries it in the contract instead — `kind` picks
   * the resolver, and the `upload` arm only ever reaches this payload for a
   * file the query proved to belong to the form's Organisation (ADR-0014 no. 12,
   * `files/owned-logo.ts`).
   */
  logoRef: tenantLogoSchema,
  branding: tenantBrandingSchema,
});
export type PublicTenant = z.infer<typeof publicTenantSchema>;

/**
 * The three *Darstellung* flags, and only those.
 *
 * Spelled out field by field rather than derived from the settings schema: a
 * section that grows would otherwise start travelling to the public
 * without anybody deciding it should. The server states the same list a second
 * time (`public-forms.service.ts`), which is the point — one side decides what
 * it sends, the other decides what it accepts, and a field that appears on only
 * one of them goes nowhere.
 */
export const publicDisplaySchema = z.object({
  showProgress: z.boolean(),
  showPageNumbers: z.boolean(),
  showRequiredHint: z.boolean(),
});
export type PublicDisplay = z.infer<typeof publicDisplaySchema>;

/**
 * The verdict a participant is given — three fields, not the
 * four `FormAvailability` carries.
 *
 * `satisfies` rather than a duplicate type: the projection
 * `publicAvailability()` produces is defined by `Omit` over the verdict, and
 * this line fails to compile if the two ever describe different things.
 */
export const publicAvailabilitySchema = z.object({
  state: availabilityStateSchema,
  opensAt: z.iso.datetime().nullable(),
  closesAt: z.iso.datetime().nullable(),
}) satisfies z.ZodType<PublicAvailability>;

/**
 * The signed start token.
 *
 * Opaque here on purpose: its inside is the server's business
 * (`apps/api/src/public/start-token.service.ts`), and a shape described on the
 * wire is a shape somebody starts constructing. All the contract says is that
 * a participant receives one with the form and hands the same one back with the
 * submission.
 *
 * **It travels with every form, not only with one that has a time limit** —
 * but no longer for the reason it was given. That reason was concealment: the
 * presence of the field would otherwise say whether the setting is on. Since
 * {@link publicFormSchema.timeLimitMin} that is no longer a secret to keep, and
 * it was the right one to give up (see the line at the top of this file: a limit
 * binds the participant, and one they cannot see is one they cannot keep).
 *
 * What survives is the plainer half, and it was always the stronger one: one
 * payload shape for every form means one client code path — a browser that mints
 * nothing, decides nothing and simply hands back what it was given. A token
 * issued only sometimes is an `if` in every consumer, and the consumer that
 * forgets it submits a form with a limit without one. Issuing it always costs
 * one HMAC.
 */
const START_TOKEN_MAX = 400;
export const startTokenSchema = z.string().min(1).max(START_TOKEN_MAX);

/**
 * Why a submission was refused.
 *
 * On the wire because both sides need the same list: the API builds the 409
 * body from it, and a client that wants to say more than „ging nicht" reads it.
 * The first three names are the non-open {@link AvailabilityState}s — the same
 * three words the read path already uses for its verdict, so „geschlossen" is
 * not called one thing when it is shown and another when it is enforced.
 *
 * `time_limit` is the fourth and has no counterpart in the verdict: a form with
 * a running time limit is *open*, and only the individual attempt has run out.
 * It answers a missing, stale, forged and tampered token **alike** — telling
 * them apart would turn the refusal into an oracle about the signature.
 *
 * `password_required` is the fifth and works the same way: a
 * missing, expired, forged or foreign access proof is one answer, because the
 * only thing the participant can do about any of them is enter the word again.
 * It tells a caller nothing the read path did not already say out loud — a
 * protected form announces itself as protected before anybody submits anything.
 *
 * `editing_disabled` is the sixth and belongs to the **edit** route
 * alone. It is in this list rather than in one of its own because it is the
 * same statement as the other five — „der Zustand dieses Formulars verträgt sich
 * nicht mit dieser Anfrage" — and because a second enum would let the two drift
 * into different sentences for the same 409. It says nothing a token holder does
 * not already know: they submitted this answer, so the form exists; only the
 * setting *Bearbeiten nach Absenden* has since been switched off. Somebody
 * **without** a valid token never gets this far — the token is resolved first
 * and answers the one 404 (`PUBLIC_FORM_NOT_FOUND_MESSAGE`).
 */
/**
 * `attachment_unavailable` and `attachment_limit` are the seventh and eighth,
 * and they belong to the attachments of ADR-0014 no. 13 .
 *
 * They are in this list rather than in one of their own for the reason the
 * sixth is: they are the same statement — „der Zustand dieses Formulars verträgt
 * sich nicht mit dieser Anfrage" — and a second enum would let the two drift
 * into different sentences for the same 409.
 *
 * `attachment_unavailable` is the **one** answer for all five conditions of the
 * claim: the file expired (older than the 24 hours after which the purge takes
 * it), it was already claimed by another submission, it belongs to another
 * Organisation, it was uploaded against another form, or it is a logo. Telling them
 * apart would be five oracles about rows the caller may not know exist, and the
 * only thing a participant can do about any of them is the same: upload the
 * file again. `attachment_limit` is the two per-answer numbers of no. 6 — ten
 * files and 25 MiB — which cannot be judged before an answer exists.
 */
/**
 * `event_full` is the ninth, and it is the **one refusal of this list that is
 * about a position rather than about the form** .
 *
 * The other eight say „dieses Formular verträgt sich nicht mit dieser Anfrage"
 * and there is nothing a participant can change about any of them. This one says
 * „diese *eine* Veranstaltung ist voll" — the rest of the registration is still
 * acceptable, so the sentence that goes with it is „bitte diese Angabe ändern"
 * and not „bitte später wiederkommen". That is what {@link
 * submissionRefusalPositionSchema} is for: the position travels machine-readable
 * so the fill-in view can mark the field the number stands in instead of showing
 * a page-level error over a form with six events on it.
 *
 * **Nothing is stored when it fires** . „Abgewiesen wird die
 * Position, nicht das Formular" is a statement about what the participant may do
 * next, **not** a licence to store the rest of the answer without the full
 * event: a submission that committed minus one position would confirm a
 * registration nobody made, and an integration test counts `response` rows to say so — a
 * refusal writes none.
 */
/**
 * `saving_disabled` is the tenth and belongs to the **draft** routes
 * alone — the exact counterpart of `editing_disabled` one door
 * along.
 *
 * In this list rather than in an enum of its own for the reason the sixth is:
 * it is the same statement — „der Zustand dieses Formulars verträgt sich nicht
 * mit dieser Anfrage" — and a second enum would let the two grow different
 * sentences for the same 409.
 *
 * **It answers both draft routes, the save and the resume**, because the switch
 * is read on *every* access and not when the address was handed out (the rule
 * stated for `allowEdit`). Somebody holding a draft address from last
 * week meets this the moment *Zwischenspeichern* is switched off, and so does
 * the fill-in view that offers the button.
 */
/**
 * `draft_already_submitted` is the eleventh, and it belongs to the **submission
 * out of a draft** (a review finding).
 *
 * „Erzeugt **eine** Antwort" is a promise about a draft address, not about a
 * click. Two tabs pressing *Absenden* on the same address used to produce two
 * answers — *measured on 2026-08-05:* two simultaneous submissions of the same
 * token, 200/200, **two** `response` rows and `SUM(seats) = 6` instead of 3 on
 * one event. The second one is refused with this reason, and it says
 * the one thing its sender can act on: their registration is filed, they need
 * do nothing.
 *
 * **It is not `limit_reached` and not `closed`.** Both of those are about the
 * form and are wrong here — the form is open, and this particular participant is
 * already in it. A caller that only reads the status still behaves correctly:
 * like every other 409 on this surface, repeating the request cannot help.
 */
/**
 * `draft_limit` is the twelfth and belongs to the **first save** of a draft
 * alone (a review finding).
 *
 * A form's drafts are written by strangers without a session, are visible to
 * nobody and are counted by nothing — the rate limit bounded the *speed* of
 * writing them and no total. This is the total. It names no number, for the
 * reason the whole message table gives, and it says what a participant can do:
 * fill the form in and send it.
 *
 * It fires on `POST …/drafts` only. Continuing an existing draft (`PUT`) adds no
 * row, so a bound on the count has nothing to say there — a participant who has
 * an address keeps it.
 */
export const submissionRefusalReasonSchema = z.enum([
  'not_yet_open',
  'closed',
  'limit_reached',
  'time_limit',
  'password_required',
  'editing_disabled',
  'attachment_unavailable',
  'attachment_limit',
  'event_full',
  'saving_disabled',
  'draft_already_submitted',
  'draft_limit',
]);
export type SubmissionRefusalReason = z.infer<
  typeof submissionRefusalReasonSchema
>;

/**
 * **Which** position a refusal fired on — the question and, inside it, the entry.
 *
 * Keys, never labels: `eventKey` is `EventEntry.key`, the same value the stored
 * answer and the export column are keyed by, so the client resolves it against
 * the definition it is already rendering. Sending the label instead would be a
 * second copy of a caption that an editor may rename between the read and the
 * submission — and the one thing a machine-readable position must not be is a
 * string that has to match another string.
 *
 * That is also why the German sentence beside it names **no** Veranstaltung: one
 * message per reason (`SUBMISSION_REFUSAL_MESSAGES`) stays a constant, and the
 * name a participant reads comes from the form in front of them.
 */
export const submissionRefusalPositionSchema = z.object({
  /** The `event` question the refusal belongs to. */
  questionId: z.string().min(1),
  /** The `EventEntry.key` that is full. */
  eventKey: z.string().min(1),
});
export type SubmissionRefusalPosition = z.infer<
  typeof submissionRefusalPositionSchema
>;

/**
 * The body of a refused submission — a readable sentence, the reason, and for
 * `event_full` the position it fired on.
 *
 * **`.optional()`, not `.nullable()`**, and it is the exception
 * `questionBaseShape.replaces` documents for the same reason: eight of the nine
 * reasons have no position, and demanding an explicit `position: null` in each
 * of them would turn every refusal body this application has ever sent — and
 * every client that parses one — into something that no longer matches. Absent
 * therefore means „diese Ablehnung hat keine Position", which is what absence
 * already meant.
 *
 * **One position, not a list.** A submission that names two full Veranstaltungen
 * gets the first in *definition* order and, once that one is corrected, the
 * second. Reporting all of them would be a wider contract for a case the fill-in
 * view already prevents (a full event is locked before anybody
 * types into it); what is left here is the race, and a race is lost on one
 * position at a time.
 */
export const submissionRefusalSchema = z.object({
  message: z.string().min(1),
  reason: submissionRefusalReasonSchema,
  position: submissionRefusalPositionSchema.optional(),
});
export type SubmissionRefusal = z.infer<typeof submissionRefusalSchema>;

/**
 * Reads a refusal body, or answers `undefined` — the tolerant counterpart of
 * {@link readValidationProblem} in `problem.ts`, and tolerant for the same
 * reason: the body of a failed request may be a proxy's HTML page, and that
 * must not become a sentence shown to a participant as if the server had said
 * it.
 */
export function readSubmissionRefusal(
  source: unknown,
): SubmissionRefusal | undefined {
  const parsed = submissionRefusalSchema.safeParse(source);
  return parsed.success ? parsed.data : undefined;
}

/**
 * **What one Veranstaltung looks like from outside** — „ausgebucht", and the
 * number only if the editor said so.
 *
 * ## Why this stands *beside* `definition` and not inside it
 *
 * The allow list draws exactly this line: `definition` is an
 * open list behind a round-trip lock (whatever it carries has to parse as
 * `formDefinitionSchema`), so a **server-derived** value smuggled into the
 * snapshot would pass unremarked. The remaining seats are the archetype of such
 * a value — nothing an editor typed, everything the database counted — so they
 * live in a payload key of their own, where the closed list sees them and
 * somebody has to justify sending them to strangers.
 *
 * ## The two fields are two different decisions
 *
 * - **`full` always travels.** „Ausgebucht" is not optional: a participant who
 *   cannot see that a Veranstaltung is gone types a number, presses Absenden and
 *   is refused — the requirement calls the visible state „immer sichtbar"
 *   for that reason.
 * - **`remaining` travels only while `showRemaining` is on**, and its absence is
 *   the whole of the point. The figure is a statement about
 *   an organisation's registration state and it leaves the house without a session, so it is the
 *   editor's call and not a default. `.optional()` rather than `.nullable()`
 *   because „diese Veranstaltung nennt keine Zahl" is an *absent* field, in the
 *   same reading `submissionRefusalSchema.position` documents.
 *
 * **Only bounded Veranstaltungen appear here at all.** An event „ohne Grenze"
 * can never be full and has no remaining figure to give — an entry for it would
 * be `full: false` forever, i.e. a row that says nothing. A client that finds no
 * entry for a position therefore reads „unbeschränkt", which is what it is.
 */
export const publicEventSeatsSchema = z.object({
  /** The `event` question this entry belongs to. */
  questionId: z.string().min(1),
  /** The `EventEntry.key` — never the Bezeichnung, for `SeatPosition`'s reason. */
  eventKey: z.string().min(1),
  /** Whether no seat is left. Always present. */
  full: z.boolean(),
  /** How many seats are left — **only** while „Restplätze anzeigen" is on. */
  remaining: z.number().int().nonnegative().optional(),
});
export type PublicEventSeats = z.infer<typeof publicEventSeatsSchema>;

/**
 * A published form as a participant receives it.
 *
 * `definition` is the **published snapshot** , never the draft: an
 * editor reworking the form must not change what someone is filling in at that
 * moment.
 *
 * `display` and `availability` were added on the server side. Carrying
 * them **here** is what makes them arrive: this schema is what the client
 * parses, and Zod drops what it does not know — so until the two were named
 * above, every setting an editor made in the *Darstellung* section travelled
 * across the wire and was thrown away in the browser.
 */
export const publicFormSchema = z.object({
  /**
   * The discriminator of {@link publicFormResponseSchema}, and a literal on
   * both branches rather than an optional flag on one.
   *
   * A `definition?: FormDefinition` would have been the smaller change and the
   * wrong one: every consumer would then have to remember that the questions
   * may be absent, and the one that forgets renders an empty form instead of a
   * password prompt. With a discriminated union the compiler asks the question
   * at each call site, which is where it has to be answered.
   */
  locked: z.literal(false),
  title: z.string().min(1),
  /** Version of the snapshot — sent back with the submission. */
  version: z.number().int().positive(),
  tenant: publicTenantSchema,
  definition: formDefinitionSchema,
  display: publicDisplaySchema,
  availability: publicAvailabilitySchema,
  /**
   * The seat state of every bounded Veranstaltung.
   *
   * A plain array and **always present**, empty for the overwhelming majority
   * of forms that have no `event` question at all: an optional key would make
   * its presence say „dieses Formular hat Veranstaltungen", and a client would
   * have to branch on the difference between „keine" and „nicht gesagt" — which
   * is the second spelling of one state this project keeps removing.
   */
  eventSeats: z.array(publicEventSeatsSchema),
  /**
   * The signed start of this attempt — see
   * {@link startTokenSchema} for why it is here for every form.
   *
   * Required, not optional: a server that stopped issuing one would otherwise
   * leave the browser quietly submitting without it, and every submission to a
   * time-limited form would be refused with nothing in the client to say why.
   */
  startToken: startTokenSchema,
  /**
   * **Whether *this view* offers Zwischenspeichern** .
   *
   * This has two halves — „es gibt kein Bedienelement **und** die
   * Route antwortet ablehnend" — and the server owns both. The refusal is
   * `saving_disabled`; this field is what lets the fill-in view leave the button
   * off, instead of offering an action that answers 409.
   *
   * **It is a statement about this view, not a copy of the setting.** Three
   * payloads carry it and they answer differently on purpose: the public read
   * says what `allowSaveDraft` says, the resume of a draft says `true` (that is
   * how it got there), and the **edit** view of a submitted answer says `false`
   * — an answer that is already filed has nothing to zwischenspeichern, and a
   * `true` there would advertise a route that does not exist for it.
   *
   * **Why it is allowed past the allow list at all.** It says which actions
   * this page has — it names no word, no budget and no count. On the line this
   * file draws at the top it is the easiest case of all: not even a binding,
   * just the shape of the view. `availability.state` and `eventSeats[].full`
   * are on the wire for the same reason, and each of them, like this one, had
   * to be argued for once.
   */
  canSaveDraft: z.boolean(),
  /**
   * **How many minutes a fill-in may take** — `null` when no
   * time limit is set (finding 32).
   *
   * This is the field that moved the line described at the top of this file, so
   * the argument for it is spelled out rather than referred to:
   *
   * - **It binds the participant and nothing else.** The number decides whether
   *   their submission is taken; it says nothing about how many people have
   *   answered, whether a word guards the form, or what any budget is set to.
   * - **They learn it anyway.** Not knowing it does not spare anybody the
   *   `time_limit`-409 — it only means meeting it after the typing rather than
   *   before it, which is exactly the loss finding 32 names.
   * - **It arms nobody.** The limit is „eine Zusage an den ehrlichen
   *   Teilnehmer, keine Schranke gegen den unehrlichen"
   *   (`apps/api/src/public/start-token.service.ts`): reloading the page mints a
   *   fresh token and starts the minutes again, by design and stated where the
   *   editor sets the switch. A number that can be sidestepped by anyone who
   *   presses F5 is not a defence that publishing it could weaken.
   *
   * **`null` rather than an absent key or a `0`.** Absence would be a second
   * spelling of „kein Limit" that a client has to branch on, and a sentinel
   * number is a number that stops meaning what it says — the same two shapes
   * `mailBudgetLimit` refuses one file over. The server therefore sends
   * `timeLimitEnabled ? timeLimitMin : null` and never the stored minute count
   * of a switched-off limit, which is a real value (`30` by default) that would
   * otherwise announce a limit nobody set.
   *
   * **Bounded by {@link TIME_LIMIT_MIN_MAX}, the constant the settings are
   * bounded with**, for the reason `publicRedirectSchema.delaySec` states: the
   * client cannot know which version of the server answered it, and one bound
   * per side is two bounds that drift.
   *
   * It is a **display**, never an enforcement: what decides is the signed start
   * token against the settings at submission time.
   */
  timeLimitMin: z.number().int().positive().max(TIME_LIMIT_MIN_MAX).nullable(),
  /**
   * **The privacy notice of this form**, fully rendered — or
   * `null` when none is stored (ADR-0028 no. 4).
   *
   * ## Why it travels on this payload and not in a fetch of its own
   *
   * The footer fetches the name of the installation via a tiny `GET` of its
   * own, and the reasoning there is expressly that „das Feld in alle
   * fünf Verträge zu schreiben fünfmal dieselbe Entscheidung wäre". Here it
   * is **one** contract: the edit view and the resumed draft
   * embed `publicFormSchema` instead of having a shape of their own. The
   * difference is one of substance too — the name of the installation applies
   * to every public page, including the one no form belongs to; this
   * notice exists only where a form is, and as a fetch of its own it would be
   * a second address with a second access credential.
   *
   * ## Why it passes the allow list above — as the only one without a weighing
   *
   * The question of this file reads: „kann die teilnehmende Person durch dieses
   * Wissen etwas anders machen, und verrät es etwas über die Organisation?"
   * A privacy notice is the one value of this payload that was **written
   * expressly to be read by them**. Art. 13 Abs. 1 DSGVO
   * demands it „zum Zeitpunkt der Erhebung"; withholding it would not be
   * data minimisation, but the breach of duty itself.
   *
   * ## What `null` means — and what it does not mean
   *
   * „Für dieses Formular ist nichts hinterlegt", and the view then shows
   * **nothing** instead of a substitute text. The general privacy notices
   * of the organisation stand one link further on in the footer and can suffice
   * for this form; a line „hier fehlt etwas" would be a
   * false report to exactly the organisation at which nothing is missing.
   *
   * **The locked preliminary stage lacks it.** {@link lockedPublicFormSchema}
   * carries title and organisation and nothing else, and it stays that way:
   * before the access word nothing is collected, the notice stands on the same
   * page as the first field, and a locked payload that grows is one into which
   * the definition wanders back one day.
   */
  privacyNotice: publicFormPrivacyNoticeSchema.nullable(),
});
export type PublicForm = z.infer<typeof publicFormSchema>;

/**
 * A **password-protected** form as a stranger receives it before the gate
 * (first bullet).
 *
 * Title and Organisation and nothing else. The two are what makes the page recognisable
 * as the right one — somebody who was handed a link plus a word has to see that
 * the two belong together — and neither is a secret: the address itself was
 * distributed with them.
 *
 * **What is deliberately absent is the whole rest of the payload.** No
 * `definition`, which is the whole point: the questions are the
 * protected thing, and delivering them behind a client-side prompt would be „ein
 * Vorhang vor einer offenen Tür". No `display` and no `availability` either —
 * they are unremarkable on their own, but a stranger without the word has no use
 * for them, and a locked payload that grows is a locked payload somebody will
 * one day put the definition back into. No `startToken`: the attempt has not
 * started yet, and minting one here would hand out a signed artefact for a form
 * the caller has not passed the gate of. And no `timeLimitMin` either, which the
 * line at the top of this file decides rather than contradicts: a limit binds
 * whoever is filling the form in, and nobody is — the minutes start with the
 * attempt, and the attempt starts past the gate.
 */
export const lockedPublicFormSchema = z.object({
  locked: z.literal(true),
  title: z.string().min(1),
  tenant: publicTenantSchema,
});
export type LockedPublicForm = z.infer<typeof lockedPublicFormSchema>;

/**
 * What `GET /api/public/forms/:slug` answers — locked or open.
 *
 * `discriminatedUnion` rather than `union`: a payload that fails to parse then
 * reports the mismatch of the *matching* branch instead of a wall of issues from
 * both, and Zod picks the branch by one field rather than by trying each.
 */
export const publicFormResponseSchema = z.discriminatedUnion('locked', [
  lockedPublicFormSchema,
  publicFormSchema,
]);
export type PublicFormResponse = z.infer<typeof publicFormResponseSchema>;

/**
 * The access word on its way to the server (sixth bullet).
 *
 * A **body** schema, and that is the whole of the sixth bullet: there is no
 * route in this application that takes the word in a path segment or a query
 * parameter, because either would put it in access logs, in `Referer` and in the
 * browser's history — three places nobody clears and two the operator does not
 * control.
 *
 * Bounded by the same {@link PASSWORD_MAX} the editor's field is bounded by. A
 * longer offer cannot be right, and refusing it before the comparison keeps the
 * public route from doing work on a megabyte of text.
 *
 * **And bounded in its *alphabet*, which is the newer half.** An access word is
 * something an editor types into a text field and reads out over the telephone;
 * a control character cannot get in there. What could send one is a script, and
 * the API had two constants carrying U+0000 precisely because „nobody can type
 * this" made them safe to compare against — `REDACTED_PASSWORD` in
 * `settings-document.ts` and the dummy word in `access-word.service.ts`. That
 * assumption was never enforced anywhere: JSON transports U+0000 without
 * complaint, so a stranger could offer either constant verbatim. Neither ever
 * opened a form (the gate answers `false` whenever no word is configured,
 * whatever the comparison said), but „unreachable by construction" is worth
 * being true rather than merely believed.
 *
 * `\p{Cc}` is the Unicode *Control* category — C0 and C1, no more: umlauts,
 * emoji and every other printable character an organisation might put in a word stay
 * allowed. The rule is deliberately **not** added to `formSettingsSchema`: that
 * schema also parses documents on the way *out* of the database, where the
 * redaction marker legitimately carries a NUL byte — and a stricter rule there
 * would refuse stored documents, which fails closed on forms nobody could then
 * open again.
 */
export const accessRequestSchema = z.object({
  password: z
    .string()
    .min(1)
    .max(PASSWORD_MAX)
    .regex(/^[^\p{Cc}]+$/u, 'Das Zugangswort enthält unerlaubte Zeichen.'),
});
export type AccessRequest = z.infer<typeof accessRequestSchema>;

/**
 * The proof a participant holds after passing the gate.
 *
 * Opaque here for the same reason {@link startTokenSchema} is: its inside is the
 * server's business (`apps/api/src/public/access-proof.service.ts`), and a shape
 * described on the wire is a shape somebody starts constructing. What the
 * contract does say is that it is **signed, bound to one form and short-lived** —
 * so it opens the form it was issued for and no other, and it stops opening that
 * one after an hour.
 *
 * It is **not** an authorisation. Deadline, response limit and time limit are
 * checked on every request that carries it; the word is a hurdle in front of the
 * questions, never a substitute for the state of the form.
 */
const ACCESS_PROOF_MAX = 400;
export const accessProofSchema = z.string().min(1).max(ACCESS_PROOF_MAX);

/** What a passed gate answers with. */
export const accessGrantSchema = z.object({
  accessToken: accessProofSchema,
});
export type AccessGrant = z.infer<typeof accessGrantSchema>;

/**
 * The capability that opens **one** half-filled form.
 *
 * Bounded well above the 22 characters a real token has, and restricted to the
 * alphabet `base64url` produces. Both halves matter, and the second one is the
 * one that bites: this value also arrives as a **path segment**, a percent
 * escape is decoded before the application sees it, `%00` arrives as a NUL byte,
 * PostgreSQL refuses U+0000 inside `text`, and the query throws — a *500 where
 * every unknown token answers 404*, which is exactly the oracle the single 404
 * of the public routes exists to close.
 *
 * **One spelling for the body and the path**: the submission carries the token
 * in its body (`submitResponseRequestSchema.draftToken`) and the two draft
 * routes carry it in their path, and the API asks *this* schema in both places
 * (`apps/api/src/public/draft-token.ts`). `edit-token.ts` still carries its own
 * copy of the same rule because its token never travels in a body; a second
 * spelling of this one would be a second answer to „ist das überhaupt ein
 * Token".
 *
 * It says nothing about whether such a draft **exists** — that is a database
 * question, and it has exactly one answer for a malformed, an unknown, an
 * expired and a foreign token.
 */
const DRAFT_TOKEN_MAX = 200;
export const draftTokenSchema = z
  .string()
  .min(1)
  .max(DRAFT_TOKEN_MAX)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * A submission.
 *
 * `answers` is deliberately `unknown` on the wire: its shape depends on the
 * form, and the validator is derived from that form's definition
 * (`response-validation.ts`). Declaring a shape here would be a second, weaker
 * description of the same thing — and the weaker one is the one an attacker
 * would aim at.
 */
export const submitResponseRequestSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  /**
   * The token this attempt was started with.
   *
   * **Optional on the wire, mandatory in the enforcement** — and the two are
   * not in conflict. A form without a time limit never looks at it, so
   * demanding it here would refuse a perfectly good submission for the sake of
   * a setting nobody switched on. A form *with* a time limit refuses an absent
   * token exactly as it refuses a stale one, which is where the requirement
   * actually lives (`apps/api/src/public/public-forms.service.ts`).
   */
  startToken: startTokenSchema.optional(),
  /**
   * The decoy field — the eighth member of the public
   * allow list, and it earns its place the same way `startToken` did.
   *
   * **Next to `answers`, never inside them.** A value inside `answers` is a
   * value keyed by a question id, and `buildAnswersSchema()` derives its keys
   * from the published definition — a key without a question is a validation
   * error there, so putting the decoy in would refuse every submission that
   * carries it. The deeper reason is the one that survives any change to that
   * validator: `answers` is the object that gets **stored**, and an organisation reading
   * its registrations must never find a value that nobody asked a question for.
   * `startToken` sits outside for exactly this reason, and so does this.
   *
   * **Optional on the wire, and a value that does not parse becomes `null`
   * rather than a 400.** The submission is the thing being protected here: a
   * registration refused because a decoy field arrived as a number would be the
   * very data loss this measure exists to avoid — and it would be a refusal a
   * bot could aim for. The only two verdicts this field may produce are
   * „ausgefüllt" and „nicht ausgefüllt"; „Anfrage ungültig" is not among them.
   *
   * **Deliberately unbounded in length.** Every other bounded string on this
   * wire is bounded because it is compared, rendered or stored; this one is
   * read once, reduced to a boolean and dropped. A `max()` would have to answer
   * an over-long value with a refusal or with `null`, and `null` means „nicht
   * ausgefüllt" — a bot that sent *more* text would escape the suppression. The
   * bound that matters is already there: the 100 KiB JSON body limit from
   * `app-setup.ts` refuses the request before this schema runs.
   *
   * **The name is fixed and stated openly**, not rotated per form. A rotating
   * name would only stop an attacker who has learned to *skip one named field*
   * while still filling every other one blindly — and that attacker is one step
   * from sending only the keys the server asks for, which no name defends
   * against. It would cost a second wire field naming the current name, a
   * server-side derivation to recognise it, and an HMAC on every read. The
   * honeypot is „die billige Ergänzung gegen die automatisierte Masse"
   * ; what stops a targeted sender is the sending budget,
   * not a cleverer field name.
   *
   * The **rendered** input carries a different, plausible-looking `name`
   * (`apps/web/src/fill/HoneypotField.tsx`) — that attribute is the bait and
   * belongs to the page, while this key names the thing for whoever reads the
   * contract.
   */
  honeypot: z.string().nullable().catch(null).optional(),
  /**
   * The draft this submission is being sent **out of**, if there is one.
   *
   * **A field on the ordinary submission rather than a route of its own**, and
   * that is the whole of „das Absenden aus einem Entwurf erzeugt *eine* Antwort,
   * und der Entwurf ist danach weg, in *einer* Transaktion". Sending from a
   * draft is not a different kind of submission: it meets the same nine refusals
   * in the same order, it is validated against the same snapshot, and it writes
   * the same row. All this token adds is *which* draft the same transaction
   * deletes on the way through. A second route would be a second copy of that
   * chain, and the copy is the one that drifts.
   *
   * **Optional, and an unknown value is not a refusal.** A draft that expired,
   * that a settings change revoked, or that another tab already sent is simply
   * not there any more — and refusing the submission for it would throw away the
   * answers a participant has in front of them for the sake of a row that was
   * going to be deleted anyway. The delete is scoped to this form and this organisation,
   * so a token naming somebody else's draft matches nothing rather than removing
   * it.
   */
  draftToken: draftTokenSchema.optional(),
});
export type SubmitResponseRequest = z.infer<typeof submitResponseRequestSchema>;

/**
 * Where the browser goes after the confirmation, or `null`.
 *
 * **The URL is validated on the way in as well**, with the very schema that
 * refuses it on the way into the database. That is not belt-and-braces for its
 * own sake: this value is the one thing in the whole payload that the browser
 * *acts on* rather than displays, and the client has no way of knowing which
 * version of the server answered it. A target that does not survive the check
 * turns the whole `redirect` member into `null` (see the `.catch` below), so a
 * bad value costs the redirect and not the confirmation page.
 */
export const publicRedirectSchema = z.object({
  url: externalUrlSchema,
  /**
   * Bounded by the **same** constant the settings are bounded with, and for the
   * same reason the URL is re-checked next to it: this is the value a stranger's
   * browser acts on, and the client cannot know which version of the server
   * answered it. Unbounded, `delaySec: 86_400` parsed cleanly and the
   * confirmation page counted down for a day — with the receipt on screen and
   * the participant waiting for a redirect nobody configured.
   */
  delaySec: z.number().int().nonnegative().max(REDIRECT_DELAY_MAX),
}) satisfies z.ZodType<RedirectTarget>;

/**
 * What a participant sees after submitting.
 *
 * The two texts were fixed constants and now come from the effective settings
 * — same names, same place on the wire, which is why that was a server
 * change and not a contract change. `redirect` is new and nullable.
 *
 * `.catch(null)` on the redirect, deliberately: an answer whose target the
 * client will not follow, or which carries no `redirect` at all because an
 * older server produced it, must still show the participant that their
 * submission arrived. Losing the confirmation over the redirect would be the
 * more expensive failure — the answer *is* stored at that point.
 */
export const submitResponseResponseSchema = z.object({
  confirmationTitle: z.string().min(1),
  confirmationMessage: z.string().min(1),
  redirect: publicRedirectSchema.nullable().catch(null),
  /**
   * The address at which this participant may change their own answer, or
   * `null`.
   *
   * **Absolute, and built by the server** — not by the browser. The same string
   * goes into the confirmation mail, and a mail has no
   * `window.location.origin` to assemble one from; two builders would be two
   * addresses, and the one that is wrong is the one nobody can take back
   * (`PUBLIC_BASE_URL`).
   *
   * `null` whenever the form does not offer editing — the setting *Bearbeiten
   * nach Absenden* is off. It is not the enforcement: the link being absent here
   * hides it, and the edit route re-reads the setting on **every** access, which
   * is exactly the guarantee this makes. A link that was shown while the
   * setting was on stops working when it is switched off.
   *
   * `.catch(null)` for the same reason `redirect` has it: a server that answered
   * without this field, or with a value the client will not accept, must still
   * show the participant that their answer arrived. The confirmation is the
   * receipt; losing it over a link would be the more expensive failure.
   */
  editUrl: z.url().nullable().catch(null),
});
export type SubmitResponseResponse = z.infer<
  typeof submitResponseResponseSchema
>;

/**
 * What `GET /api/public/responses/:token` answers with.
 *
 * The form **as the answer was submitted against it** plus the answers
 * themselves. `form` is the ordinary `publicFormSchema` and not a shape of its
 * own, which is the point: the edit view is the fill-in view with the fields
 * filled in, and giving it its own contract would be two descriptions of one
 * screen that can drift apart.
 *
 * The `definition` inside is rendered from `response.form_version`, never from
 * the draft and never from the newest published version (the requirement:
 * „der Schema-Stand der Antwort bleibt der der ursprünglichen Absendung"). An
 * answer given to version 2 is corrected against version 2, whatever version 5
 * asks today.
 *
 * `answers` is `unknown` per key for the same reason the submission's is: the
 * shape belongs to the definition, and a second, weaker description here is the
 * one an attacker would aim at.
 */
export const responseEditSchema = z.object({
  form: publicFormSchema,
  answers: z.record(z.string(), z.unknown()),
  /** When this answer was first handed in. */
  submittedAt: z.iso.datetime(),
  /**
   * When it was last changed, or `null` — **kept apart from `submittedAt`**,
   * which is the last sentence of the requirement. Overwriting the submission time
   * on an edit would erase the one fact an organisation needs when two lists disagree:
   * when the registration actually arrived.
   */
  editedAt: z.iso.datetime().nullable(),
});
export type ResponseEdit = z.infer<typeof responseEditSchema>;

export function parseResponseEdit(source: unknown): ResponseEdit {
  return responseEditSchema.parse(source);
}

/**
 * What a participant sends when they press *Zwischenspeichern* .
 *
 * **`answers` and nothing else**, and each absence is a decision rather than a
 * field somebody forgot:
 *
 * - **No `startToken`.** Its time limit measures how long an *attempt*
 *   took, and a draft is the opposite of an attempt that is running out — it is
 *   somebody stopping. Judging it here would refuse the one action that saves
 *   their typing. The resume mints a fresh token instead
 *   (`responseDraftSchema.form.startToken`), so the limit measures from the
 *   moment they come back, exactly as the edit route does.
 * - **No `honeypot`.** The decoy exists to decide whether a *mail* goes out
 *   , and this route sends none — that is the whole of the requirement. A
 *   field that decided nothing would be a field a client fills in for nothing.
 * - **No access proof in the body.** It rides in the `X-Form-Access` header,
 *   where every other public route takes it.
 *
 * `answers` is `unknown` per key for the reason the submission's is: the shape
 * belongs to the definition, and a second, weaker description here is the one an
 * attacker would aim at. What is different — and it is the only thing that is —
 * is that the server validates it **without the Pflicht rule**
 * (`safeParseDraftAnswers`): a draft is half filled by definition, but a value
 * that is present still has to be the right type, within its bounds, and belong
 * to a question of this form.
 */
export const saveDraftRequestSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
});
export type SaveDraftRequest = z.infer<typeof saveDraftRequestSchema>;

/**
 * What a saved draft answers with — **the address on the screen** .
 *
 * There is no mail, so this payload is the only thing that ever
 * carries the address: whatever a client fails to show here, the participant
 * has no second way of getting.
 *
 * **`draftUrl` is nullable for the same reason `editUrl` is**, and the
 * consequence is heavier: an installation that has told nobody its base address
 * cannot build one (`PublicUrlService.resolveBaseUrl`), and a guessed address is
 * the one thing that must not leave the server. The draft is stored
 * all the same — refusing would throw the participant's typing away *as well* —
 * and the client has to say that saving worked but the address could not be
 * built. That is a real state of a misconfigured installation, not a theoretical
 * one, and it is named here rather than hidden behind an empty string.
 *
 * **`expiresAt` travels because the participant has to decide something with
 * it** — „bis wann kann ich weitermachen". It is the instant the draft dies:
 * the form's own deadline where one is set, thirty days otherwise.
 * A duration in days is deliberately not sent: that is a subtraction the client
 * can do, and a server-computed „noch 29 Tage" would be a second description of
 * one fact that starts drifting the first time one of the two rounds
 * differently — the same rule `trashViewSchema` follows.
 */
export const savedDraftSchema = z.object({
  draftUrl: z.url().nullable(),
  expiresAt: z.iso.datetime(),
  /**
   * **Which draft was just written** — the field that lets the second press of
   * *Zwischenspeichern* be a `PUT` instead of a second `POST` (a review finding).
   *
   * Without it the first fill-in view had no way of naming the draft it had
   * just created, so every press went through `useSaveDraft` again. *Measured
   * on 2026-08-05:* pressed twice, **two** `POST …/drafts`, two addresses,
   * two `response_draft` rows — the first one lives on for 30 days with an
   * older personal state that nobody can reach any more, and every
   * click consumes one unit of `MAX_DRAFTS_PER_FORM`.
   *
   * **Required, not optional**, and this is the second time that decision is
   * made on this payload — `responseDraftSchema.formSlug` one screen along was
   * born `.optional()` with *Absenden* hidden while it was missing. A wire field
   * whose absence is legal is a field the next writer leaves unset for good, and
   * what its absence switches off here is „ein Entwurf, eine Adresse". Both
   * routes that answer this payload send it on every write, so „fehlt" is not a
   * state, it is a bug, and a required key is what says so at the parse.
   *
   * **It gives nothing away that `draftUrl` does not already give**: the address
   * *is* this token in its last path segment. It travels as a field of its own
   * because a client that has to slice a URL apart to find an identifier is a
   * client that will one day slice the wrong one — and because `draftUrl` is
   * legitimately `null` on an installation that knows no base address, where the
   * draft exists all the same and continuing it is exactly what still works.
   */
  token: draftTokenSchema,
});
export type SavedDraft = z.infer<typeof savedDraftSchema>;

export function parseSavedDraft(source: unknown): SavedDraft {
  return savedDraftSchema.parse(source);
}

/**
 * What `GET /api/public/drafts/:token` answers with.
 *
 * The same shape the edit route answers with, with the two timestamps of a
 * submitted answer (`submittedAt`, `editedAt`) replaced by the two a draft has
 * (`savedAt`, `expiresAt`). `form` is the ordinary {@link publicFormSchema} for
 * the reason {@link responseEditSchema} gives: continuing a draft *is* the
 * fill-in view with the fields filled in, and a contract of its own would be two
 * descriptions of one screen.
 *
 * The `definition` inside is the snapshot the draft was **started** against
 * (`response_draft.form_version_id`), never the newest published one. A form
 * republished while somebody had a draft open would otherwise hand them back
 * their answers under different questions — and the submission that follows is
 * validated against that same snapshot, so the two cannot come apart.
 */
/**
 * **Whether an attachment of this draft is still there — and how much longer**
 * (a security review finding).
 *
 * An attachment in a draft used to be an *unclaimed* file, taken 24 hours after
 * its upload (ADR-0014 no. 15), while the draft itself lives up to thirty days
 * . Until this field the two deadlines never met on the wire: the
 * answers carried `{ref, name}` for ever, the resumed view drew „angehängt",
 * and the participant found out at the `409 attachment_unavailable` of their
 * submission — which the upload door of `45a1300` made reachable **again and
 * again** from the very screen whose purpose is coming back later.
 *
 * One entry per reference the stored answers name, in the order they name them,
 * so a client renders rather than diffs: a list of the *living* ones alone
 * would leave „tot" to be inferred from an absence, and inferring it is exactly
 * the step the first client would skip.
 *
 * **`expiresAt: null` is one answer for every reason**, mirroring the single
 * refusal of the claim (`attachment-claim.ts`): expired, purged, never
 * uploaded, another organisation's, another form's, already owned by an answer, or a
 * name that no longer matches the stored one. Five conditions, one verdict —
 * saying which would be an oracle about rows the holder of this token may not
 * know exist, and there is nothing they could do differently with the
 * distinction anyway: the action is „entfernen und neu anhängen" in all seven
 * cases.
 *
 * **The two deadlines are now one** : a draft *owns* its
 * attachments (`file.draft_id`), so what this field reports for a living one is
 * the draft's own `expiresAt` — the same instant the payload carries one key
 * further down — and no longer „hochgeladen + 24 Stunden". The field is not
 * thereby redundant: `null` still happens, for every reason above, and it is
 * the only place a client learns it without trying to submit. The 24 hours
 * remain for a file with **neither** owner and for one a correction removed
 * from a submitted answer.
 */
export const draftAttachmentSchema = z.object({
  /** The reference as the stored answer names it. */
  ref: fileRefSchema,
  /**
   * The instant this file stops being claimable — the **draft's** own deadline
   * while the draft owns it, `created_at` plus
   * {@link UNCLAIMED_FILE_LIFETIME_MS} for one nobody owns — or `null` when it
   * is already gone.
   *
   * An instant rather than „noch 3 Stunden": a duration computed on the server
   * is a second description of one fact that starts drifting the moment the two
   * sides round differently, the same rule {@link savedDraftSchema} states for
   * `expiresAt`.
   */
  expiresAt: z.iso.datetime().nullable(),
});
export type DraftAttachment = z.infer<typeof draftAttachmentSchema>;

export const responseDraftSchema = z.object({
  form: publicFormSchema,
  answers: z.record(z.string(), z.unknown()),
  /**
   * Every file reference the stored answers name, with its own deadline —
   * see {@link draftAttachmentSchema}.
   *
   * Empty for the overwhelming majority of drafts, which carry no
   * Datei-Upload question at all; the server then runs no query for it.
   */
  attachments: z.array(draftAttachmentSchema),
  /** When this draft was last written. */
  savedAt: z.iso.datetime(),
  /** When it disappears — see {@link savedDraftSchema}. */
  expiresAt: z.iso.datetime(),
  /**
   * The slug of the form this draft belongs to — needed for **submitting** out
   * of a resumed draft, never for reading or
   * continuing it.
   *
   * `/e/<token>` names no form (`RESPONSE_DRAFT_SEGMENT`'s own doc comment),
   * so a browser that opens it on a second device — the whole point —
   * has no slug to build `POST /public/forms/:slug/responses`
   * with. The server has one: `PublicFormsService.loadDraft` already reads
   * `draft.form.publicSlug`.
   *
   * **Required, not optional.** It was born `.optional()` when the view that
   * needed it was built ahead of the route that sends it, with *Absenden*
   * hidden while the value was missing — and that shape is the one this project
   * keeps removing: a wire field whose absence is legal is a field some second
   * writer leaves unset for good, and here the thing it switches off is the
   * only action the whole feature exists for. The route sends it on every read
   * (`byDraftToken`), so „fehlt" is not a state, it is a bug, and a required
   * key is what says so at the parse.
   */
  formSlug: z.string().min(1),
});
export type ResponseDraft = z.infer<typeof responseDraftSchema>;

export function parseResponseDraft(source: unknown): ResponseDraft {
  return responseDraftSchema.parse(source);
}

/**
 * The confirmation a submission is answered with, out of the effective settings.
 *
 * Here rather than in the API so that the one place which turns settings into
 * what a stranger receives is the same module that describes the wire — and so
 * that the redirect passes {@link effectiveRedirect} on the way out. The server
 * calls this; nothing else may assemble the answer.
 *
 * `editUrl` is a **required** parameter and not an optional one with a `null`
 * default. The two callers — the submission and the edit — have
 * to decide, and a default would silently pick „kein Bearbeiten-Link" for
 * whichever of them forgot. It is passed in rather than derived here because it
 * needs the installation's base address, which `packages/shared` deliberately
 * does not know: the browser also ships this file.
 *
 * The setting is applied **here**, in the one place the confirmation is
 * assembled: a caller that hands over a link for a form with `allowEdit: false`
 * still gets `null`, so the switch cannot be forgotten at a call site.
 */
export function confirmationOf(
  settings: FormSettings,
  editUrl: string | null,
): SubmitResponseResponse {
  return {
    confirmationTitle: settings.confirmTitle,
    confirmationMessage: settings.confirmMsg,
    redirect: effectiveRedirect(settings),
    editUrl: settings.allowEdit ? editUrl : null,
  };
}

export function parsePublicFormResponse(source: unknown): PublicFormResponse {
  return publicFormResponseSchema.parse(source);
}

export function parseAccessGrant(source: unknown): AccessGrant {
  return accessGrantSchema.parse(source);
}

export function parseSubmitResponse(source: unknown): SubmitResponseResponse {
  return submitResponseResponseSchema.parse(source);
}

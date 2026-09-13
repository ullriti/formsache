import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  EMPTY_SETTINGS_OVERRIDE,
  FORM_PRIVACY_TEMPLATE,
  TENANT_SETTINGS_FLOOR,
  UNCLAIMED_FILE_LIFETIME_MS,
  allQuestions,
  availabilityOf,
  boundedRequests,
  withLiveCapacity,
  confirmationOf,
  deliverableBranding,
  draftExpiresAt,
  effectiveRedirect,
  effectiveSettings,
  exhaustedPosition,
  formDefinitionSchema,
  needsResponseCount,
  parseStoredFormPrivacyNotice,
  publicAvailability,
  publicEventSeats,
  renderFormPrivacyNotice,
  safeParseAnswers,
  safeParseDraftAnswers,
  seatRequests,
  seatsOf,
  snapshotEventSeats,
  structuredAnswerShape,
  validationProblem,
  type AccessGrant,
  type AnswerMap,
  type DraftAttachment,
  type FormDefinition,
  type FormSettings,
  type LockedPublicForm,
  type PublicAvailability,
  type PublicForm,
  type PublicFormPrivacyNotice,
  type PublicTenant,
  type ReplyToLevel,
  type ResponseDraft,
  type ResponseEdit,
  type SavedDraft,
  type SubmissionRefusalPosition,
  type SubmissionRefusalReason,
  type SubmitResponseResponse,
} from '@formsache/shared';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';

import { PublicUrlService } from '../common/public-url/public-url.service';
import {
  OWNED_LOGO_INCLUDE,
  ownedLogoRef,
  type TenantLogoFiles,
} from '../files/owned-logo';
import { PrismaService } from '../prisma/prisma.service';
import {
  ABSENT_FORM,
  AccessWordService,
} from '../settings/access-word.service';
import {
  safeRedactedFormOverride,
  safeRedactedTenantDefaults,
} from '../settings/settings-document';
import {
  UnreadableSettingsError,
  enforcedSettings,
} from '../settings/settings-enforcement';
import { mailContextOf } from '../notifications/notification-render';
import { MailClock } from '../mail/mail-clock';
import { SystemMailSettingsService } from '../system-settings/system-mail-settings.service';
import { AccessProofService } from './access-proof.service';
import {
  ClaimRefusedError,
  claimAttachments,
  claimForDraft,
  releaseAttachments,
  releaseDraftAttachments,
} from './attachment-claim';
import { attachmentsIn, refsOf } from './attachment-refs';
import {
  heldSeats,
  lockForm,
  seatsBeyond,
  takenSeats,
  writeSeats,
} from './event-seats';
import { insertDraftWithinLimit } from './draft-quota';
import { isDraftToken, mintDraftToken } from './draft-token';
import { isEditToken, mintEditToken } from './edit-token';
import { isHoneypotFilled } from './honeypot';
import {
  HONEYPOT_SUPPRESSION_REASON,
  MAIL_BUDGET_EXCEEDED_REASON,
  type MailAllowance,
  budgetWindowStart,
  capMails,
} from './mail-suppression';
import { isPublicSlug } from './public-slug';
import { StartTokenService } from './start-token.service';
import {
  submissionMails,
  type PendingMail,
  type SubmissionNotification,
} from './submission-mail';
import { releaseUploads } from './upload-quota';

/**
 * What `response.answers` has to be for the edit route to hand it on: a JSON
 * object, keys to anything.
 *
 * Nothing about the *values* is claimed — that is the whole point. The answers
 * were validated against their own snapshot on the way in, and re-validating
 * them here would make an answer unopenable the day its snapshot's rules get
 * stricter. What is checked is only the claim the wire type makes, and the one
 * `Prisma.JsonValue` does not: that this is an object rather than an array, a
 * number or `null`.
 */
const storedAnswersSchema = z.record(z.string(), z.unknown());

/**
 * Turns validated answers into what JSONB can hold.
 *
 * Written out rather than cast, and the conversion is not busywork: an
 * unanswered question is `undefined` in the validated map, and `undefined` has
 * no JSON representation. Dropped, not stored as `null` — an absent key and a
 * null both mean "blank", and only one of them survives a round trip
 * unchanged. Choice answers are copied into plain arrays because the shared
 * type declares them `readonly`, which Prisma's input type does not accept.
 *
 * **The switch is over `structuredAnswerShape`'s tag, not over the keys a value
 * happens to carry** (a review finding, my own code, measured
 * 2026-07-31). This function used to end in `if ('values' in value)` followed
 * by a `never`, which reads exhaustive and is not: a shape carrying `values`
 * **and** keys of its own — the Veranstaltung, gewählte Termine
 * plus Personenzahl — satisfies that test, compiles green, and loses the extra
 * keys on the way into the column. Measured both halves: a shape *without*
 * `values` was caught by the `never` as intended; one *with* `values` plus a
 * `seats` key was not. The tag comes from a list that is pinned to
 * `AnswerValue` in `@formsache/shared` (`StructuredAnswerTagLock`), so a new shape
 * fails to compile there first and here second.
 *
 * The rewriting itself stays per shape and is deliberately **not** replaced by
 * a deep copy of the whole value: a required question's answer reaches this
 * function as the **raw request body** (`buildAnswersSchema` validates a
 * required answer with `z.unknown().superRefine`, which returns its input
 * rather than the parsed value), so this is the pass that decides which keys a
 * stranger can put into the JSONB column.
 */
function toStoredAnswers(
  answers: AnswerMap,
): Record<string, Prisma.InputJsonValue> {
  // A plain record rather than `Prisma.InputJsonObject`: that type's index
  // signature is read-only, so it describes a finished value and cannot be
  // filled in a loop. It accepts this one on the way out.
  const stored: Record<string, Prisma.InputJsonValue> = {};

  for (const [questionId, value] of Object.entries(answers)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number') {
      stored[questionId] = value;
      continue;
    }
    /*
     * Written out per shape rather than spread: the branch that stores a whole
     * value has to name the keys it stores, or the first shape that grows one
     * loses it in silence — which is what the two locks above are about.
     */
    const shaped = structuredAnswerShape(value);
    switch (shaped.kind) {
      case 'address':
        stored[questionId] = {
          street: shaped.value.street,
          zip: shaped.value.zip,
          city: shaped.value.city,
          country: shaped.value.country,
        };
        break;
      case 'matrix':
        /*
         * Copied row by row, not spread: `MatrixAnswer.rows` holds `readonly
         * string[]`, and Prisma's `InputJsonValue` does not take a readonly
         * array — the same reason the choice branch below rebuilds `values`.
         * `Object.fromEntries` rather than a mutable accumulator so the shape
         * this branch produces is visible in one expression.
         */
        stored[questionId] = {
          rows: Object.fromEntries(
            Object.entries(shaped.value.rows).map(([row, picked]) => [
              row,
              [...picked],
            ]),
          ),
        };
        break;
      case 'table':
        // Row objects are rebuilt for the same readonly reason, and the cells
        // are copied as they are: a cell is a string, a number or `true`
        // (`TableCellValue`), all three of which JSONB holds natively. Nothing
        // is normalised here — a value that got this far went through
        // `safeParseAnswers`, and „repairing" it a second time is how two
        // descriptions of one rule start to disagree.
        stored[questionId] = {
          cells: shaped.value.cells.map((row) => ({ ...row })),
        };
        break;
      case 'choice':
        stored[questionId] = {
          values: [...shaped.value.values],
          other: shaped.value.other,
        };
        break;
      // The attachments of one answer: **reference and name
      // per file, and nothing else** — never the bytes, never a URL. Rebuilt
      // entry by entry for the readonly reason the two branches above give, and
      // named key by key for the reason the whole switch is written out: a
      // spread would carry into JSONB whatever a stranger put beside `ref` and
      // `name`.
      case 'file':
        stored[questionId] = {
          files: shaped.value.files.map((file) => ({
            ref: file.ref,
            name: file.name,
          })),
        };
        break;
      // The Personenzahl per Veranstaltung — **rebuilt entry
      // by entry, and only the entries that are counts.** `seatsOf` is the
      // shared reader of this shape, the same one the export, the folded cell
      // and `seatRequests` use, so what lands in the column is exactly what the
      // participant limit was measured against a moment earlier. A spread would
      // carry whatever a stranger put beside the numbers into JSONB — the very
      // thing this switch is written out for — and would also let a `0` in,
      // which `canonicalAnswerValue` has just finished removing as the second
      // spelling of „nicht angemeldet".
      case 'event': {
        // Built key by key rather than through `Object.fromEntries`: the latter
        // types its result as `{[k: string]: unknown}`, which Prisma's
        // `InputJsonValue` refuses, and the cast that would silence it is
        // exactly the „I know what this is" this switch exists to avoid.
        const seats: Record<string, number> = {};
        for (const [key, count] of seatsOf(shaped.value)) {
          seats[key] = count;
        }
        stored[questionId] = { seats };
        break;
      }
      default: {
        /*
         * **The tail this switch did not have, and the attachment review
         * measured what that cost** (2026-08-01).
         *
         * `StructuredAnswerTagLock` in `@formsache/shared` makes a new member of
         * `AnswerValue` a compile error *there*, and the ADR went on to claim
         * that „the new tag then makes every `switch (shape.kind)` incomplete
         * — which is where the write path notices". For this switch that was
         * simply untrue: it is a **statement** switch with no `default`, so
         * TypeScript asks nothing of it, and adding `'file'` to `ShapedAnswer`
         * left it compiling green while silently dropping every file answer on
         * the way into the column. Found by an integration test that submitted
         * one and read the row back, not by the compiler.
         *
         * The `never` is what makes the ADR's sentence true from here on: the
         * next shape narrows to itself instead of `never` and this assignment
         * names it.
         */
        const unhandled: never = shaped;
        throw new Error(
          `toStoredAnswers: unhandled answer shape ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }

  return stored;
}

/**
 * One `mail_log` row, with **tenant, form and answer taken from one place**.
 *
 * A function rather than an inline object literal, and the reason is the only
 * thing worth saying about six assignments: `mail_log` carries a *simple*
 * foreign key on `form_id`, not the composite `(form_id, tenant_id)` that
 * `response` and `form_version` stand on — Prisma cannot express a composite
 * one where the relation is optional and the tenant is not (`schema.prisma`).
 * So the database will happily store a row pairing Organisation A's `tenant_id` with
 * Organisation B's `form_id`, and the *only* thing preventing it is that both come out
 * of the same resolved row here. Two parameters, one origin.
 */
function toMailLogRow(
  form: { id: string; tenantId: string },
  responseId: string,
  pending: PendingMail,
  /**
   * When this line joined the queue — **the queue's own clock, written out
   * rather than left to the column's `now()` default** .
   *
   * Previously the default was right because nothing read the column back inside
   * a decision. The sending budget does: it counts the rows of the last
   * `mailBudgetWindowMin` minutes, and the near edge of that window is computed
   * from {@link MailClock}. Anchoring the rows on the database's clock while
   * computing the boundary in Node is the two-calendar mistake `mail-clock.ts`
   * names — harmless in production, where both are the same wall clock, and
   * immediately wrong wherever the queue's clock is moved on purpose, which is
   * the only way the sliding window can be proven at all.
   */
  queuedAt: Date,
): Prisma.MailLogCreateManyInput {
  return {
    tenantId: form.tenantId,
    formId: form.id,
    responseId,
    createdAt: queuedAt,
    notificationId: pending.notificationId,
    // The effective value, frozen at the enqueue — like recipient, subject
    // and body, and for their reason (`MailLog.replyTo` in
    // `schema.prisma` writes it out). `null` means „keine Kopfzeile".
    replyTo: pending.replyTo,
    // What set this line off — carried on the pending
    // row, so the column and the filter that matched are one statement.
    trigger: pending.trigger,
    recipient: pending.recipient,
    subject: pending.subject,
    // Frozen here, in the same statement as the answer. The send step only fills the `{{bearbeiten}}` slot.
    bodyText: pending.bodyText,
    bodyHtml: pending.bodyHtml,
    status: pending.status,
    lastError: pending.lastError,
    /*
      **A row that already comes into being as `failed` was given up at this
      very moment**.

      They exist: an unreadable or unresolvable recipient entry, a
      form with no recipient at all, a suppressed address. No transport
      was ever asked, so `markFailed` never comes past here — and without
      this line exactly the sort of failure that most likely occurs in series
      (a mistyped recipient field hits every submission) would carry no
      instant and would be invisible to the alert.

      The same value as `createdAt`, but **not the same field**: `requeue`
      clears `failed_at` again, `created_at` stays.
    */
    failedAt: pending.status === 'failed' ? queuedAt : null,
  };
}

/**
 * The one answer for a public address that leads nowhere.
 *
 * Identical for an unknown slug, a form that has never been published, one
 * whose publication was withdrawn, and one in the trash. Anything else
 * would turn the public URL into a probe: "this slug exists but is not
 * published yet" is exactly the sentence a registration that has not opened
 * must not say.
 */
export const PUBLIC_FORM_NOT_FOUND_MESSAGE = 'Dieses Formular gibt es nicht.';

/**
 * The three *Darstellung* flags, and only those.
 *
 * Spelled out field by field rather than passed through as a slice of the
 * settings: a section that grows would otherwise start travelling to the
 * public without anybody deciding it should.
 */
export interface PublicDisplay {
  readonly showProgress: boolean;
  readonly showPageNumbers: boolean;
  readonly showRequiredHint: boolean;
}

/**
 * What a participant receives — the base contract **plus** what is added on top.
 *
 * Declared as an extension of the shared `PublicForm` rather than as a
 * replacement, because that is exactly what it is: `title`, `version`, `tenant`
 * and `definition` keep their meaning and their shape, and two
 * fields are added next to them.
 *
 * **Both fields are part of `publicFormSchema` since a later change.** Until then the
 * shared wire contract did not know them, the client's parser dropped unknown
 * keys, and every *Darstellung* setting an editor made arrived in the browser
 * and was silently thrown away. The list here is stated a second time on
 * purpose: this side decides what is sent, the shared schema decides what is
 * accepted, and a field on only one of them goes nowhere.
 */
/**
 * The German sentence behind each refusal.
 *
 * Written out per reason rather than assembled: the participant is a stranger
 * who has just typed a page of answers, and „ungültig" is not something they can
 * act on.
 *
 * **None of them names a value — no deadline instant, no response limit, no
 * minute count — and that is now a statement about *these sentences*, not about
 * the payload.** It used to be both: the public contract carried „ein Verdikt,
 * nie die Konfiguration dahinter", so a number here would have been the leak the
 * read path had just avoided. Since finding 32 the read path names what binds the
 * participant — the deadline and the time limit — and the reason these messages
 * still do not is a different one, twice over. Each is a **constant**, one per
 * reason; a sentence with a form's own number in it is a sentence that has to be
 * assembled per request, and the assembled one is the one that starts saying
 * „30 Minuten" to a form whose editor has since set 15. And it would be
 * *repetition*: whoever meets this 409 was shown the bound before they typed,
 * one line under the title (`apps/web/src/fill/deadline-notice.ts`).
 *
 * What must stay out of them for the old reason is everything on the defence
 * side of that line — no count against `maxResponses`, no word, no budget. The
 * verdict travels in the `reason`, and the read path already says the same
 * three words out loud.
 */
export const SUBMISSION_REFUSAL_MESSAGES: Readonly<
  Record<SubmissionRefusalReason, string>
> = Object.freeze({
  // **„Formular", not „Anmeldung"** (finding 32, second part: „die formulare
  // sind ja nicht immer anmeldungen"). These two sentences are literally
  // the same ones that `apps/web/src/fill/unavailable-notice.ts` writes for the
  // *read* side — the same form, the same state, two screens. A
  // view that says „Formular" and a refusal that says „Anmeldung"
  // would be two names for one state.
  not_yet_open: 'Dieses Formular ist noch nicht geöffnet.',
  closed: 'Die Frist für dieses Formular ist abgelaufen.',
  limit_reached: 'Es werden keine weiteren Antworten mehr angenommen.',
  time_limit:
    'Die Zeit für diese Ausfüllung ist abgelaufen. Bitte die Seite neu laden und erneut ausfüllen.',
  password_required:
    'Für dieses Formular wird das Zugangswort benötigt. Bitte die Seite neu laden und das Zugangswort eingeben.',
  editing_disabled:
    'Diese Antwort lässt sich nicht mehr ändern. Für dieses Formular ist das Bearbeiten nach dem Absenden ausgeschaltet.',
  // One sentence for all five conditions of the claim (ADR-0014 no. 13), and it
  // says the only thing a participant can act on: upload the file again. It
  // names no path, no key and no other organisation — „abgelaufen oder nicht mehr
  // verfügbar" covers expired, already claimed and foreign alike.
  attachment_unavailable:
    'Ein Anhang ist abgelaufen oder nicht mehr verfügbar. Bitte die Datei erneut hochladen.',
  attachment_limit:
    'Diese Antwort trägt zu viele oder zu große Anhänge. Bitte weniger Dateien anhängen.',
  // The one refusal a participant can fix **in the form in front of them**
  // : one Veranstaltung is full, the rest of the
  // registration is still acceptable. It names **no** Veranstaltung, for the
  // reason this whole table exists — the messages are constants, and the name
  // travels in `position` (`submissionRefusalPositionSchema`) so the fill-in
  // view marks the field from the definition it is already showing. It names no
  // number either: how many seats are left is exactly the figure this design
  // makes an editor's decision, and a refusal must not leak it past that switch.
  event_full:
    'Für eine gewählte Veranstaltung sind nicht mehr genügend Plätze frei. Bitte die Angabe ändern und erneut absenden.',
  // The requirement — the exact counterpart of `editing_disabled` one door
  // along, and it says the one thing a participant can act on: the answers are
  // still on their screen, so „jetzt absenden" is the way out. It names no
  // setting and no editor, because neither is theirs to change.
  saving_disabled:
    'Dieses Formular lässt sich nicht zwischenspeichern. Bitte die Eingaben in einem Zug ausfüllen und absenden.',
  // Review, a review finding — the second submission of the same draft.
  //
  // **The sentence does not claim that the registration exists**, although that is
  // the commonest way to get here. It cannot know: a revoked
  // draft and a token that never named anything land in
  // the same refusal, and for those two „die Anmeldung liegt vor" would be an
  // untruth that lets somebody **leave unregistered** — the heavier
  // of the two errors, because a double click costs an organization one
  // query, while a registration that did not happen costs the person their place.
  // So both possibilities are named and the check that separates them is
  // offered as an action.
  draft_already_submitted:
    'Dieser Entwurf lässt sich nicht mehr absenden — er wurde bereits abgesendet oder ist nicht mehr gültig. Bitte prüfen, ob eine Bestätigung vorliegt, bevor das Formular erneut ausgefüllt wird.',
  // Review, a review finding — the quantity limit of drafts per form.
  // It does not name the number (the same rule as with the Antwortlimit) and says
  // the way that stays open: filling in and submitting still works, only the
  // Zwischenspeichern does not.
  draft_limit:
    'Für dieses Formular können derzeit keine weiteren Entwürfe gespeichert werden. Bitte die Eingaben in einem Zug ausfüllen und absenden.',
});

/**
 * What a participant is told when the stored settings cannot be read.
 *
 * **This is the fail-closed answer of the enforcement layer** (`settings-enforcement.ts`).
 * 503 rather than 500, and the difference is the sentence it lets us say: an
 * unreadable settings document is the ordinary state of a rolling deploy and
 * resolves itself within minutes, so „später erneut versuchen" is true. A 404
 * would be a lie and would also send the participant away for good.
 */
export const UNREADABLE_SETTINGS_MESSAGE =
  'Dieses Formular kann derzeit keine Antworten annehmen. Bitte später erneut versuchen.';

const MINUTE_MS = 60_000;

/**
 * How far a start token may claim to come from the *future* before it stops
 * counting.
 *
 * Five minutes: far beyond any drift between NTP-synchronised hosts, and far
 * short of a limit an editor would set. See
 * {@link PublicFormsService.startedInTime} for why the answer is neither „always
 * accept" nor „always refuse".
 */
const CLOCK_SKEW_GRACE_MS = 5 * MINUTE_MS;

/**
 * **The bounds of the two draft transactions** (a security review).
 *
 * Prisma's own defaults are `maxWait: 2 s` and `timeout: 5 s`, and this file
 * argues in three places why they are too tight for a public write: the
 * submission and the correction both take `{ maxWait: 20_000, timeout: 20_000 }`
 * because a transaction that waits for a form lock behind a burst of
 * registrations is not a fault, it is the busy minute the participant limit
 * exists for.
 *
 * `saveDraft` and `updateDraft` are transactions too — before that
 * each was a single statement, so the defaults were nobody's decision. The
 * claim beside the write touches the same `file` rows a concurrent submission
 * locks, so the same wait can happen here; on the default `maxWait` it would
 * come back as a 500 on the one route that has no session in front of it.
 * Same numbers as the neighbours, deliberately: „wie lange darf eine
 * öffentliche Schreib-Transaktion warten" must not have two answers.
 */
const PUBLIC_DRAFT_TRANSACTION_BOUNDS = {
  maxWait: 20_000,
  timeout: 20_000,
} as const;

/**
 * The one refusal of the enforcement layer — **409, always, whichever rule fired**.
 *
 * One status for five reasons rather than a spread of 403/410/429: they are all
 * the same statement, „der Zustand dieses Formulars verträgt sich nicht mit
 * dieser Absendung", and the difference travels in the machine-readable
 * `reason` (`submissionRefusalSchema` in `@formsache/shared`). A client that only
 * looks at the status still behaves correctly — none of the five is worth
 * retrying — and the rule's „10 Anfragen mit derselben Ablehnung" is
 * then a byte-comparison rather than a judgement.
 *
 * Built here rather than at each throw site so the five bodies cannot drift.
 */
function refusal(
  reason: SubmissionRefusalReason,
  /**
   * Which Veranstaltung it fired on — for `event_full` and nothing else.
   *
   * Omitted rather than `null` on the eight other reasons, because the wire
   * schema has it `.optional()` for exactly the reason stated there: every
   * refusal body sent before this change carries no such key, and „diese
   * Ablehnung hat keine Position" is an absence.
   */
  position?: SubmissionRefusalPosition,
): ConflictException {
  return new ConflictException({
    message: SUBMISSION_REFUSAL_MESSAGES[reason],
    reason,
    ...(position === undefined ? {} : { position }),
  });
}

/**
 * What {@link PublicFormsService.storeWithinLimit} answers with — **stored, or
 * the refusal that stopped it**.
 *
 * A tagged union rather than the `string | null` this used to be. Two limits can now stop a submission and they do not say the same
 * thing: the Antwortlimit is about the *form* („es werden keine weiteren
 * Antworten angenommen"), the participant limit about **one position** in it, and
 * the fill-in view has to mark a field for the second and a page for the first.
 * A `null` cannot carry that difference, and a second nullable return value
 * beside it would let a caller answer the wrong 409 by forgetting one `if`.
 */
type StoreOutcome =
  | { readonly stored: true; readonly editToken: string }
  | {
      readonly stored: false;
      readonly reason: 'limit_reached' | 'draft_already_submitted';
    }
  | {
      readonly stored: false;
      readonly reason: 'event_full';
      readonly position: SubmissionRefusalPosition;
    };

export interface PublicFormPayload extends PublicForm {
  readonly display: PublicDisplay;
  /**
   * The verdict — three fields, not the four `FormAvailability` carries.
   * `windowConfigured` is what the editor's badge needs to say „Immer
   * geöffnet"; a participant has no use for the difference, so
   * `publicAvailability()` leaves it behind.
   */
  readonly availability: PublicAvailability;
}

/**
 * What `GET /api/public/forms/:slug` answers with.
 *
 * A union rather than a payload with an optional `definition`, mirroring
 * `publicFormResponseSchema` in `@formsache/shared`: the compiler then asks „locked or
 * not?" at every call site instead of letting one of them render an empty form
 * where a password prompt belongs.
 */
export type PublicFormReadPayload = PublicFormPayload | LockedPublicForm;

/**
 * **A form's privacy notice, fully rendered** — or `null`
 * (ADR-0028 no. 4).
 *
 * ## The server renders, the browser displays
 *
 * The same division that `PublicLegalService` draws for the legal text pages
 * and that `availabilityOf()` draws for the availability: what goes out is the
 * **result** — a tree of `LegalBlock` —, never the stored document
 * and never the template. The yield is no convenience, but a
 * promise one can check: the answer contains no field that could
 * transport markup, and `LegalText.tsx` has nothing it could hand to a
 * `dangerouslySetInnerHTML` (ADR-0028 section 7).
 *
 * ## The context is deliberately narrow
 *
 * `operatorName: null` and `aiActive: false`, and neither is an omission:
 * the template of this notice uses neither the operator's name nor the
 * AI condition — it names purpose, legal basis and retention of *this*
 * form and refers for everything else to the organization's general
 * privacy notices. Obtaining both values would be two
 * additional read queries on the public fill-in path, for details that
 * appear in no sentence; `templateDefects` in `@formsache/shared` holds the
 * template to that, and `legal.test.ts` checks it.
 *
 * ## The one thing it does obtain: where this form sends people afterwards
 *
 * `redirectTarget` (ADR-0028 no. 5), and it costs no query — the settings are
 * already merged at every call site, because the same payload announces the
 * deadline, the time limit and the draft button out of them. Whoever fills a
 * form that redirects has their IP address handed to a third party, and the
 * sentence that says so is the one thing about *this* form that the
 * organisation's general notice cannot name: several forms have several
 * targets.
 *
 * **Through `effectiveRedirect()` and never from `settings.redirectUrl`.**
 * That function is the gate between a `FormSettings` — a plain type anybody
 * can construct — and a browser being told where to go; a legal text that
 * links the target is one more surface behind the same gate, and it must not
 * be the one that opens its own.
 *
 * ⚠️ **The sentence follows the same reading as the rest of the payload**, and
 * on `bySlug` that is the *tolerant* one: a settings document that does not
 * parse degrades to the shipped defaults, which redirect nowhere, so the
 * section falls away. That is not a legal text going quiet about something
 * that happens — the submission reads the same document **strictly** and
 * answers 503, so nothing is collected and nobody is redirected while it is
 * broken.
 */
function privacyNoticeOf(
  form: {
    privacyNotice: Prisma.JsonValue;
    tenant: { name: string; shortName: string };
  },
  settings: FormSettings,
): PublicFormPrivacyNotice | null {
  return renderFormPrivacyNotice(
    FORM_PRIVACY_TEMPLATE,
    // Tolerant: an unreadable column means „nichts hinterlegt". It must not
    // take the form down — a fill-in path that answers 500 because of a
    // broken JSONB is the most expensive conceivable failure of this
    // function.
    parseStoredFormPrivacyNotice(form.privacyNotice),
    {
      organisationName: form.tenant.name,
      organisationShortName: form.tenant.shortName,
      operatorName: null,
      aiActive: false,
      redirectTarget: effectiveRedirect(settings)?.url ?? null,
    },
  );
}

/**
 * The organisation above a form, in the one shape both branches of the read use.
 *
 * **This is the branding case that has no session** . The
 * row comes from `form.tenant` — the organisation the *form* belongs to — and there is
 * deliberately no other way for it to arrive: a participant is not signed in,
 * so there is no active tenant to read a colour from, and taking one from
 * anywhere but the form would show a stranger the wrong organisation's colours (or,
 * for a signed-in editor looking at another organisation's form, their own). That is
 * the mistake a logged-in tester never sees, which is why it is stated here
 * rather than left to the call sites.
 *
 * The branding passes the delivery gate on the way out for the same reason it
 * does in `session-user.ts`: a colour reaches a CSS custom property and a
 * `logo_ref` an `<img src>`, on a page anyone on the internet may open.
 */
function tenantOf(
  tenant: {
    name: string;
    shortName: string;
    logoRef: string | null;
    accentColor: string;
    headerColor: string;
    canvasColor: string;
    stripeColors: string[];
    logoWide: boolean;
  } & TenantLogoFiles,
): PublicTenant {
  // The **first and load-bearing** shore of ADR-0014 no. 12: there is no
  // session here, so there is no signed-in Organisation to compare a reference
  // against. The ownership is the query's — `tenant.files` is this organisation's own
  // set by definition of the foreign key — and `ownedLogoRef` only reads what
  // it returned.
  const { logoRef, branding } = deliverableBranding(
    tenant,
    ownedLogoRef(tenant),
  );
  return {
    name: tenant.name,
    shortName: tenant.shortName,
    // The gate's own answer, handed on unchanged (ADR-0014 no. 12): a shipped
    // asset, this organisation's **proven** upload, or nothing. What makes that safe is
    // the line above it — `ownedLogoRef` reads the file relation this query
    // loaded, so a `logo_ref` naming another organisation's file is `null` here rather
    // than a reference somebody's browser goes and fetches.
    logoRef,
    branding,
  };
}

/**
 * The public fill-in surface (the requirements).
 *
 * **This is the one service in the application that legitimately holds a
 * `PrismaService` outside the tenancy modules**, and the reason is worth
 * stating plainly rather than leaving to the lint rule's allow-list: there is
 * no session here, so there is no membership to derive a `TenantScope` from.
 * A participant is not a member of anything.
 *
 * What replaces the tenant scope is the slug. It is 128 bits of CSPRNG, it is
 * unique across the installation, and every query below starts from it — the
 * form it resolves to carries its own `tenant_id`, and the response is written
 * with exactly that one. So a submission cannot land in another organisation's data
 * for the same structural reason a scoped query cannot: the tenant is never a
 * parameter anyone outside supplies.
 */
@Injectable()
export class PublicFormsService {
  /**
   * A broken stored snapshot answers the public caller with a plain 404, so
   * the only place it is visible at all is here.
   */
  private readonly logger = new Logger(PublicFormsService.name);

  /**
   * Which „dieses Dokument parst nicht"-lines have already been written, so
   * each is written **once per process lifetime**.
   *
   * Without it a single broken `tenant.form_defaults` turned the public read
   * route into a log amplifier: two `logger.error` lines per `GET`, at 120
   * requests a minute **per address** and with no login in the way — ~240
   * lines a minute from one address, scalable across as many as an outsider
   * cares to use, and aimed at exactly the organisation whose row is already broken.
   * The informative content is complete the first time; every repetition costs
   * disk and buries the rest of the log.
   *
   * Keyed by the finished message, so it separates by tenant, by form **and**
   * by which of the two columns broke. Bounded by the number of broken rows in
   * the installation, not by traffic — the ids in it come from resolved
   * database rows, never from anything a caller writes.
   */
  private readonly reportedDocuments = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    /**
     * The signer of the requirement — **not** a `SecretBoxService`.
     *
     * The service holds no cipher and no key that could open one, so the
     * sentence above („a path that cannot decrypt cannot leak") keeps holding
     * even though this module now imports `SecretBoxModule`: what it takes from
     * there is a signer over its own derived subkey.
     */
    private readonly startTokens: StartTokenService,
    /** The signer of the access proof — also key-free. */
    private readonly accessProofs: AccessProofService,
    /**
     * The password gate's one question, „ist das Wort?", answered with a
     * boolean.
     *
     * **This is the one dependency of this service that can reach the
     * encryption key**, and it is worth saying so where the constructor is
     * read. It is not a `SecretBoxService`: nothing here can seal, open or hand
     * out a plaintext, and the redacting parsers this service reads settings
     * through (`settings-document.ts`, `settings-enforcement.ts`) are unchanged.
     * The reasoning behind the shape is in `settings/access-word.service.ts`.
     */
    private readonly accessWords: AccessWordService,
    /**
     * The installation's own address — configuration, never the
     * request's `Host`. See `common/public-url/public-url.service.ts`.
     */
    private readonly publicUrls: PublicUrlService,
    /**
     * The queue's one calendar — **not a second
     * `new Date()`**.
     *
     * The sending budget counts `mail_log` rows over a *sliding* window, and
     * the only way to prove that the window slides is to move the clock an hour
     * forward; a test that waits an hour is not a test (`mail-clock.ts`). It is deliberately the **same** clock the worker and
     * the purge read rather than one of this module's own: the rows being
     * counted are the queue's rows, and two calendars over one table is the
     * shape in which „im letzten Zeitfenster" means two different things
     * depending on who asks.
     *
     * The refusal chain above keeps its own `new Date()`. That is not an
     * oversight: deadlines and start tokens are the *participant's* time, judged
     * against the server's wall clock, and a suite that moved the mail clock to
     * prove a budget must not silently reopen a closed registration.
     */
    private readonly mailClock: MailClock,
    /**
     * The two lower levels of the `Reply-To` chain — more precisely: the
     * installation-wide one. The organization's stands in the row that
     * the slug has resolved anyway, and is not fetched a second time.
     *
     * The same inheritance the base address has, and expressly **not**
     * read from the SMTP block: the block is indivisible because it carries a
     * secret — the reply-to address stands beside it.
     */
    private readonly systemMail: SystemMailSettingsService,
  ) {}

  /**
   * The two lower levels of the `Reply-To` chain for an organization, in the
   * order in which they apply: first the organization, then the installation.
   *
   * The **evaluation** of the chain does not stand here, but in
   * `submissionMails` — in a single `effectiveReplyTo`, in front of which the
   * notification's level is placed. What this method delivers are
   * the raw values; what becomes of them is decided by the one rule.
   *
   * The **order** of the two, since a review finding of the reply-to review,
   * likewise no longer stands here: `SystemMailSettingsService.replyToDefaults`
   * assembles it and reports an unusably stored value
   * on both levels while doing so. This method remains as a named intermediate
   * step because two callers in the same service need it.
   */
  private async replyToDefaults(form: {
    readonly tenantId: string;
    readonly tenant: { readonly replyTo: string | null };
  }): Promise<readonly ReplyToLevel[]> {
    // The id comes from `form.tenantId` and not from a wider
    // projection onto `tenant`: it already stands on every form anyway,
    // and it is only needed here so that a report can say *which*
    // organization has an unusable value standing.
    return this.systemMail.replyToDefaults({
      id: form.tenantId,
      replyTo: form.tenant.replyTo,
    });
  }

  /**
   * The published snapshot behind a public address — **or the locked stub, if
   * the caller has not passed the password gate** (first bullet).
   */
  async bySlug(slug: string, proof?: string): Promise<PublicFormReadPayload> {
    // **Before the form is looked up**, and for the same reason `unlock` does it
    // in that order: an unknown address must not cost measurably less than a
    // known one. This route answers a stranger, and one database round trip
    // fewer for „gibt es nicht" is exactly the kind of difference the single
    // 404 path exists to deny.
    //
    const form = await this.load(slug);
    const version = form.publishedVersion;
    if (version === null) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const definition = formDefinitionSchema.safeParse(version.schema);
    if (!definition.success) {
      // A stored snapshot that no longer parses is a server fault, not a
      // participant's — and it must not be rendered half-way. It answers with
      // the **same** 404 as an unknown address: a distinct message here would
      // undo what the single 404 path is for, namely that the public routes
      // never confirm that a slug exists. "Broken but real" is
      // still "real".
      this.logger.error(
        `Published snapshot of form ${form.id} does not parse; answering 404.`,
      );
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    /*
     * The requirement, first bullet — **the gate stands in front of the
     * questions, not in front of a rendering decision.**
     *
     * Placed after the two 404s and before everything else: a form that does
     * not exist, is unpublished or whose snapshot is broken must look absent
     * whether or not it is protected, so „locked" is never the answer that
     * confirms an address. Everything after this line is what the gate
     * withholds.
     */
    if (
      this.isLocked(form) &&
      !this.accessProofs.holds(proof, slug, new Date())
    ) {
      return {
        locked: true,
        title: form.title,
        tenant: tenantOf(form.tenant),
      };
    }

    const settings = this.settingsOf(form);

    return {
      locked: false,
      title: form.title,
      version: version.version,
      tenant: tenantOf(form.tenant),
      definition: definition.data,
      display: {
        showProgress: settings.showProgress,
        showPageNumbers: settings.showPageNumbers,
        showRequiredHint: settings.showRequiredHint,
      },
      /*
       * „Ausgebucht", and the figure only where the editor allowed it.
       *
       * Read **without** the form row's lock and deliberately so: this is a
       * display, and a display cannot be authoritative about seats that another
       * submission may take a millisecond later. The binding answer is the
       * transaction below — it runs under `SELECT … FOR UPDATE` and refuses with
       * the position it fired on. What this number does is keep a participant
       * from typing into a hall that is already full; what it must never be is
       * the thing the Obergrenze rests on.
       */
      eventSeats: publicEventSeats(
        definition.data,
        await this.takenIfBounded(form.id, form.tenantId, definition.data),
      ),
      // The documented three-field subset — the fourth field
      // of the verdict belongs to the editor's badge, not to a stranger.
      availability: publicAvailability(
        availabilityOf({
          settings,
          now: new Date(),
          responseCount: await this.countIfLimited(
            form.id,
            form.tenantId,
            settings,
          ),
        }),
      ),
      /*
       * The requirement — the attempt starts here, and the server signs that it
       * did.
       *
       * Minted for **every** form, including one without a time limit. That
       * used to be a concealment (the field's presence would otherwise say
       * whether the setting is on); since `timeLimitMin` travels one key
       * further down it is the plainer reason that carries it — one payload
       * shape means one client path, and a token issued only sometimes is an
       * `if` that the consumer who forgets it submits without. Minted from the
       * *tolerant* settings path above as well, because it is not a decision —
       * the token records an instant, it grants nothing, and whether that
       * instant is still good enough is decided from the strict read at
       * submission time.
       */
      startToken: this.startTokens.issue(slug),
      /*
       * **The time limit that is worked against here** (finding 32) — see
       * `publicFormSchema.timeLimitMin` for why a stranger may know it.
       *
       * `timeLimitEnabled ? … : null` and never the bare number: the settings
       * carry a `timeLimitMin` (30 by default) even while the switch is off,
       * and sending it would announce a limit nobody set — which the fill-in
       * view would then put over the questions in as many words.
       *
       * **Read from the tolerant path, exactly like the deadline beside it.**
       * For almost every caller that cannot diverge: `isLocked` above reads the
       * same two documents *strictly* and fails closed, so a form whose
       * settings stopped parsing answers with the locked stub instead of this
       * payload. The exception is the one caller holding an access proof minted
       * before the document broke — for them `isLocked` is true but the gate is
       * already passed, and the tolerant read then says „kein Zeitlimit" (and,
       * unchanged since long before this key, „keine Frist") where the strict
       * one would say otherwise. That is a display going quiet during a rolling
       * deploy, not a fail-open: their submission meets
       * `settingsForEnforcement`, which refuses an unreadable document with a
       * 503 rather than accepting it late.
       */
      timeLimitMin: settings.timeLimitEnabled ? settings.timeLimitMin : null,
      // The requirement — the half of „Schalter aus" the *view*
      // owns. From the same strict-or-tolerant reading the rest of this payload
      // uses: it decides what a button looks like, never whether a request is
      // accepted, and the route re-reads the setting on every access anyway.
      canSaveDraft: settings.allowSaveDraft,
      /*
        **The privacy notice of this form** (ADR-0028 no. 4).

        It stands behind the access-word gate and not in front of it, and that is the
        decision: in front of the gate nothing is collected, and Art. 13 Abs. 1
        requires the information „zum Zeitpunkt der Erhebung". The locked
        preliminary stage carries title and organization and nothing else — a locked
        payload that grows is one into which the definition wanders
        back one day.
      */
      privacyNotice: privacyNoticeOf(form, settings),
    };
  }

  /**
   * Whether this form is behind the password gate — read **strictly**, and
   * closed when it cannot be read at all.
   *
   * ## Why this one decision does not use the tolerant read below
   *
   * `settingsOf` degrades an unparseable settings document to the system
   * defaults so that a rolling deploy cannot turn a whole organisation's fill-in pages
   * into 500s. For three display flags and a deadline shown on screen, that is
   * the right trade. For *this* question it is not: the system defaults say
   * `passwordEnabled: false`, so inheriting the fallback would mean a
   * password-protected form hands out its questions in the exact minute its
   * document stops parsing. That is the fail-open `settings-enforcement.ts`
   * exists to prevent, stated there in as many words — „unreadable" must never
   * become „no deadline, no limit, no password".
   *
   * So an unreadable document reads as **locked**, and the price is named
   * rather than hidden: a form *without* a password whose organisation's
   * `form_defaults` briefly do not parse shows a password prompt nobody can
   * satisfy, until the deploy settles. That is a few minutes of a form being
   * unreachable against the alternative of a protected registration being
   * readable by anyone with the link. Only one of the two can be undone
   * afterwards.
   *
   * The rest of the payload keeps the tolerant read: the flags and the verdict
   * are not a security boundary, and there is no reason to make them fail with
   * this.
   *
   * ## Two documents decide it, and there is no third
   *
   * The organisation's standard and the form's override, both read strictly,
   * right here. The installation-wide layer that used to sit below them is gone
   * (ADR-0011, continuation 2026-08-14); while it existed it deliberately
   * carried neither `passwordEnabled` nor `password`, so it could not have
   * turned this answer into a fail-open either.
   */
  private isLocked(form: {
    id: string;
    settingsOverride: Prisma.JsonValue;
    tenant: { id: string; formDefaults: Prisma.JsonValue };
  }): boolean {
    try {
      return enforcedSettings(form).passwordEnabled;
    } catch (cause) {
      // Same narrowing as `settingsForEnforcement`: a programming error has to
      // reach the 500 path where it is loud, instead of being answered with a
      // calm „bitte Zugangswort eingeben".
      if (!(cause instanceof UnreadableSettingsError)) {
        throw cause;
      }
      this.reportOnce(
        `${cause.message}; treating the form as password-protected (fail closed).`,
      );
      return true;
    }
  }

  /**
   * The password gate.
   *
   * **Every refusal is the one 404** — the same status, the same body and the
   * same stable headers an unknown address gets, because they are raised from
   * the same place with the same message. A wrong word, a form that does not
   * exist, one that was never published, one in the trash, one without a
   * password at all and one whose settings do not parse are one answer. That is
   * the second bullet of the rule, and it is why this method has exactly
   * one `throw`: two throw sites are two bodies that can drift, and the drift
   * would be the oracle.
   *
   * A form **without** a password answering 404 is not an oversight either.
   * Anything else would say „diese Adresse gibt es, sie ist nur nicht
   * geschützt" — which is the sentence the read path is careful never to say
   * about an address that leads nowhere.
   */
  async unlock(slug: string, offered: string): Promise<AccessGrant> {
    let form;
    try {
      form = await this.load(slug);
    } catch {
      // The word is compared even when there is no form, so that „unbekannte
      // Adresse" costs what „falsches Wort" costs. `matches` does the MAC and
      // the dummy decryption on every path; feeding it an empty document is
      // what makes this one take the same route.
      this.accessWords.matches(ABSENT_FORM, offered);
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    // A form nobody can fill in has no gate to pass: an unpublished form, a
    // withdrawn one and a broken snapshot are absent on the read path, and the
    // gate must not be the one place that admits they exist.
    const publishable =
      form.publishedVersion !== null &&
      formDefinitionSchema.safeParse(form.publishedVersion.schema).success;

    if (!this.accessWords.matches(form, offered) || !publishable) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    return { accessToken: this.accessProofs.issue(slug) };
  }

  /**
   * The effective settings behind a public form — **redacted, and tolerant**.
   *
   * Two decisions live here, and both are about what a stranger's request must
   * survive.
   *
   * **Redacted.** The parsers replace the access word instead of opening it
   * , and this service holds no `SecretBoxService` — a path
   * that cannot decrypt cannot leak, however it is edited later. What the
   * payload needs — three display flags and a deadline — is untouched by that.
   *
   * **Tolerant.** The settings schemas are `strictObject`, so a key written by a
   * *newer* deployment is a parse error in an older one — the ordinary state
   * during a rolling deploy, a rollback, or with two replicas of different
   * versions. Here the settings are incidental, so an unreadable document
   * degrades to „nothing decided" and is logged, in the same spirit as the
   * unparseable snapshot a few lines above (which degrades to a logged 404).
   * Without this, one bad `tenant.form_defaults` would answer 500 for **every**
   * form of that organisation.
   *
   * **The enforcement layer must not inherit this fallback.** They read the same
   * values in order to *refuse* submissions, and there „unreadable" cannot mean
   * „no deadline, no limit, no password": that would open a closed form the
   * moment a document stopped parsing. Enforcement fails closed; display falls
   * back. The two readings are different on purpose and need different code.
   */
  private settingsOf(form: {
    id: string;
    settingsOverride: Prisma.JsonValue;
    tenant: { id: string; formDefaults: Prisma.JsonValue };
  }): FormSettings {
    const tenantDefaults = safeRedactedTenantDefaults(form.tenant.formDefaults);
    if (tenantDefaults === null) {
      this.reportOnce(
        `form_defaults of tenant ${form.tenant.id} do not parse; ` +
          'falling back to the shipped defaults for the public payload.',
      );
    }
    const override = safeRedactedFormOverride(form.settingsOverride);
    if (override === null) {
      this.reportOnce(
        `settings_override of form ${form.id} does not parse; ` +
          'falling back to the tenant standard for the public payload.',
      );
    }

    return effectiveSettings(
      // The fallback is the shipped constant — the same thing an organisation
      // that decided nothing means, which is the one honest reading left for a
      // document nobody can read.
      tenantDefaults ?? TENANT_SETTINGS_FLOOR,
      override ?? EMPTY_SETTINGS_OVERRIDE,
    );
  }

  /**
   * The answer count — but only when a limit is configured.
   *
   * Skipping the query otherwise is not micro-optimisation: the public read
   * route is the one a whole organisation hits within a minute when a registration
   * opens, and a count over a form's answers on every single load would be a
   * cost paid by every form for a setting almost none of them use.
   */
  private async countIfLimited(
    formId: string,
    tenantId: string,
    settings: FormSettings,
  ): Promise<number> {
    if (!needsResponseCount(settings)) {
      return 0;
    }
    return this.prisma.response.count({
      // The tenant comes from the resolved form, never from the caller — the
      // same rule the write path follows.
      where: { formId, tenantId, deletedAt: null },
    });
  }

  /**
   * The seats already taken — but only when this form has an Obergrenze
   * anywhere.
   *
   * Skipped otherwise for the reason {@link countIfLimited} states above, and
   * the argument is the stronger one here: `takenSeats` joins two tables, the
   * public read route is what a whole organisation hits in the minute a registration
   * opens, and the overwhelming majority of forms carry no Veranstaltung at
   * all. `boundedRequests` decides it, i.e. the same predicate the write path
   * uses to decide whether to take the lock — one reading of „gibt es hier
   * überhaupt eine Grenze?", not two.
   */
  private async takenIfBounded(
    formId: string,
    tenantId: string,
    definition: FormDefinition,
  ): Promise<Map<string, number>> {
    const bounded = boundedRequests(
      // Every position of the form, with a nominal seat: this asks „is anything
      // here bounded", not „what does somebody want".
      allQuestions(definition).flatMap((question) =>
        question.type === 'event'
          ? question.events.map((event) => ({
              questionId: question.id,
              eventKey: event.key,
              seats: 1,
              capacity: event.capacity,
            }))
          : [],
      ),
    );
    if (bounded.length === 0) {
      return new Map();
    }
    return takenSeats(this.prisma, formId, tenantId);
  }

  /**
   * Accepts a submission — or refuses it.
   *
   * ## Every refusal is one connected chain, and it is at the top
   *
   * The order below is not a matter of taste. **A confirmation mail is queued
   * after an accepted submission**, and a mail
   * is the one thing that cannot be taken back. A refusal sitting
   * *behind* the enqueue would send a Mitglied „Ihre Anmeldung ist
   * eingegangen" for an answer this stage threw away. So everything that can
   * say no says it here, before anything is written and before anything is
   * queued — and the chain is contiguous so a later reader can see that there
   * is no seventh check hiding further down.
   *
   * The chain, in the order a participant experiences it:
   *
   * 1. **404** — unknown address, unpublished form, unreadable snapshot
   *    . The public routes never confirm that a slug exists.
   * 2. **503** — the settings cannot be read. This is the *fail-closed* answer
   *    of the enforcement layer, and the one place where enforcement deliberately parts
   *    company with the display path a few methods up (`settingsOf`, and the
   *    reasoning in `settings-enforcement.ts`).
   * 3. **409 `password_required`** — the form is behind the access word and
   *    this request carries no valid proof. First of the state checks, so
   *    that somebody who has not passed the gate cannot read the state of the
   *    registration off the refusal.
   * 4. **409 `not_yet_open` / `closed`** — the deadline, judged against the
   *    server's clock **now**. Not against the verdict the participant was
   *    shown when the page loaded: the browser tab left open across the closing
   *    instant is the case this check exists for.
   * 5. **409 `time_limit`** — the signed start token is missing, forged or
   *    older than `timeLimitMin`.
   * 6. **400** — the answers themselves. Last of the refusals that can
   *    be decided up here, on purpose: somebody submitting to a form that closed
   *    yesterday needs to hear that it closed, not that their postcode has four
   *    digits.
   * 7. **409 `limit_reached`** — the response limit. The only one that
   *    cannot be decided up here, because counting and inserting have to be a
   *    single decision; it lives inside the transaction below and is still in
   *    front of the enqueue, which is the last thing that transaction does.
   *
   * The validator behind step 6 is derived from the same definition the
   * participant was shown, so "the client let it through" and "the server
   * accepted it" cannot come apart. The client runs it for the sake of the
   * person filling in; this run is the one that counts (`CONTRIBUTING.md`).
   *
   * ## What the honeypot and the sending budget are **not**
   *
   * Neither is an eighth link. They run *behind* the write,
   * inside the same transaction, and the only thing they change is the `status`
   * of the `mail_log` rows this submission would have queued — see
   * {@link mail-suppression.ts}. The chain above stays exactly as long as it
   * was, and that is the whole point: a spam defence that could refuse a
   * submission would be an outage of the registration, which is what the
   * requirement rules out.
   */
  async submit(
    slug: string,
    answers: Record<string, unknown>,
    startToken?: string,
    proof?: string,
    /**
     * The decoy field, **beside** the answers and never inside them
     * (`submitResponseRequestSchema`).
     *
     * Last of the parameters and optional, because a caller that knows nothing
     * about it is an ordinary caller: the field is optional on the wire and an
     * absent one reads as „nicht ausgefüllt" (`honeypot.ts`).
     */
    honeypot?: string | null,
    /**
     * The draft this submission comes **out of**, if there is one.
     *
     * A parameter on the ordinary submission rather than a route of its own, so
     * that „eine Antwort, und der Entwurf ist danach weg" is **one**
     * transaction: the deletion happens inside the very `BEGIN` that writes the
     * answer, so a refused submission keeps the draft and an accepted one cannot
     * leave it behind.
     */
    draftToken?: string,
  ): Promise<SubmitResponseResponse> {
    const form = await this.load(slug);
    const version = form.publishedVersion;
    if (version === null) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const definition = formDefinitionSchema.safeParse(version.schema);
    if (!definition.success) {
      // Same 404, same reason as in `bySlug`.
      this.logger.error(
        `Published snapshot of form ${form.id} does not parse; refusing submission with 404.`,
      );
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    // ---- the refusal chain  ----------------------
    //
    const settings = this.settingsForEnforcement(form);
    const now = new Date();

    /*
     * **The access word — first of the state checks, and deliberately so.**
     *
     * Somebody who has not passed the gate learns only that the gate is there.
     * Putting this behind the deadline would let a stranger without the word
     * read the state of a protected registration off the refusal — „noch nicht
     * geöffnet", „geschlossen", „voll" — which is information the read path is
     * careful to give only to callers who got past the gate.
     *
     * **It does not replace anything that comes after it.** The deadline, the
     * time limit, the answer validation and the response limit all run on a
     * request that carries a perfectly good proof; the word is a hurdle in
     * front of the questions, never an authorisation over the state of the form
     * („fachlicher Rahmen"). A closed form stays closed for the
     * person who knows the word.
     *
     * Read from the **strict** settings above, so an unreadable document has
     * already answered 503 and never reaches „kein Passwortschutz".
     */
    if (
      settings.passwordEnabled &&
      !this.accessProofs.holds(proof, slug, now)
    ) {
      throw refusal('password_required');
    }

    // The deadline check. `responseCount: null` says „ich weiß es nicht" rather than „es sind
    // keine" — the documented way to ask `availabilityOf` about the window
    // alone. The limit is not knowable outside the transaction, and a count
    // taken here would be the stale number the response-limit check exists to defeat.
    const state = availabilityOf({ settings, now, responseCount: null }).state;
    if (state !== 'open') {
      throw refusal(state);
    }

    // The time limit.
    if (
      settings.timeLimitEnabled &&
      !this.startedInTime(slug, settings, startToken, now)
    ) {
      throw refusal('time_limit');
    }

    // The answer validation — the **400**, and everything the shared schema refuses is in it.
    //
    // **The payload bound of this route is `JSON_BODY_LIMIT_BYTES`** (100 KiB,
    // `app-setup.ts`), not the Obergrenze of the table: a table taken to the
    // very limit would come to **123 504 bytes** and therefore hits the body
    // limit first. What the Obergrenze
    // really buys is something else and more valuable: it couples the
    // **storage cost of an answer** back to the schema of the form. Previously
    // a form with a 2-row table accepted **34 112** empty rows
    // in a 100 KiB request (measured); afterwards it is **2** — and across
    // all forms at most `TABLE_ROWS_MAX` = 20, because
    // `tableRowLimit` decides and not the size of the packet. Enforced by
    // `safeParseAnswers`, the same function the edit and the
    // draft path call: a rule that only the fill-in view applied would be
    // none at all, because nothing forces a stranger to use it.
    const parsed = safeParseAnswers(definition.data, answers);
    if (!parsed.success) {
      // The issue list travels, because it is about the sender's own input and
      // carries nothing they did not write. The fill-in view marks the field
      // from `path`; without it a participant is told "something is wrong"
      // about a form with thirty questions. `validationProblem` also carries
      // the machine-readable `code` of the rules that have one — one builder for
      // all three write paths, so a caller can branch on „zu viele Zeilen"
      // wherever it hit — and it **caps** the list at `MAX_VALIDATION_ISSUES`
      // with the true count beside it, because this route answers strangers: a
      // 100-KiB submission used to produce 9404 issues and an 873 523 Byte 400
      // (gemessen am 2026-08-07), i.e. the cheapest amplifier in the
      // application.
      throw new BadRequestException(
        validationProblem(
          'Bitte die markierten Felder prüfen.',
          parsed.error.issues,
        ),
      );
    }

    // The enqueue — the last link, and the only one inside a transaction.
    //
    // The requirement: the notifications are **read** here, before the write,
    // and turned into `mail_log` rows *inside* the transaction below. Reading
    // them cannot refuse anything, so the chain above stays contiguous — and
    // the enqueue itself is behind every one of its links, which is the whole
    // reason this package came last. A refusal sitting
    // behind the enqueue would send „Ihre Anmeldung ist eingegangen" for an
    // answer the enforcement layer threw away, and that is the one mistake nothing can
    // take back.
    const notifications = await this.notificationsOf(form);
    // The attachments are claimed inside the transaction below (ADR-0014
    // no. 13), and a refusal there **throws** so the answer rolls back with it.
    // It is caught here, at the end of the chain where it belongs: „ein Anhang
    // ist abgelaufen" is a refusal a participant can act on, not a 500.
    const outcome = await this.storeWithinLimit(
      form,
      version.id,
      settings,
      parsed.data,
      {
        definition: definition.data,
        notifications,
        // Reduced to a verdict **here**, before it reaches the transaction: the
        // value itself is a string a stranger wrote and has no business
        // travelling any further into this service.
        honeypotFilled: isHoneypotFilled(honeypot),
      },
      // Handed on as it arrived — the wire schema has already bounded it
      // (`draftTokenSchema`), and what it names is looked up under this form's
      // own `form_id` and `tenant_id`, never on its own. A parameter of its own
      // rather than a member of the bag above, which is the *mail* context: a
      // draft has nothing to do with what gets queued, and putting it there
      // would be the second reader of a name that says something else.
      draftToken,
    ).catch((error: unknown) => {
      if (error instanceof ClaimRefusedError) {
        throw refusal(error.refusal);
      }
      throw error;
    });
    if (!outcome.stored) {
      // Both limits answer from here — the Antwortlimit and the
      // participant limit — and the second carries the position it fired
      // on. Written as one `throw` rather than two branches so the two 409s
      // cannot come apart in their status, their shape or their sentence.
      throw refusal(
        outcome.reason,
        outcome.reason === 'event_full' ? outcome.position : undefined,
      );
    }
    // ---- end of the refusal chain ----------------------------------------

    // The requirement: the texts and the redirect come from the effective
    // settings, through the one function that turns them into what a stranger
    // receives — `confirmationOf` is also where the target passes
    // `effectiveRedirect`, so a `javascript:` URL never reaches the browser.
    //
    // From the **strict** read, not a second tolerant one: the document has
    // already been parsed once at the top of the chain, and reading it twice
    // with two different tolerances would be two answers to „was gilt?".
    //
    // The requirement: the edit link is built **here, on the server**, because the
    // same string goes into the confirmation mail sent later and a mail has no
    // browser to assemble one in. `confirmationOf` applies `allowEdit` — a form
    // that does not offer editing answers with `editUrl: null` even though the
    // token exists, and the route re-reads the setting on every access anyway.
    // `await`, and `null` is a real answer: the edit address is built from this
    // organisation's own base address, falling back to the installation's, both **rows**
    // Neither configured hands out a confirmation without a
    // link rather than one with a guessed link — the second cannot be taken
    // back once it is in somebody's inbox.
    return confirmationOf(
      settings,
      await this.editUrlOrNull(form.tenantId, outcome.editToken),
    );
  }

  /**
   * May this caller write bytes against this form? (ADR-0014 no. 14.)
   *
   * ## It is the chain of {@link submit}, minus the links that cannot apply
   *
   * It sits here, next to that chain and not in the upload service, for the
   * reason that chain is contiguous in the first place: two places that decide
   * „ist dieses Formular offen" are two answers to it, and the one that drifts
   * is never the one under test. Every link below is the same code the
   * submission runs.
   *
   * 1. **404** — unknown address, unpublished form, trash. An upload must
   *    not become an oracle for a slug the read path answers 404 for.
   * 2. **503** — the settings cannot be read. *Fail closed*, exactly as on the
   *    submission.
   * 3. **409 `password_required`** — first of the state checks, so somebody who
   *    has not passed the gate learns only that the gate is there and cannot
   *    read the state of a protected registration off the refusal.
   * 4. **409 `not_yet_open` / `closed`** — bytes are not written against a
   *    registration that is not accepting any, and „geschlossen" means the same
   *    thing here as at the submission.
   *
   * **What is deliberately *not* here**, each an omission with a reason:
   *
   * - the **start token**: the time limit measures how long somebody took
   *   to *answer*, and refusing an attachment because the token is stale would
   *   throw away a file whose submission would be refused a moment later anyway
   *   — with a message about a form, not about a file;
   * - the **response limit**: counting seats outside the transaction that
   *   takes one is exactly the stale number that rule forbids, and an
   *   upload takes no seat;
   * - the **answer validation**: there are no answers yet. What replaces
   *   it for the file is the signature check and the two lists (no. 5);
   * - the **per-answer limits** (no. 6): before the submission there is no
   *   answer to measure ten files or 25 MiB against. They are enforced at claim
   *   time (no. 13), and what bounds the upload until then are the per-address
   *   counters of no. 7.
   */
  async openForUpload(
    slug: string,
    proof?: string,
  ): Promise<{ id: string; tenantId: string }> {
    const form = await this.load(slug);
    if (form.publishedVersion === null) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const settings = this.settingsForEnforcement(form);
    const now = new Date();

    if (
      settings.passwordEnabled &&
      !this.accessProofs.holds(proof, slug, now)
    ) {
      throw refusal('password_required');
    }

    // `responseCount: null` — „ich weiß es nicht": the window is the question
    // here, and the seat count is not this route's to take.
    const state = availabilityOf({ settings, now, responseCount: null }).state;
    if (state !== 'open') {
      throw refusal(state);
    }

    return { id: form.id, tenantId: form.tenantId };
  }

  /**
   * The same question as {@link openForUpload}, asked through the **edit
   * token** instead of the slug (ADR-0014 no. 13 last
   * paragraph).
   *
   * It exists because each door has a chain of its own (three of them by now —
   * see {@link openForUploadByDraftToken}), not because the route needed a
   * second name: an attachment added while correcting an answer
   * has to pass what an *edit* passes — the one 404 of `loadForEdit`,
   * `editing_disabled`, the deadline — and explicitly **not** the password
   * gate, which `byEditToken` argues out at length. Without it, a participant
   * correcting a registration to a protected form could change every answer
   * except the one that needs a new scan.
   *
   * Both existing pieces are *called* rather than reproduced, so „darf hier
   * gerade etwas geändert werden" has one answer for the answer and its files.
   * What it deliberately does **not** check is the time limit: that link judges
   * a *submission* against a signed start, an upload is not one, and the
   * correction it belongs to meets it a moment later anyway.
   */
  async openForUploadByEditToken(
    token: string,
  ): Promise<{ id: string; tenantId: string }> {
    const { form } = await this.loadForEdit(token);
    this.editableSettings(form);
    return { id: form.id, tenantId: form.tenantId };
  }

  /**
   * The same question a third time, asked through the **draft token**
   * (a finding of the acceptance run).
   *
   * ## Why a resumed draft needs a door of its own
   *
   * It had none, and the gap was not merely a missing convenience. A resumed
   * draft rendered its Datei-Upload with a disabled picker and a *live*
   * „Entfernen" — so a participant on their second device could throw their
   * scan away and had no way to attach another. Locking the removal instead
   * would have made the screen consistent and worse; what was missing was the
   * door, and this is it.
   *
   * **And it is the only way out of a corner the purge builds.** An unclaimed
   * file is taken after 24 hours (ADR-0014 no. 15), while a draft lives thirty
   * days. Somebody who resumes on day three still *sees* their
   * attachment — the answer carries `{ref, name}` — but the submission is
   * refused, because the claim demands a file younger than the purge window
   * (no. 13, condition 5). Without an upload door, and with a Pflicht file
   * question, that draft could never be submitted at all: removing the
   * attachment fails the Pflicht rule, keeping it fails the claim. With the
   * door the corner is escapable — remove, upload again, send — which is what
   * a participant would expect to be able to do.
   *
   * ⚠️ **What it does not fix, said here rather than discovered again:** an
   * attachment uploaded into a draft is unclaimed like any other and is gone
   * 24 hours later, whether it went up through this door or through the
   * fill-in's. The mismatch between the file's 24 hours and the draft's thirty
   * days stays open; closing it means giving a draft *ownership* of its files
   * (a second owner column on `file`, a claim that transfers at submission,
   * and a purge that knows about both) — a data-model change with its own
   * migration, not a line in this method.
   *
   * ## The chain
   *
   * {@link byDraftToken}'s, called rather than reproduced: the one 404 of
   * `loadDraft` for a token that names nothing, is expired or whose form is
   * gone, plus `draftableSettings` — which is `saving_disabled` when
   * *Zwischenspeichern* was switched off and the deadline otherwise, **read on
   * every access** like the read and the write next to it. No password gate,
   * for the three reasons {@link byDraftToken} sets out: the token is only ever
   * issued past that gate, switching the gate on deletes the drafts of that
   * form in the same transaction, and asking for the word again would break the
   * address on the second device it exists for.
   *
   * Deliberately **not** checked, the same two omissions the other two doors
   * make: the start token (an upload is not a submission, and the time limit
   * judges one) and the response limit (an upload takes no seat).
   *
   * ## Why a narrow query of its own
   *
   * Until the security review this door called `loadDraft` — five joined
   * tables and **two complete `formDefinitionSchema.safeParse`**, in order to
   * throw everything except `form.id` and `form.tenantId` away afterwards.
   * *Measured on 2026-08-05* (40 requests each, median): draft door 11,26 ms
   * against 9,18 ms at the slug door, that is +23 % on a public
   * write path. Small in absolute numbers, but `docs/kb/07-oeffentliche-
   * pfade.md` demands that new work per access be named or removed.
   *
   * {@link loadDraftForUpload} removes it and carries **the same five
   * conditions** — nothing left out, otherwise it would be the shortcut and not the
   * optimization. *Measured again with the same setup:* before 11,32 ms against
   * 9,22 ms at the slug door, afterwards **8,10 ms against 8,90 ms** — +23 %
   * becomes −9 %, and the draft door is thereby what it ought to be: the
   * cheapest of the three, because it reads neither access word nor definition.
   *
   * ⚠️ One difference remains and is named here instead of discovered later: the
   * **404 for a snapshot that no longer parses** belongs to `loadDraft`
   * and falls away here — it is not read. An upload against such a
   * draft is accepted; the bytes stay unclaimed and are gone after
   * 24 hours (no. 15), and this draft cannot be submitted anyway.
   * From outside that is no oracle: only whoever already holds the token
   * can tell the case apart, and the token *is* the authorisation.
   */
  async openForUploadByDraftToken(
    token: string,
  ): Promise<{ id: string; tenantId: string }> {
    const form = await this.loadDraftForUpload(token);
    this.draftableSettings(form);
    return { id: form.id, tenantId: form.tenantId };
  }

  /**
   * The answer behind an edit token, rendered against **its own** version.
   *
   * ## The refusal chain of this route, and what it deliberately leaves out
   *
   * It is the chain of {@link submit} minus the links that do not apply, and
   * every omission is a decision rather than an oversight:
   *
   * 1. **404** — the token is malformed, unknown, points at an answer in the
   *    trash, at a form that is gone or unpublished, or at a snapshot that
   *    no longer parses. One `throw`, one message, byte-identical to every other
   *    „gibt es nicht" of the public routes. A guessed token must
   *    not be able to tell „diese Antwort gibt es" from „diese nicht".
   * 2. **503** — the settings cannot be read. *Fail closed*, exactly as on the
   *    submission; the display path's tolerant fallback is not inherited
   *    (`settings-enforcement.ts`).
   * 3. **409 `editing_disabled`** — `allowEdit` is off. Read **on every
   *    access**, which is the sentence of the rule: a link handed out while
   *    the switch was on stops working the moment it is switched off, and a test
   *    that only checked the setting at issuing time would prove the opposite.
   * 4. **409 `not_yet_open` / `closed`** — the deadline, against the server's
   *    clock now. `responseCount: null`, so `limit_reached` **cannot** be
   *    the verdict: an edit occupies the place it already had, and refusing a
   *    correction because the form filled up afterwards would punish the
   *    participant for other people's registrations.
   * 5. **409 `time_limit`** — see {@link updateByEditToken}; the read mints a
   *    fresh start token, the write judges it.
   *
   * **The password gate does not apply, and that is the one link worth
   * arguing about.** Three reasons, in the order they matter. The token is only
   * ever *issued* to somebody who already passed the gate — the password check is link 3 of the
   * submission chain, so a protected form cannot be submitted to without a valid
   * proof, and no proof means no answer and no token. It is a strictly stronger
   * capability than the word: 128 bits, one single answer, not shared with a
   * whole organisation by circular letter. And it guards something the word does not —
   * the answers, not just the questions. Requiring the word again would make the
   * mailed link unusable in practice: the confirmation puts it in a mail, and a
   * confirmation mail deliberately carries no access word.
   *
   * **The first of those reasons is not free, and what pays for it sits in the
   * settings write** . „Nur wer das Tor passiert hat, hält
   * ein Token" is true of tokens issued *while* the gate stood. A form that was
   * open and unprotected hands out tokens too, and switching the protection on
   * afterwards — the usual reason being that the link leaked — would leave those
   * pointing at this unauthenticated route with the full field definition behind
   * it, which is exactly what the password gate promises cannot exist. So switching the access
   * word on, or changing it, **clears `response.edit_token` for that form** in
   * the same transaction as the settings (`FormSettingsService`,
   * `revokesEditLinks` in `@formsache/shared`). That is the lever the column exists
   * for, and it is why the token is a stored value and not a signature.
   *
   * The price is named rather than hidden, and it is the participants' side:
   * setting or changing the access word takes their edit link away, and they
   * have to register again to correct anything. The settings page says so
   * before the save, not afterwards.
   */
  async byEditToken(token: string): Promise<ResponseEdit> {
    const { response, form, definition, liveDefinition } =
      await this.loadForEdit(token);
    const settings = this.editableSettings(form);

    /*
     * The seat state a **correction** sees.
     *
     * Three things differ from the first fill-in above, and they follow rules
     * this file already states elsewhere:
     *
     * - **The live definition decides the Obergrenze**, not the snapshot — it
     *   is an operating limit the organisation changes without republishing the
     *   questions (`withLiveCapacity`). A position the live form no longer
     *   names produces no entry and is therefore unbounded, exactly as the
     *   enforcement reads it.
     * - **The snapshot decides which positions exist at all**
     *   (`snapshotEventSeats`, a security review). This route is public,
     *   sessionless and deliberately past the access word, so building the list
     *   from the live definition told whoever holds one old token about
     *   Veranstaltungen published after their answer — on a protected form,
     *   about content behind the gate. What the answer's own version never
     *   contained does not appear here.
     * - **This answer's own seats come off the sum.** Without that, somebody
     *   correcting a registration on a full Veranstaltung would see „Ausgebucht"
     *   over the box holding their own three seats and could not even *lower*
     *   the number — the one change the requirement promises always works. Their own share
     *   is theirs; what is left for them is what is left for everybody else plus
     *   what they already hold.
     */
    const taken = await this.takenIfBounded(
      form.id,
      form.tenantId,
      liveDefinition,
    );
    for (const [key, held] of await heldSeats(this.prisma, {
      responseId: response.id,
      tenantId: form.tenantId,
    })) {
      const sum = taken.get(key);
      if (sum !== undefined) {
        taken.set(key, Math.max(0, sum - held));
      }
    }

    return {
      form: {
        locked: false,
        title: form.title,
        version: response.formVersion.version,
        tenant: tenantOf(form.tenant),
        definition,
        display: {
          showProgress: settings.showProgress,
          showPageNumbers: settings.showPageNumbers,
          showRequiredHint: settings.showRequiredHint,
        },
        availability: publicAvailability(
          availabilityOf({ settings, now: new Date(), responseCount: null }),
        ),
        eventSeats: snapshotEventSeats(definition, liveDefinition, taken),
        // A fresh attempt, so a fresh start token — bound to the form's
        // slug, like every other one. No new signing purpose: „diese Ausfüllung
        // begann um T für Formular X" is the same statement here as there.
        startToken: this.startTokens.issue(form.publicSlug),
        // The time limit of this attempt — see `bySlug` for the ternary and
        // `publicFormSchema.timeLimitMin` for the contract. The correction of
        // an answer is an attempt like any other: it mints a token one line up
        // and is refused with `time_limit` if it takes too long, so the number
        // that binds it belongs on the screen that shows it. Read from
        // `editableSettings`, which is the **strict** path — this payload
        // therefore cannot announce „kein Zeitlimit" for a document that does
        // not parse; that request has already answered 503.
        timeLimitMin: settings.timeLimitEnabled ? settings.timeLimitMin : null,
        // **`false`, whatever `allowSaveDraft` says** . This is
        // an answer that is already filed; there is no draft route that takes
        // it, so offering the button would advertise an action that does not
        // exist here. The field says what *this view* can do, not what the form
        // is configured for.
        canSaveDraft: false,
        // The privacy notice of this form — **here too**, for the
        // reason the footer stands here: whoever opens this link is
        // the same person who filled the form in, and is changing
        // their details right now. That is a processing of the same data for the same
        // purpose, and the information about it belongs on the same page.
        privacyNotice: privacyNoticeOf(form, settings),
      },
      // As stored. They were validated against this very version on the way in
      // and are handed back untouched; re-validating them *against the
      // definition* here would turn a snapshot that has since become stricter
      // into an answer nobody can open again.
      //
      // Parsed all the same, but only for the one thing the wire type claims:
      // that this is a JSON **object**. `Prisma.JsonValue` is equally happy with
      // an array, a number or `null` — a row written by hand or by a restore
      // could carry any of them — and asserting the shape instead of checking it
      // is what `CONTRIBUTING.md` rules out. A column that is not an object is a
      // broken row, and the 500 that comes out of this is the honest answer to
      // one.
      answers: storedAnswersSchema.parse(response.answers),
      submittedAt: response.submittedAt.toISOString(),
      editedAt: response.editedAt?.toISOString() ?? null,
    };
  }

  /**
   * Replaces the answers behind an edit token.
   *
   * **No second row — but the Obergrenze holds all the same, and the two are
   * not the same statement** (and the ⚠️ it ends on). This is
   * an `UPDATE` of the row the token points at, so the **Antwortlimit**
   * is not consulted: the answer already holds its place, and counting it again
   * would let a form that filled up afterwards refuse a correction to a
   * registration that was in time. The **participant limit** is the other way
   * round, and for the same reason read forwards: the place *this answer* has
   * is its own, the two additional people it now names are not. What is
   * therefore checked is the **difference** — see {@link storeEditWithMails}.
   *
   * **The schema stand does not move.** Validation runs against
   * `response.form_version` — the snapshot this answer was submitted against
   *  — and not against whatever is published today. An answer given to
   * version 2 is corrected as version 2; the alternative would silently demand
   * fields that did not exist when the participant registered.
   *
   * **`submitted_at` is not touched, `edited_at` is set.** The two are separate
   * columns for the reason that matters: an organisation reconciles its
   * registration list against when a registration *arrived*, and moving that
   * instant on every typo would push registrations past deadlines they met.
   *
   * Two edits with the same token racing each other are last-write-wins. There
   * is no lock, deliberately: the token names one participant's own answer, so
   * the two writers are the same person on two devices, and a conflict dialog
   * for that is machinery nobody would ever see fire.
   *
   * **An accepted edit queues what it sets off, in the same transaction**
   * (the acceptance run). See
   * {@link storeEditWithMails} for both halves of that claim; the enqueue sits
   * behind the whole refusal chain above, exactly as it does on the submission,
   * so a refused edit changes neither `response` nor `mail_log`.
   */
  async updateByEditToken(
    token: string,
    answers: Record<string, unknown>,
    startToken?: string,
    /** The honeypot's decoy field — the edit form carries it too. */
    honeypot?: string | null,
  ): Promise<SubmitResponseResponse> {
    const { response, form, definition, liveDefinition } =
      await this.loadForEdit(token);
    const settings = this.editableSettings(form);
    const now = new Date();

    // The time limit — the same link the submission has, in the same place in the chain.
    if (
      settings.timeLimitEnabled &&
      !this.startedInTime(form.publicSlug, settings, startToken, now)
    ) {
      throw refusal('time_limit');
    }

    const parsed = safeParseAnswers(definition, answers);
    if (!parsed.success) {
      throw new BadRequestException(
        validationProblem(
          'Bitte die markierten Felder prüfen.',
          parsed.error.issues,
        ),
      );
    }

    // Read after the last refusal and before the transaction — the same place
    // and for the same reason as in `submit()`: reading cannot refuse anything,
    // so the chain above stays contiguous.
    const notifications = await this.notificationsOf(form);
    await this.storeEditWithMails(
      { response, form, definition, liveDefinition },
      settings,
      parsed.data,
      now,
      notifications,
      isHoneypotFilled(honeypot),
      // The attachments are claimed inside that transaction (ADR-0014 no. 13);
      // a refusal throws so the correction rolls back with it, and it becomes
      // the same 409 the submission answers rather than a 500.
    ).catch((error: unknown) => {
      if (error instanceof ClaimRefusedError) {
        throw refusal(error.refusal);
      }
      throw error;
    });

    // The same confirmation a first submission gets, link included: the
    // participant may well want to correct something again, and a receipt that
    // silently dropped the address would make the second correction impossible.
    return confirmationOf(
      settings,
      await this.editUrlOrNull(form.tenantId, token),
    );
  }

  /**
   * Writes the corrected answer and queues the change mails — **as one
   * decision** (the acceptance run).
   *
   * ## Why this is a transaction at all
   *
   * Until a review this was a single `updateMany` and needed no
   * `BEGIN`. It writes several rows now, and „die Antwort und ihre Mail
   * committen gemeinsam" is the same promise the submission makes — with the
   * same two failure directions, and they are not symmetric in cost. A mail that
   * committed while the answer rolled back announces a change nobody made; an
   * answer that committed while the enqueue failed leaves the office's filed
   * mail wrong with **nothing saying so**, which is the silent divergence this
   * whole work item exists to close, and the one nobody notices.
   *
   * Neither *after* the transaction nor in a transaction of its own: those are
   * exactly the two shapes the acceptance probes discriminate, and they catch
   * **different** ones — enqueueing after leaves the „Speichern scheitert" case
   * green, enqueueing separately leaves the „Einreihen scheitert" case green.
   *
   * `written.count === 0` survives the move and still does the work it did
   * before: it is the guard against an answer that reached the trash
   * between the read and this write, and `updateMany` is what allows a count of
   * zero to be an answer rather than an exception. Raised **inside** the
   * transaction now, so the enqueue rolls back with it.
   */
  private async storeEditWithMails(
    edited: {
      /**
       * `answers` is the row **as it stands before this write** — the only
       * place the previous values still exist (see `previousAnswers` below).
       */
      readonly response: {
        id: string;
        submittedAt: Date;
        answers: Prisma.JsonValue;
      };
      readonly form: {
        id: string;
        tenantId: string;
        title: string;
        tenant: { name: string; replyTo: string | null };
      };
      /** The snapshot **this answer** was submitted against, never the draft. */
      readonly definition: FormDefinition;
      /**
       * What the form asks **today** — read only for the Obergrenzen
       * (`withLiveCapacity`). Everything else about this correction is judged
       * against {@link definition}.
       */
      readonly liveDefinition: FormDefinition;
    },
    settings: FormSettings,
    answers: AnswerMap,
    now: Date,
    notifications: readonly SubmissionNotification[],
    /** The verdict of {@link isHoneypotFilled} . */
    honeypotFilled: boolean,
  ): Promise<void> {
    const { response, form, definition, liveDefinition } = edited;

    /*
     * **The old values, read before the `UPDATE` overwrites them** — what
     * `{{aenderungen}}` is rendered from.
     *
     * There is no history of answers in this system. `response.answers` is the
     * document as `loadForEdit` read it a moment ago, and the moment
     * `tx.response.updateMany` below runs, the previous values are gone for
     * good — which is why the change block is assembled here, at the enqueue,
     * inside the same transaction that writes the new answer, and not at send
     * time like the edit link. A renderer running later would have nothing left
     * to compare against.
     *
     * Read before the transaction rather than inside it, because that is where
     * the row was read; two edits racing each other are last-write-wins here as
     * everywhere on this path (see the method comment above), so the loser's
     * change block can describe a step somebody else has already overtaken.
     * Locking the row for a mail's sake would serialise one participant's own
     * two devices — see the same argument at the missing `FOR UPDATE`.
     *
     * **That window has a sharper edge since 2026-07-29** (finding E of that
     * review; noted here, not closed here). Edit A commits P→X between this
     * read and edit B's own `UPDATE`; edit B, still holding baseline P, then
     * writes P back on top of X and computes `changes = []` against a baseline
     * the row no longer has — silently discarding A's step without telling
     * anyone. Pre-existing (last-write-wins was always the rule on this path,
     * per the paragraph above) and the fault is not new, but the *consequence*
     * is: before „no change, no mail" this produced a mail with an empty
     * change block; now it produces no mail at all. Closing it would mean
     * moving this read inside the transaction — locking the row, i.e.
     * serialising the edit path — which is a decision about locking this fix
     * does not make.
     *
     * A document that is not an object at all (a hand-written or restored row)
     * yields `null`: „ich weiß nicht, was vorher dastand" renders the block to
     * nothing, whereas `{}` would claim every answered question had just been
     * filled in for the first time.
     */
    const stored = storedAnswersSchema.safeParse(response.answers);
    const previousAnswers = stored.success ? stored.data : null;

    /*
     * **Everything that decides *whether* a mail is queued now happens before
     * the `BEGIN`** (a review finding).
     *
     * All of it is pure arithmetic over values this method already holds — the
     * answer as it was read, the answer as it is being written, the snapshot and
     * the notifications — so moving it out changes no result. What it changes is
     * the blast radius: the one *query* among them, the budget count, used to
     * run inside the transaction that had just written the corrected answer, and
     * a statement timeout or an exhausted pool there took the correction down
     * with it. A spam defence may not be able to fail an edit, and
     * „fail" includes „throw a 500 on the way out".
     */
    const context = mailContextOf({
      tenantName: form.tenant.name,
      formTitle: form.title,
      // `{{datum}}` keeps its one meaning — **the date of the
      // registration**, not of the correction. The placeholder is
      // documented as the submission date and is rendered from
      // `response.submitted_at` on the other path; a second meaning
      // depending on which path filled it in would be two placeholders
      // spelled the same.
      submittedAt: response.submittedAt,
      definition,
      // The **new** values: a change mail whose body showed the old ones
      // would be the divergence it is meant to announce.
      answers,
      // …and the old ones beside them, for `{{aenderungen}}` alone.
      previousAnswers,
    });

    /*
     * **No mail for an edit that changed nothing** — replaces the
     * response-level debounce this comment used to describe.
     *
     * The old rule asked whether *a mail for this answer* was still
     * `queued`, not whether *this edit* changed anything — a single
     * waiting row swallowed the whole next batch, including recipients
     * whose own mail had already gone out. Its window was not the fifteen
     * seconds the mail worker polls at either: a failed attempt with
     * retries left keeps a row `queued` (`mail-worker.service.ts`), with
     * `MAIL_MAX_ATTEMPTS = 5` and a 60s→120s→240s→480s backoff — up to
     * fifteen minutes in which an SMTP outage at the office silenced
     * exactly the mail that tells a **participant** their Bearbeiten-Link
     * is in use. And since `{{aenderungen}}` froze its own block per row
     * , the suppressed mail took its block to
     * the grave with it — a second, independent loss.
     *
     * **The decision is read off `context.changes` — the exact array
     * `{{aenderungen}}` is rendered from (`answerChanges` in
     * `notification-render.ts`) — never a second comparison written here.**
     * Two independently maintained answers to „did anything change" have
     * diverged in this project before, every single time they existed; the
     * only way this check and the placeholder cannot disagree is asking
     * the one function that already computes it.
     *
     * **Unreadable previous values are not „nothing changed" — they mean
     * „not knowable", and that has to fail towards sending.**
     * `previousAnswers` is `null` exactly when `storedAnswersSchema.safeParse`
     * above could not read the stored document; staying silent because a
     * column failed to parse would hide the one thing a participant most
     * needs to hear — that their answer was just edited — behind a storage
     * fault nobody chose. Same family as *fail closed*, mirrored,
     * because here the silence is the damage. `context.changes` reads `[]`
     * in that case too (`mailContextOf` cannot diff without a `previous`
     * side), so the `null` check has to run first and cannot be replaced by
     * `context.changes.length === 0` alone.
     *
     * **Holds independent of whether any notification's text even uses
     * `{{aenderungen}}`.** This says „this edit was not one", not „this
     * template has nothing to fill in" — a form without the placeholder
     * still gets no mail for a no-op edit.
     *
     * **The defence against a flood of edits is the per-form sending
     * budget (a known open point), not this.** A rapid run of *genuine*
     * corrections still queues one mail per edit, exactly as a rapid run
     * of distinct submissions always has — the debounce never protected
     * against that case anyway.
     */
    const unchanged = previousAnswers !== null && context.changes.length === 0;

    const pending = unchanged
      ? []
      : submissionMails({
          trigger: 'edit',
          notifications,
          // The two lower levels of the chain; the topmost one is read by
          // `submissionMails` per notification.
          replyToDefaults: await this.replyToDefaults(form),
          context,
        });

    /*
     * **The requirement — the budget holds on this path too, and these lines are
     * the whole of it.**
     *
     * The edit route is public and token-borne: a leaked link can produce mail,
     * and the „no change, no mail" rule above is not a defence against that — it
     * suppresses a *repetition*, not a *quantity over time*. A script that
     * changes one answer back and forth passes it on every request. Two
     * measures, two problems; removing the rule above does not make the other
     * proof red, and that is deliberate.
     *
     * `pending.length === 0` short-circuits the count (a review finding): an
     * edit that changed nothing, and a form with no notification firing on
     * `edit`, have nothing to cap — and an aggregate query per request to
     * establish that is a cost the overwhelming majority of edits would pay for
     * no effect.
     */
    const queuedAt = this.mailClock.now();
    const budget =
      pending.length === 0
        ? null
        : await this.mailAllowance(form, settings, honeypotFilled, queuedAt);

    // Outside the transaction because the release below needs it after the
    // commit; a pure function of the answer, so reading it here rather than
    // inside changes nothing about what is claimed.
    const attachments = attachmentsIn(definition, answers);

    /*
     * The seats the **corrected** answer asks for, read once from the shared
     * reader — the same list that decides the check below and that is written
     * into `event_registration` at the end of the transaction (the requirement:
     * one value, two places, never two readings).
     */
    const seats = seatRequests(definition, answers);
    /*
     * **The Obergrenze comes from the *live* form, not from the snapshot**
     * (`withLiveCapacity` says what that cost when it did not). Everything else
     * about this correction is judged against the version the answer was given
     * under; the capacity is an operating limit the organisation changes without
     * republishing what the form asks.
     */
    const bounded = boundedRequests(withLiveCapacity(seats, liveDefinition));

    await this.prisma.$transaction(
      async (tx) => {
        /*
         * **The requirement — the Bearbeiten difference, under the same lock the
         * submission takes.**
         *
         * The condition is the *new* answer's bounded positions and nothing
         * else — **a correction that names no bounded Veranstaltung at all**
         * can refuse nobody, so it must not serialise itself behind every
         * submission to this form.
         *
         * A correction that only *lowers* a number does take the lock, and
         * that is not an oversight: knowing it is a reduction means knowing
         * what this answer already holds, and reading that outside the lock
         * would be the very race the lock is here for. The capacity-lock review found
         * this sentence claiming otherwise — in the same commit that removed
         * three comments which had stopped being true.
         *
         * The lock is the `FOR UPDATE` of `lockForm`, i.e. the same object the
         * submission path locks — one lock order, no deadlock between the two
         * write paths. Without it, corrections read a sum none of the others
         * has committed and each concludes there is room: measured on
         * 2026-08-01 with this check in place but the lock removed, **11 of 20
         * simultaneous corrections were accepted instead of 5 — 42 seats in a
         * hall for 30**, three runs, the same number every time
         * (`event-limit.spec.ts`, „twenty corrections rise at once").
         *
         * ⚠️ **Not** because of two tabs on *one* answer, although that is how
         * the requirement words its the evidence. One answer's rows are replaced
         * rather than added to, so two tabs raising the same registration to
         * five end at five however they interleave; the case that overbooks is
         * different answers rising at the same time, and that is the one the
         * spec measures.
         */
        if (bounded.length > 0) {
          await lockForm(tx, form.id, form.tenantId);

          /*
           * **Difference, not new value, and not old value** (see
           * {@link seatsBeyond} for both mistakes side by side). The sum
           * already contains this answer's own seats — it is not in the
           * trash, or `loadForEdit` would have refused it — so „was noch
           * frei sein muss" is what it asks for *beyond* what it holds.
           */
          const position = exhaustedPosition(
            bounded,
            await takenSeats(tx, form.id, form.tenantId),
            seatsBeyond(
              await heldSeats(tx, {
                responseId: response.id,
                tenantId: form.tenantId,
              }),
            ),
          );
          if (position !== null) {
            /*
             * **A throw, unlike the submission's returned verdict**, and the
             * difference is what has already happened: the submission has
             * written nothing at this point and can answer with a value, an
             * edit has a transaction to abort. The `catch` in
             * {@link updateByEditToken} translates only `ClaimRefusedError` and
             * rethrows everything else untouched, so this arrives as the same
             * 409 with the same body the submission answers with — and the
             * stored answer never changes, which is the load-bearing half of
             * the evidence.
             */
            throw refusal('event_full', position);
          }
        }

        const written = await tx.response.updateMany({
          where: { id: response.id, tenantId: form.tenantId, deletedAt: null },
          data: { answers: toStoredAnswers(answers), editedAt: now },
        });
        if (written.count === 0) {
          throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
        }

        /*
         * **The correction claims its attachments too** (ADR-0014 no. 13, last
         * paragraph: „Beim Bearbeiten gilt dasselbe `UPDATE` für neu
         * hinzugekommene Dateien").
         *
         * The same five conditions and the same statement, because the door is
         * the same: an edit that added a proof and never claimed it would
         * leave that file unowned, and the purge would take it a day later — a
         * stored answer pointing at bytes that are gone, which is the worst
         * outcome the ADR names. The re-claim of files this answer *already*
         * owns is a no-op by construction (condition 1's disjunction), so the
         * per-answer limits of no. 6 are measured over the whole answer rather
         * than over the difference.
         *
         * `now` is the request's clock rather than the database's, unlike the
         * submission, which has `response.submittedAt` to hand. The difference
         * is a clock skew between the API and PostgreSQL, and the second bolt
         * of no. 15 — the purge holding its rows with `SELECT … FOR UPDATE` —
         * is what covers it.
         *
         * **And what the correction removed loses its owner** (the attachment review, 2026-08-01).
         * That was an open rest until this package — the comment here said so —
         * and it was the expensive half: a removed attachment kept its owner
         * for ever, so the purge of no. 15 (which only takes files *without*
         * one) never looked at it again and the bytes of somebody's
         * certificate simply stayed. `releaseAttachments` runs **after** the
         * claim, so „was diese Antwort noch nennt" is exactly the set just
         * claimed and needs no diff against what it named before.
         */
        await claimAttachments(tx, {
          files: attachments,
          formId: form.id,
          tenantId: form.tenantId,
          responseId: response.id,
          now,
        });
        await releaseAttachments(tx, {
          responseId: response.id,
          tenantId: form.tenantId,
          keep: refsOf(attachments),
        });

        /*
         * **The seats follow the corrected answer**  — in
         * the same transaction, from the same reading of the same answer the
         * `UPDATE` above wrote.
         *
         * Replaced rather than diffed: „was diese Antwort belegt" is exactly the
         * list `seatRequests` just produced, the same shape the claim above
         * takes, and a difference computed here would be a second description of
         * it. The unique index makes the pair safe in either order; delete first
         * so a Veranstaltung that was removed from the answer loses its row
         * instead of keeping it for ever — the mistake `releaseAttachments`
         * above was added for, one type further along.
         *
         * **`seats` is the very list the difference above was measured on**
         * . Reading the answer a second time here would make the
         * check and the write two opinions about „3 Personen zum Konzert",
         * and the one that ends up in the column would be the one nothing
         * checked.
         *
         * A reduction needs nothing but these two statements: the rows are
         * replaced by the smaller ones and the next `SUM` is lower the moment
         * this transaction commits — „eine Verringerung gibt sofort frei" is
         * the absence of any further machinery, not the presence of some.
         */
        await tx.eventRegistration.deleteMany({
          where: { responseId: response.id, tenantId: form.tenantId },
        });
        await writeSeats(
          tx,
          {
            formId: form.id,
            tenantId: form.tenantId,
            responseId: response.id,
          },
          seats,
        );

        // `null` is „nichts einzureihen" — the correction is written and that is
        // the end of it. Never „unbegrenzt": the two are one `?:` apart and the
        // wrong one would make the budget a suggestion.
        if (budget === null) {
          return;
        }

        await tx.mailLog.createMany({
          data: capMails(pending, budget.allowance, budget.reason).map((row) =>
            toMailLogRow(form, response.id, row, queuedAt),
          ),
        });
      },
      /*
       * The same budget the submission's transaction runs with — and since
       * the requirement this path takes the **same `FOR UPDATE`** too, whenever
       * the corrected answer names a bounded Veranstaltung (see the top of the
       * callback).
       *
       * Two edits by one participant on two devices are therefore serialised
       * now, which used to be the argument *against* locking here. It has
       * turned into the argument *for* it: an edit that decides something from
       * a seat total may not decide it on a total somebody else has already
       * moved. Last-write-wins on the answer document itself is untouched by
       * that (the two writers still overwrite each other's text); what the lock
       * buys is that neither of them can hand out a seat the other just took.
       *
       * **What the lock costs, measured rather than reasoned about**
       * (2026-08-01, a review observation: an `INSERT` into
       * `event_registration` already took `FOR KEY SHARE` on this form row and
       * therefore already blocked submissions — the worry was that this widens
       * the window from „ab `writeSeats`" to „ab `BEGIN`", with the 20 s below
       * as the ceiling). Fifteen edits against fifteen submissions on one form,
       * all thirty in flight: **383–390 ms before, 401–466 ms after** — the same
       * order, and **3–22 %** more under full contention (the capacity-lock review
       * did the division; „5–20 %" was written here first and did not follow
       * from the numbers beside it). The setup is in the repo rather than in
       * this paragraph: `event-limit.spec.ts`, „what the lock costs", skipped
       * because it measures rather than asserts — remove the `.skip` to repeat
       * it. One submission against
       * one concurrent edit: **17.0 → 20.7 ms before, 16.7 → 19.8 ms after**,
       * i.e. the ~3 ms a concurrent edit costs a submission is unchanged. The
       * 20 s is a timeout, not a wait anybody observed. And a correction whose
       * answer names no bounded Veranstaltung takes no lock at all, which the
       * same measurement confirms is unchanged (unbounded event 271→259 ms, no
       * event at all 191→199 ms, both inside the run-to-run spread).
       */
      { maxWait: 20_000, timeout: 20_000 },
    );

    // **After the commit, for the same reason as the submission's release**
    // (ADR-0014 no. 7): the waiting-room quota is process memory and memory
    // does not roll back, so giving the allowance back before the `COMMIT`
    // would hand it back for a claim a later statement undid.
    //
    // Missing here until the attachment review (2026-08-01), and both reviews found
    // it independently. The claim above is the same claim the submission makes;
    // what was missing was only the counterpart in memory, and its absence
    // pointed the wrong way — at the honest caller, not at an attacker. An
    // office behind one address correcting registrations with a fresh scan each
    // fills its own waiting room and gets a 413 from the twenty-first onwards,
    // for up to a day, with every one of those files long since claimed. That
    // is precisely the outcome `upload-quota.ts` calls „the shorter code and
    // the wrong number".
    //
    // Reached only on a commit, and that is the same rule the submission
    // follows rather than an exception to it: there the transaction *returns* a
    // refusal, here it throws one (the Obergrenze, or the attachment
    // claim), and in both cases the answer was not written, so the files of an
    // answer nobody stored must keep occupying the room. Giving the allowance
    // back for a claim that never happened is precisely what would let one
    // address reset its own waiting room by being refused on purpose.
    releaseUploads(refsOf(attachments));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Zwischenspeichern — the requirement, the concept
  //
  // Three routes, and **not one of them queues a mail**. That is the decision
  // itself and not an omission: the participant is shown the address and copies
  // it, so `notificationTriggerInputSchema` still refuses `save` and nothing
  // here reads a notification.
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Stores a half-filled form and answers with the address to continue at.
   *
   * ## The refusal chain — the submission's, minus the links that cannot apply
   *
   * It sits next to that chain rather than in a service of its own, for the
   * reason that chain is contiguous in the first place: two places deciding „ist
   * dieses Formular gerade offen" are two answers to it, and the one that drifts
   * is never the one under test. Every link below is the same code a submission
   * runs.
   *
   * 1. **404** — unknown address, unpublished form, unreadable snapshot,
   *    trash, deleted organisation. A draft must not become an oracle for a slug
   *    the read path answers 404 for.
   * 2. **503** — the settings cannot be read. *Fail closed*, exactly as on the
   *    submission: „unlesbar" must never mean „kein Passwortschutz, keine
   *    Frist".
   * 3. **409 `password_required`** — first of the state checks, so somebody who
   *    has not passed the gate learns only that the gate is there and cannot
   *    read the state of a protected registration off the refusal.
   * 4. **409 `saving_disabled`** — *Zwischenspeichern* is off. Evaluated **here,
   *    on every request**, which is the whole of the fourth trap: a route that
   *    only consulted the switch when it handed an address out would keep
   *    serving drafts of a form whose editor turned it off yesterday.
   * 5. **409 `not_yet_open` / `closed`** — the deadline, against the server's
   *    clock now. A registration that is not accepting answers has nothing to
   *    hold a half-filled one for.
   * 6. **400** — the answers, validated with `safeParseDraftAnswers`: everything
   *    a submission is held to **except** the Pflicht rule (see there for the
   *    full list of what stays).
   *
   * **What is deliberately not here**, each an omission with a reason:
   *
   * - the **Antwortlimit** : a draft is not an answer, so counting one
   *   here would be the flag-on-a-response this design rules out, read from
   *   the other end. `responseCount: null` is what keeps `limit_reached` from
   *   even being a possible verdict;
   * - the **participant limit**: a draft occupies no seat, so there is
   *   nothing to count and nothing to lock. The seats are taken by the
   *   submission that comes out of it, under the lock, exactly as any other;
   * - the **start token** : the time limit measures how long an *attempt*
   *   took, and a draft is somebody stopping. The resume mints a fresh one, so
   *   the limit runs from the moment they come back — the same treatment the
   *   edit route gives it;
   * - the **honeypot** and the **Versandbudget** : both decide
   *   whether a *mail* goes out, and this route sends none.
   */
  async saveDraft(
    slug: string,
    answers: Record<string, unknown>,
    proof?: string,
  ): Promise<SavedDraft> {
    const form = await this.load(slug);
    const version = form.publishedVersion;
    if (version === null) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const definition = formDefinitionSchema.safeParse(version.schema);
    if (!definition.success) {
      // Same 404, same reason as in `bySlug` and `submit`.
      this.logger.error(
        `Published snapshot of form ${form.id} does not parse; refusing the draft with 404.`,
      );
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const settings = this.settingsForEnforcement(form);

    if (
      settings.passwordEnabled &&
      !this.accessProofs.holds(proof, slug, new Date())
    ) {
      throw refusal('password_required');
    }
    this.draftGate(settings);

    // Parsed and stored kept apart: the claim below reads the **parsed**
    // answers, which is the shape `attachmentsIn` walks (`AnswerMap`), while
    // the column takes the stored one.
    const parsed = this.parseDraft(definition.data, answers);
    const stored = toStoredAnswers(parsed);

    // **From the injected clock, not from `new Date()`** — the same requirement
    // `deleted_at` has since the query-conditions review, and for the same reason: „29
    // Tage bleibt, 31 ist weg" is only measurable over the routes if a suite can
    // move the calendar that writes the boundary. It is deliberately the *same*
    // clock the trash purge reads, because both answer one question —
    // „seit wann ist das hier fällig" — and two calendars over one retention is
    // how that question comes to have two answers.
    const expiresAt = draftExpiresAt(settings, this.mailClock.now());
    const token = mintDraftToken();

    /*
     * **The draft and the claim on its attachments come into being together**
     * (the requirement).
     *
     * One transaction, for both directions of the same argument the submission
     * makes at `storeWithinLimit`: a draft that committed while its files were
     * left unclaimed names attachments that die in 24 hours although it lives
     * thirty days — the very Zumutung this package removes, back again and only
     * on the unlucky path — and a claim that committed while the draft rolled
     * back would give ownership to a row that does not exist.
     *
     * The `INSERT` still carries the Mengengrenze in its own `WHERE` (the
     * drafts review, see `draft-quota.ts`), which is why it comes back as an id
     * or `null` rather than throwing.
     */
    const written = await this.prisma.$transaction(async (tx) => {
      const draftId = await insertDraftWithinLimit(tx, {
        // From the resolved form, never from the request — the participant says
        // which form, and the form says which Organisation.
        tenantId: form.tenantId,
        formId: form.id,
        // The snapshot this draft is **started** against. The resume renders it
        // against this same version and the submission validates against it, so
        // a form republished in the meantime cannot hand somebody their answers
        // back under different questions.
        formVersionId: version.id,
        token,
        answers: stored,
        expiresAt,
      });
      if (draftId === null) {
        return false;
      }
      /*
       * **No `releaseDraftAttachments` beside it, unlike in the `PUT`** — and
       * that is no forgotten twin (a security review, a review finding): `draftId` comes from the `gen_random_uuid()` of the `INSERT`
       * one line further up, so it came into being in this transaction.
       * No `file` row of the installation can carry it, there is nothing to
       * release. What this draft **later** no longer names is released by
       * {@link updateDraft}.
       */
      await claimForDraft(tx, {
        files: attachmentsIn(definition.data, parsed),
        formId: form.id,
        tenantId: form.tenantId,
        draftId,
        // The wall clock, like every other reading of the 24 hours of ADR-0014
        // no. 15: `file.created_at` is written by the database's own clock, and
        // the injected calendar above is the *retention* of the draft. The two
        // are one in production; a suite that moves the retention must not
        // thereby make yesterday's upload claimable.
        now: new Date(),
      });
      return true;
    }, PUBLIC_DRAFT_TRANSACTION_BOUNDS);
    if (!written) {
      // The refusal of its own name (the concept gives none, so it is this
      // review's): the form is open and takes answers, only the drafts are
      // full. It is deliberately **not** `limit_reached`, which is a statement
      // about the Antwortlimit and would tell a participant to stop filling in.
      throw refusal('draft_limit');
    }

    return {
      draftUrl: await this.draftUrlOrNull(form.tenantId, token),
      expiresAt: expiresAt.toISOString(),
      // **Which draft this is** — see `savedDraftSchema.token`. It is what lets
      // the fill-in view's *second* press be the `PUT` next door instead of a
      // second `POST` here, and it is answered even when `draftUrl` came back
      // `null`: an installation without a base address still has a draft that
      // can be written on.
      token,
    };
  }

  /**
   * The half-filled form behind a draft address —
   * the whole point of the draft living on the **server**: this answers in a
   * browser that has never seen the form.
   *
   * The chain is {@link saveDraft}'s minus the password gate, and that omission
   * is the one worth arguing about. It is the same argument
   * {@link byEditToken} makes and it holds here for the same three reasons: the
   * token is only ever issued to somebody who already passed the gate (link 3
   * above), it is a strictly stronger capability than a word a whole organisation is
   * told by circular letter, and requiring the word again would make the address
   * unusable on the second device it exists for.
   *
   * **And the first of those reasons is paid for in the same place**: switching
   * the access word on, or changing it, **deletes the drafts of that form** in
   * the transaction that writes the settings (`revokesEditLinks` in
   * `@formsache/shared`). Without that, a draft address handed out while the form was
   * open would keep serving the full field definition past a gate that promises
   * it cannot be read. The price is the participants' side and is named
   * rather than hidden: their half-filled form is gone, and they start again.
   */
  async byDraftToken(token: string): Promise<ResponseDraft> {
    const { draft, form, definition, liveDefinition } =
      await this.loadDraft(token);
    const settings = this.draftableSettings(form);

    /*
     * The seat state a **draft** sees.
     *
     * The snapshot decides which positions exist (`snapshotEventSeats`, the
     * event-snapshot review): this route is public, sessionless and past the access
     * word, so building the list from the live definition would tell whoever
     * holds an old address about Veranstaltungen published after they started —
     * on a protected form, about content behind the gate. The live definition
     * decides the Obergrenze, because that is an operating limit an organisation changes
     * without republishing.
     *
     * **Nothing is subtracted here, unlike on the edit route.** There the
     * answer's own seats come off the sum because it already holds them; a draft
     * holds none — that is what makes it a draft — so the number it sees is the
     * number any newcomer sees. It is a display either way: the binding answer
     * is the transaction that runs when the draft is submitted.
     */
    const taken = await this.takenIfBounded(
      form.id,
      form.tenantId,
      liveDefinition,
    );
    const storedAnswers = storedAnswersSchema.parse(draft.answers);

    return {
      form: {
        locked: false,
        title: form.title,
        version: draft.formVersion.version,
        tenant: tenantOf(form.tenant),
        definition,
        display: {
          showProgress: settings.showProgress,
          showPageNumbers: settings.showPageNumbers,
          showRequiredHint: settings.showRequiredHint,
        },
        availability: publicAvailability(
          availabilityOf({ settings, now: new Date(), responseCount: null }),
        ),
        eventSeats: snapshotEventSeats(definition, liveDefinition, taken),
        // A fresh attempt, so a fresh start token — which is also what
        // makes a form with both a time limit and Zwischenspeichern coherent:
        // the limit measures from the moment somebody comes back, not from the
        // sitting they broke off.
        startToken: this.startTokens.issue(form.publicSlug),
        // The time limit — and on this route it is the one that would otherwise
        // surprise somebody hardest. A resumed draft mints a fresh token one
        // line up, so the minutes run from *coming back*: whoever left a form
        // half-filled a week ago and now has fifteen minutes for the rest has
        // to be told so before they start typing again, not by the 409 that
        // ends it. `draftableSettings` is the strict path; the ternary is
        // `bySlug`'s.
        timeLimitMin: settings.timeLimitEnabled ? settings.timeLimitMin : null,
        // `true` by construction rather than by reading the setting again:
        // `draftableSettings` above has already refused this request if the
        // switch is off, so reaching this line *is* the answer.
        canSaveDraft: true,
        // The privacy notice of this form — **in the resumed draft too**.
        // Here somebody is typing on right now, so this is exactly the
        // point in time of the collection.
        privacyNotice: privacyNoticeOf(form, settings),
      },
      // As stored. They were validated against this very version on the way in
      // and are handed back untouched, for the reason `byEditToken` gives:
      // re-validating here would make a draft unopenable the day its snapshot's
      // rules get stricter. Parsed only for the one thing the wire type claims —
      // that this is a JSON object rather than an array, a number or `null`.
      answers: storedAnswers,
      // **And whether the attachments these answers name still exist**
      // (a review finding) — see
      // {@link resolveDraftAttachments}. Without this key the
      // payload hands out a reference that the submission refuses, and the
      // view shows it as „angehängt" for thirty days.
      attachments: await this.resolveDraftAttachments(
        form,
        draft,
        definition,
        storedAnswers,
      ),
      savedAt: draft.updatedAt.toISOString(),
      expiresAt: draft.expiresAt.toISOString(),
      // the evidence — **the address the submission goes to.**
      //
      // Without it a resumed draft is a form that can be read and written but
      // not *sent*: the submission route is keyed on the form's public slug,
      // and this token names the draft, not the form. It is not a hint the
      // client could derive — the slug is deliberately unrelated to any id it
      // holds — so leaving it out would mean the one action the whole
      // feature exists for is the one the resumed view cannot offer.
      //
      // It gives nothing away that the token does not already give: whoever
      // opens this draft is being handed the form's full field definition two
      // keys above, and the slug is what they used to get here in the first
      // place.
      formSlug: form.publicSlug,
    };
  }

  /**
   * Replaces the answers of an existing draft — **`PUT`, because it is a
   * replacement of one existing thing**, exactly as the edit route is.
   *
   * The chain is {@link byDraftToken}'s: a page that renders and then refuses to
   * save is worse than one that says no at the top, so the read and the write
   * ask the same {@link draftableSettings}.
   *
   * **The expiry is recomputed and not extended by hand.** Somebody who comes
   * back on day 29 and types another line gets thirty days from *then* — the
   * draft is being used, which is the whole thing the retention is measuring —
   * and a form that has since been given a deadline gets the deadline instead. One
   * function decides it in both places (`draftExpiresAt`), so „wie lange lebt
   * ein Entwurf" cannot mean one thing at the first save and another at the
   * second.
   *
   * Two writes with the same token racing each other are last-write-wins, with
   * no lock and deliberately so: the token names one participant's own draft, so
   * the two writers are the same person on two devices — the same reasoning
   * {@link updateByEditToken} states.
   */
  async updateDraft(
    token: string,
    answers: Record<string, unknown>,
  ): Promise<SavedDraft> {
    const { draft, form, definition } = await this.loadDraft(token);
    const settings = this.draftableSettings(form);

    const parsed = this.parseDraft(definition, answers);
    const stored = toStoredAnswers(parsed);
    const expiresAt = draftExpiresAt(settings, this.mailClock.now());

    // One transaction over the write and the claim, for the reason
    // {@link saveDraft} gives: „diese Antworten" and „diese Anlagen" are one
    // statement, and a half-written one is exactly the imposition that Konzept
    // no. 82 removes.
    const written = await this.prisma.$transaction(async (tx) => {
      const rewritten = await tx.responseDraft.updateMany({
        // `tenant_id` in the `where` beside the id although the id is unique
        // (`CONTRIBUTING.md`) — it comes from the row the token resolved to, never
        // from the caller. `updateMany` rather than `update` is what lets a
        // count of zero be an answer instead of an exception: a draft that was
        // revoked or submitted between the read a moment ago and this write is
        // **gone**, and „gone" is the one 404 every other absence answers with.
        where: { id: draft.id, tenantId: form.tenantId },
        data: { answers: stored, expiresAt },
      });
      if (rewritten.count === 0) {
        return false;
      }
      /*
       * **What this version names belongs to the draft from now on; what it no
       * longer names does not belong to it any more** (a security review).
       *
       * The third case that the concept expressly left open — an attachment
       * that somebody removes from a *draft* again — is thereby decided
       * and falls under the same 24-hour purge as the one a correction takes
       * out of an answer. Without the release the draft path was a
       * retention amplifier: the waiting room of ADR-0014 no. 7 refills
       * every 48 hours (25 MiB, 20 files per address ⊕ form), a
       * draft lives thirty days, and repeated `PUT` put fifteen
       * fillings into **one** draft — 375 MiB and 300 files per address
       * and form.
       *
       * The order is the answer path's and for the same reason:
       * `keep` is afterwards exactly the set this version names.
       */
      const named = attachmentsIn(definition, parsed);
      await claimForDraft(tx, {
        files: named,
        formId: form.id,
        tenantId: form.tenantId,
        draftId: draft.id,
        now: new Date(),
      });
      await releaseDraftAttachments(tx, {
        draftId: draft.id,
        tenantId: form.tenantId,
        keep: named.map((file) => file.ref),
      });
      return true;
    }, PUBLIC_DRAFT_TRANSACTION_BOUNDS);
    if (!written) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    return {
      draftUrl: await this.draftUrlOrNull(form.tenantId, draft.token),
      expiresAt: expiresAt.toISOString(),
      // The token this write was addressed with, echoed rather than minted: a
      // `PUT` replaces one draft and never moves it to a new address.
      token: draft.token,
    };
  }

  /**
   * **The draft is deleted at the data subject's request** (DSGVO Art. 17).
   *
   * Until this route existed there was **no way out**: the person a draft
   * belongs to has no account, sees no trash and reaches no editor.
   * The most they could do was `PUT` an empty answer set — which leaves the row
   * standing with its `tenant_id`, its form reference and its timestamps, i.e.
   * the record „diese Adresse hat am 5. August dieses Formular angefangen",
   * until the retention runs out. „Endgültiges Löschen ist physisches Löschen"
   * (`CONTRIBUTING.md`) has to be reachable by the one person it is about.
   *
   * **The token is the authorisation**, the same argument {@link byDraftToken}
   * and {@link updateDraft} make: whoever holds it can already read and rewrite
   * this draft, so being able to destroy it grants nothing new. Nothing else is
   * asked for and nothing else is answered — a token that names nothing, an
   * expired one and one whose form is gone all get the one 404.
   *
   * ⚠️ **{@link draftGate} is deliberately *not* asked here**, and it is the one
   * draft route that skips it. A form whose *Zwischenspeichern* was switched off
   * yesterday, or whose deadline has passed, still holds this person's data — and
   * answering „dieses Formular lässt sich nicht zwischenspeichern" to somebody
   * asking for their own data to be deleted would make the setting a lock on the
   * exit. Reading and writing are what the switch governs; leaving is not.
   *
   * ⚠️ **For the *attachments* of this draft this method causes only the
   * first of two events** (since then — the same paragraph that `retention-purge.service.ts` carries, and it belongs here because the
   * sentence above promises too much without it). `file.draft_id` is
   * `ON DELETE SET NULL`: the `DELETE` takes the attachment's owner away and
   * thereby puts it into the predicate of the file purge (ADR-0014 no. 15) — the
   * deadline runs from `created_at`, so the bytes go on the next run, with
   * an upper bound of around 24 hours plus one cadence. „Endgültiges
   * Löschen ist physisches Löschen" stays true and is redeemed for the row of this
   * draft **here**; for its bytes one purge round later. Art. 17
   * requires „unverzüglich", not „synchron" — and a `remove()` in this
   * transaction would mean that a slow storage drags the data subject's deletion
   * down with it.
   *
   * `deleteMany` with the tenant beside the id, for the reason
   * {@link updateDraft} gives: the id comes from the row the token resolved to,
   * and a count of zero is an answer rather than an exception — the draft was
   * already gone, which is exactly what the caller asked for.
   */
  async deleteDraft(token: string): Promise<void> {
    const { draft, form } = await this.loadDraft(token);
    await this.prisma.responseDraft.deleteMany({
      where: { id: draft.id, tenantId: form.tenantId },
    });
  }

  /**
   * The two state checks both draft routes make — **read on every access**
   * (the rule states for `allowEdit`).
   *
   * Separate from {@link draftableSettings} because {@link saveDraft} has to put
   * the password gate in front of them and therefore needs the settings first.
   * One body all the same, so the save and the resume cannot answer differently.
   *
   * `responseCount: null` — „ich weiß es nicht", the documented way to ask about
   * the window alone. A draft must **never** be refused with `limit_reached`: it
   * takes no place, so a form that filled up would otherwise stop somebody from
   * saving work they are about to lose.
   *
   * **`new Date()` here, `MailClock` for the retention, and the split is the
   * one this file already makes.** The deadline is the *participant's* time,
   * judged against the server's wall clock like every other link of the refusal
   * chain (see the note at the `MailClock` constructor argument); the thirty days
   * of the concept are a *retention*, the same question the trash purge asks,
   * and they read the injected calendar. In production the two are one clock; a
   * suite that moves the retention forward deliberately does not thereby reopen
   * or close a registration.
   */
  private draftGate(settings: FormSettings): void {
    if (!settings.allowSaveDraft) {
      throw refusal('saving_disabled');
    }
    const state = availabilityOf({
      settings,
      now: new Date(),
      responseCount: null,
    }).state;
    if (state !== 'open') {
      throw refusal(state);
    }
  }

  /** {@link draftGate} for the two token-borne routes, settings included. */
  private draftableSettings(form: {
    id: string;
    settingsOverride: Prisma.JsonValue;
    tenant: { id: string; formDefaults: Prisma.JsonValue };
  }): FormSettings {
    const settings = this.settingsForEnforcement(form);
    this.draftGate(settings);
    return settings;
  }

  /**
   * **Which attachments of this draft still exist** (a review finding,
   * ADR-0014 no. 13 and no. 15).
   *
   * ## The finding
   *
   * An attachment in a draft was an *unclaimed* file and was taken after
   * 24 hours; the draft lives up to thirty days. The stored
   * answer carries `{ref, name}` on unchanged, so the read door handed the
   * reference out as if nothing had happened — and the submission
   * answered `409 attachment_unavailable`. The upload door from `45a1300`
   * did not make this state rarer, but **arbitrarily repeatable**:
   * upload → `PUT` → file ages → `GET` still says „angehängt".
   * *Measured on 2026-08-05*, and the case stands as `draft.spec.ts`.
   *
   * ## What has changed since
   *
   * **The cause is gone, this resolution stays** : an attachment
   * that hangs on a draft belongs to it now (`file.draft_id`) and lives
   * as long as it does. The reported instant of an own attachment is therefore
   * the deadline **of the draft** and no longer „hochgeladen + 24 Stunden".
   *
   * The function does not become superfluous through that, because „tot" still has
   * causes the draft does not know: a reference the claim never
   * accepted (foreign organization, foreign form, name does not match, file
   * had already expired at saving time), a row from the time before the
   * column, and a file that meanwhile belongs to somebody else.
   *
   * ## Why exactly the conditions of the claim
   *
   * This query says **one** thing: „würde der Anspruch diesen Verweis jetzt
   * annehmen". That is why its `WHERE` holds the same as the `UPDATE` of
   * {@link claimAttachments} — organization, form, `kind`, no foreign answer —
   * and the two deadlines are afterwards distinguished exactly as there: the
   * attachment of **this** draft by its own deadline, the ownerless one by
   * the same 24-hour constant. A weaker query would be a second
   * opinion about „lebt der Anhang", and the one that drifts is never
   * the one that decides.
   *
   * **And it is therefore no oracle either.** A guessed reference to the file
   * of another organization or of another form falls through the same
   * conditions as at the claim and reads as „tot" — byte-identical to
   * a reference that never existed. Within *this* form the
   * reference stays 16 bytes out of a CSPRNG (no. 9), and whoever has it already
   * holds the draft that names it anyway.
   *
   * The name is checked along with it, because the claim checks it (`file_name` against
   * the name in the answer): without this comparison the read door said „lebt"
   * about a reference the submission refuses — that is, the dead end again,
   * one condition further along.
   *
   * ## What it costs
   *
   * **Nothing for the great majority of drafts**: without a file answer
   * `named` is empty and no query goes out. Otherwise exactly **one** query
   * over the unique index on `public_ref`, independent of the number of
   * references. Named in `docs/kb/07-oeffentliche-pfade.md`, as the rule
   * „neue Datenbankarbeit je Lesezugriff wird benannt" demands.
   *
   * `new Date()` and not `MailClock`: these are the same 24 hours that the
   * claim and the purge measure on `file.created_at` — the wall clock, not the
   * injected calendar on which the *retention* of the draft hangs. The
   * instant of an own attachment comes by contrast from `draft.expires_at`, that is from
   * exactly the calendar that wrote it.
   */
  private async resolveDraftAttachments(
    form: { id: string; tenantId: string },
    draft: { id: string; expiresAt: Date },
    definition: FormDefinition,
    answers: Record<string, unknown>,
  ): Promise<DraftAttachment[]> {
    const named = attachmentsIn(definition, answers);
    if (named.length === 0) {
      return [];
    }

    const rows = await this.prisma.file.findMany({
      where: {
        publicRef: { in: refsOf(named) },
        // Tenant scope in the query, not in a filter afterwards (`CONTRIBUTING.md`) —
        // and here additionally condition 2 of the claim, the only one that
        // carries the organization boundary.
        tenantId: form.tenantId,
        formId: form.id,
        kind: 'response_attachment',
        // **To no foreign answer**: a claimed file is as dead for this
        // draft as a deleted one, and the claim refuses it just the
        // same.
        responseId: null,
      },
      select: {
        publicRef: true,
        fileName: true,
        byteSize: true,
        createdAt: true,
        draftId: true,
      },
    });
    const byRef = new Map(rows.map((row) => [row.publicRef, row]));
    const now = Date.now();

    return named.map((attachment) => {
      const row = byRef.get(attachment.ref);
      // `== null` catches two cases in one here, and both are the same
      // answer: no row (the conditions above sorted it out) and
      // a row without a known size — the `pending` row from the
      // crash window of no. 4, which the claim likewise refuses, because
      // „wir wissen es nicht" must not count as „liegt bereit".
      if (row?.byteSize == null || row.fileName !== attachment.name) {
        return { ref: attachment.ref, expiresAt: null };
      }
      // **An own attachment lives as long as this draft**  —
      // and `draft.expiresAt` is exactly the instant at which it dies: the
      // draft purge deletes the row, `draft_id` falls to `NULL`, and the
      // file is thereby what the purge of ADR-0014 no. 15 takes. An
      // instant instead of „noch 3 Tage", for the reason
      // `draftAttachmentSchema` names.
      if (row.draftId === draft.id) {
        return {
          ref: attachment.ref,
          expiresAt: draft.expiresAt.toISOString(),
        };
      }
      // **And the rest is the old case, which has not disappeared**: a
      // file that belongs to nobody lives 24 hours from the upload. Here
      // arrives what this draft's claim did not take — a row
      // from the time before the owner column, or one that belongs to **another**
      // draft (`draft_id` set, but not to this one: the expression
      // below is then false, and the reference reads as dead, byte-identical
      // to one that never existed).
      const expiresAt = row.createdAt.getTime() + UNCLAIMED_FILE_LIFETIME_MS;
      return {
        ref: attachment.ref,
        expiresAt:
          row.draftId === null && expiresAt > now
            ? new Date(expiresAt).toISOString()
            : null,
      };
    });
  }

  /**
   * The answers of a draft, validated **without the Pflicht rule** — and with
   * everything else.
   *
   * One place rather than two identical blocks in {@link saveDraft} and
   * {@link updateDraft}: „was darf in einem Entwurf stehen" is one rule, and the
   * 400 it produces is the same body the submission's produces — the issue list
   * travels because it is about the sender's own input and carries nothing they
   * did not write.
   */
  private parseDraft(
    definition: FormDefinition,
    answers: Record<string, unknown>,
  ): AnswerMap {
    const parsed = safeParseDraftAnswers(definition, answers);
    if (!parsed.success) {
      throw new BadRequestException(
        validationProblem(
          'Bitte die markierten Felder prüfen.',
          parsed.error.issues,
        ),
      );
    }
    return parsed.data;
  }

  /**
   * Resolves a draft token to its row, its form and the parsed snapshot — or
   * raises the **one** 404 of the public routes.
   *
   * The single `throw` site is the point, exactly as in {@link loadForEdit}: a
   * malformed token, an unknown one, an **expired** one, one whose form is
   * unpublished, in the trash or in a deleted Organisation, and one whose snapshot
   * no longer parses are one answer, byte for byte. Two throw sites are two
   * bodies that can drift into an oracle about which drafts exist.
   *
   * **The expiry is a condition of the query, not a purge's business alone**
   * . A retention enforced only by a background job is a retention
   * that is wrong for as long as the job is late — and this is the direction
   * where being late means handing out somebody's personal data past the day it
   * was promised to disappear. The purge frees the space; this line decides what
   * can still be opened.
   *
   * All five conditions are in the **same statement** rather than in `if`s after
   * it, for the reason the query-conditions review wrote down at {@link load}: a refused row
   * must not cost the relation queries an invented token never costs, or „gibt
   * es nicht" and „ist abgelaufen" are distinguishable from outside without
   * reading a byte of the body.
   */
  private async loadDraft(token: string) {
    if (!isDraftToken(token)) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const draft = await this.prisma.responseDraft.findFirst({
      where: {
        token,
        // The same injected calendar the boundary was written from — two clocks
        // over one retention is how „abgelaufen" comes to mean two things.
        expiresAt: { gt: this.mailClock.now() },
        form: {
          deletedAt: null,
          status: 'active',
          tenant: { deletedAt: null },
        },
      },
      include: {
        formVersion: true,
        form: {
          include: {
            tenant: { include: OWNED_LOGO_INCLUDE },
            publishedVersion: true,
          },
        },
      },
    });

    if (draft === null) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const definition = formDefinitionSchema.safeParse(draft.formVersion.schema);
    if (!definition.success) {
      this.logger.error(
        `Snapshot ${draft.formVersionId} behind a draft token does not parse; answering 404.`,
      );
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    /*
     * The **live** definition, or the snapshot where the form has no published
     * version to read — the same fallback {@link loadForEdit} carries, and
     * unreachable for the same reason: a form that is not `active` has already
     * answered 404 above. „Die Grenze von heute" degrading to „die Grenze von
     * damals" can only refuse, never admit.
     */
    const live = formDefinitionSchema.safeParse(
      draft.form.publishedVersion?.schema,
    );

    return {
      draft,
      form: draft.form,
      definition: definition.data,
      liveDefinition: live.success ? live.data : definition.data,
    };
  }

  /**
   * {@link loadDraft} for the **upload door** — the same five conditions,
   * only what the door really needs (a review finding of a
   * security review).
   *
   * The five conditions are those of {@link loadDraft}, one for one: the
   * token itself, the draft's deadline on the same injected clock, the
   * form not in the trash, the form `active`, the organization not
   * deleted. They stand in **one** statement, for the reason
   * {@link loadDraft} names: a refused row must not cost the
   * relation queries that an invented token never costs.
   *
   * What is **not** read is the snapshot (two `safeParse`), the
   * live version, the organization's logo files and the version — none of that
   * decides whether this door accepts bytes. The consequence of this one
   * omission is named at {@link openForUploadByDraftToken}.
   *
   * What is delivered is the shape {@link draftableSettings} demands, so that
   * the calculation „Organisation-Standard ↔ Formular-Override" is the same here as at
   * the two neighbouring routes.
   */
  private async loadDraftForUpload(token: string): Promise<{
    id: string;
    tenantId: string;
    settingsOverride: Prisma.JsonValue;
    tenant: { id: string; formDefaults: Prisma.JsonValue };
  }> {
    if (!isDraftToken(token)) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const draft = await this.prisma.responseDraft.findFirst({
      where: {
        token,
        expiresAt: { gt: this.mailClock.now() },
        form: {
          deletedAt: null,
          status: 'active',
          tenant: { deletedAt: null },
        },
      },
      select: {
        form: {
          select: {
            id: true,
            tenantId: true,
            settingsOverride: true,
            tenant: { select: { id: true, formDefaults: true } },
          },
        },
      },
    });

    if (draft === null) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }
    return draft.form;
  }

  /**
   * The address of a draft that is **already stored** — defensive in exactly the
   * way {@link editUrlOrNull} is, and for the same reason.
   *
   * `PublicUrlService.responseDraftUrl` is a database read (an organisation's own
   * address, then the installation's), and it is called after the row has been
   * written. Letting it throw would answer 500 for a draft that exists, which a
   * participant reads as „hat nicht geklappt" and repeats — producing a second
   * draft with the same content and the first one unreachable.
   *
   * `null` is a real answer and the payload carries it: an installation that has
   * told nobody its base address cannot build a link, and a guessed one is the
   * single thing that must not leave the server. What that costs is
   * named at {@link savedDraftSchema}: the draft is stored and the participant
   * cannot reach it. Refusing instead would lose their typing as well, so it is
   * the smaller of two bad answers rather than a good one.
   */
  private async draftUrlOrNull(
    tenantId: string,
    token: string,
  ): Promise<string | null> {
    try {
      return await this.publicUrls.responseDraftUrl(tenantId, token);
    } catch (error: unknown) {
      this.logger.error(
        `Building the draft link for tenant ${tenantId} failed after the ` +
          'draft was already stored; answering without one rather than ' +
          'failing the request.',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /**
   * Resolves an edit token to its answer, its form and the parsed snapshot — or
   * raises the **one** 404 of the public routes.
   *
   * The single `throw` site is the point, exactly as in {@link unlock}: five
   * different ways of being absent (malformed token, unknown token, deleted
   * answer, deleted or unpublished form, unparseable snapshot) have to be one
   * answer, and two throw sites are two bodies that can drift into an oracle.
   */
  private async loadForEdit(token: string) {
    if (!isEditToken(token)) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const response = await this.prisma.response.findUnique({
      where: { editToken: token },
      include: {
        formVersion: true,
        // The tenant comes from the resolved row, never from the caller — the
        // same rule every other query on this path follows.
        //
        // `publishedVersion` alongside the snapshot, because the two answer
        // different questions: the snapshot says what this answer was asked,
        // the published version says what the organisation's limits are **today**
        // (`withLiveCapacity`, from the capacity-lock review).
        form: {
          include: {
            tenant: { include: OWNED_LOGO_INCLUDE },
            publishedVersion: true,
          },
        },
      },
    });

    if (
      response?.deletedAt != null ||
      response?.form.deletedAt != null ||
      // Filter 5 on the edit link as well: a Bearbeiten-Adresse handed out
      // before the organisation was deleted must stop leading anywhere, or the one
      // route that shows a participant their own submitted answers would
      // outlive the organisation it belongs to. In the `if` and not in the `where`
      // because this method already refuses that way — five states through one
      // door, and a sixth condition split across two shapes would be the drift
      // the single `throw` site exists to prevent.
      response?.form.tenant.deletedAt != null ||
      response?.form.status !== 'active'
    ) {
      // Covers the unknown token as well: `undefined !== 'active'`. Written in
      // the shape `load()` uses a few methods down, so the two „gibt es nicht"
      // checks of this file read alike.
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    const definition = formDefinitionSchema.safeParse(
      response.formVersion.schema,
    );
    if (!definition.success) {
      this.logger.error(
        `Snapshot ${response.formVersionId} behind an edit token does not parse; answering 404.`,
      );
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    /*
     * The **live** definition, or the snapshot when the form has no published
     * version to read. The fallback is unreachable today — `loadForEdit` has
     * already refused a form that is not `active` — and it is written as one
     * rather than as a `throw` because „die Grenze von heute" degrading to
     * „die Grenze von damals" is the safe direction: it can only refuse, never
     * admit.
     */
    const live = formDefinitionSchema.safeParse(
      response.form.publishedVersion?.schema,
    );

    return {
      response,
      form: response.form,
      definition: definition.data,
      liveDefinition: live.success ? live.data : definition.data,
    };
  }

  /**
   * The settings that govern an edit — read **strictly**, then asked the two
   * questions (`allowEdit`, then the deadline).
   *
   * One method for both routes so the read and the write cannot answer
   * differently: a page that renders and then refuses to save is worse than one
   * that says no at the top.
   */
  private editableSettings(form: {
    id: string;
    settingsOverride: Prisma.JsonValue;
    tenant: { id: string; formDefaults: Prisma.JsonValue };
  }): FormSettings {
    const settings = this.settingsForEnforcement(form);

    // Evaluated on **every** access, which is the whole of the third bullet.
    if (!settings.allowEdit) {
      throw refusal('editing_disabled');
    }

    // `responseCount: null` — „ich weiß es nicht", the documented way to ask
    // about the window alone. An edit must never be refused with
    // `limit_reached`: the seat is already taken by this very answer.
    const state = availabilityOf({
      settings,
      now: new Date(),
      responseCount: null,
    }).state;
    if (state !== 'open') {
      throw refusal(state);
    }

    return settings;
  }

  /**
   * The effective settings, **fail closed** .
   *
   * The counterpart of `settingsOf` above and deliberately not a variant of it:
   * that one degrades an unreadable document to the shipped defaults so a
   * rolling deploy cannot 500 a whole organisation's fill-in pages, this one refuses.
   * „Unreadable" must never be allowed to mean „no deadline, no limit" on a
   * path that decides whether an answer is accepted — that would open a closed
   * form the moment a document stopped parsing. The two readings are different
   * on purpose and are written as different code
   * (`settings/settings-enforcement.ts`).
   */
  private settingsForEnforcement(form: {
    id: string;
    settingsOverride: Prisma.JsonValue;
    tenant: { id: string; formDefaults: Prisma.JsonValue };
  }): FormSettings {
    try {
      return enforcedSettings(form);
    } catch (cause) {
      // **Not dead code, and it used to be.** While `enforcedSettings` caught
      // bare, every exception left it as an `UnreadableSettingsError` — a
      // `TypeError` from a bug in the merge included, answered with a 503 that
      // promises the state resolves itself. It narrows to Zod errors now, so a
      // programming error travels through here to the 500 path and is loud.
      if (!(cause instanceof UnreadableSettingsError)) {
        throw cause;
      }
      // The *reason* goes into the log, where the ids belong; the participant
      // learns only that this form is not taking answers right now. Once per
      // document, like the display path — the submit route allows 30 requests
      // a minute per address, and the reason does not change between them.
      this.reportOnce(
        `${cause.message}; refusing the submission (fail closed).`,
      );
      throw new ServiceUnavailableException(UNREADABLE_SETTINGS_MESSAGE);
    }
  }

  /**
   * Whether this attempt started recently enough.
   *
   * A missing token, a forged one, one minted for another form and one that is
   * simply too old all answer `false` — see `start-token.service.ts` for why
   * they must not be told apart.
   *
   * **A token from the near future is accepted, one from the far future is
   * not.** It can only carry this server's own signature, so the only way to
   * hold one is a clock that moved — and punishing a participant for the
   * server's clock would be the wrong end of the problem. But „negative age
   * always passes" is not the same statement: with two replicas whose clocks
   * have drifted, A issues and B receives, and the time limit is then silently
   * not enforced for that attempt, however long it takes. {@link
   * CLOCK_SKEW_GRACE_MS} is generous against real drift (NTP-synchronised hosts
   * are seconds apart, not minutes) and finite, so the setting keeps meaning
   * something.
   */
  private startedInTime(
    slug: string,
    settings: FormSettings,
    startToken: string | undefined,
    now: Date,
  ): boolean {
    if (startToken === undefined) {
      return false;
    }
    const issuedAt = this.startTokens.issuedAt(startToken, slug);
    if (issuedAt === null) {
      return false;
    }
    const elapsedMs = now.getTime() - issuedAt.getTime();
    if (elapsedMs < -CLOCK_SKEW_GRACE_MS) {
      return false;
    }
    return elapsedMs <= settings.timeLimitMin * MINUTE_MS;
  }

  /**
   * Writes the answer unless the form is full, and queues what it sets off —
   * **as one decision** (the requirements).
   *
   * `count()` and then `create()` is the naive shape, and it passes a
   * sequential test and loses a concurrent one: twenty people pressing
   * „Absenden" within the same second all read the same nine and all insert.
   * the concept expects exactly that burst at a registration start.
   *
   * What makes it one decision is the row lock on the form. `SELECT … FOR
   * UPDATE` inside the transaction serialises the submissions **of this one
   * form**; every waiter re-reads afterwards under READ COMMITTED and therefore
   * counts the rows the previous one committed. It is a lock per form, not per
   * installation, so a busy Jahrestagung registration never queues behind
   * another organisation's — and the row it takes is the form itself, which is the
   * thing the limit belongs to.
   *
   * **The lock is only taken when a limit is configured.** A form without one
   * — nearly all of them — inserts without any lock at all, so the cost lands
   * on the setting that asks for it.
   *
   * **The transaction, unlike the lock, is unconditional now** .
   * Until this, a form without a limit wrote a single row and needed no
   * `BEGIN`; a submission can now write several, and „they commit together" is
   * a promise that cannot be conditional on a setting nobody was thinking about
   * when they wrote a notification. The price is one round trip per submission
   * on a form that has neither a limit nor a notification, against the
   * alternative of an answer and its confirmation being able to come apart.
   *
   * **Two limits share that one lock now** . The
   * participant limit of a Veranstaltung is counted the same way — lock, sum,
   * decide, write — and it is taken **once** at the top of the transaction
   * rather than once per limit: two lock objects on one write path would be two
   * lock orders, and a form that has both an Antwortlimit and a Veranstaltung
   * would deadlock the first time two people submitted at the same second. The
   * condition therefore reads „either limit is in play", and a form with neither
   * still inserts without a lock at all.
   *
   * Answers with a {@link StoreOutcome}: the row's **edit token** ,
   * or the refusal that stopped it. The token is minted **in the same statement
   * that writes the
   * answer** — not afterwards in a second write — which is what the implementation plan
   * asks for (the concept: „das Token entsteht in derselben Transaktion wie die
   * Antwort"): a follow-up `UPDATE` could fail between the two and leave a
   * stored registration whose confirmation promised a link that does not exist.
   *
   * It is minted for **every** answer, including one to a form with `allowEdit`
   * off. Two reasons: the setting is evaluated on every access rather than at
   * issuing time, so a form switched to „Bearbeiten erlaubt" next week must
   * not leave this week's registrations without a link; and a column that is
   * conditionally filled invites the question „why is this one null?" for the
   * rest of the schema's life. Whether the participant is *shown* the link is
   * `confirmationOf`'s decision, in one place.
   */
  private async storeWithinLimit(
    form: {
      id: string;
      tenantId: string;
      title: string;
      tenant: { name: string; replyTo: string | null };
    },
    formVersionId: string,
    settings: FormSettings,
    answers: AnswerMap,
    mail: {
      /** The snapshot the answer was validated against — never the draft. */
      readonly definition: FormDefinition;
      readonly notifications: readonly SubmissionNotification[];
      /** The verdict of {@link isHoneypotFilled} . */
      readonly honeypotFilled: boolean;
    },
    /** The draft this submission comes out of, if any. */
    draftToken?: string,
  ): Promise<StoreOutcome> {
    // Read **once**, before the transaction: the same list is claimed inside it
    // (ADR-0014 no. 13) and released from the upload quota after it commits
    // (no. 7) — two walks over one answer could only disagree.
    const attachments = attachmentsIn(mail.definition, answers);

    /*
     * The two lower levels of the `Reply-To` chain, read **before** the
     * transaction: it is an additional query on the
     * system row, and it has no business standing beside this transaction's
     * form lock — the same consideration for which `mailAllowance` runs before
     * the `BEGIN`. The notification's level comes from the row that
     * was read anyway.
     */
    const replyToDefaults = await this.replyToDefaults(form);

    /*
     * The seats this submission asks for, read **once** and from the shared
     * reader. The same list decides three things — whether the
     * lock is needed, whether the Obergrenze holds, and what goes into
     * `event_registration` — so a second walk could only produce a fourth
     * opinion about what „3 Personen zum Konzert" means.
     *
     * `bounded` is the subset that stands under an Obergrenze. „Ohne Grenze" is
     * a real answer and costs nothing: those seats are recorded but
     * never counted against anything.
     */
    const seats = seatRequests(mail.definition, answers);
    const bounded = boundedRequests(seats);

    /*
     * **the requirements, decided *before* the `BEGIN`** — the placement is
     * a review finding and it is the whole of that fix.
     *
     * The count used to run inside the transaction, behind the `FOR UPDATE` of
     * the answer limit. Anything that made it throw — a statement timeout, an
     * exhausted pool, the 20-second transaction budget below — rolled back the
     * `response` row that had already been written, i.e. produced the lost
     * registration this measure exists to prevent. There is no catching that
     * afterwards: once a statement in a transaction fails, the transaction is
     * aborted and the answer is gone with it.
     *
     * Reading it a moment early costs a slightly stale number, and that is
     * affordable **because the limit is a soft one**: submissions that overlap
     * could already each read a count the others had not committed yet, and
     * this widens that same window by the duration of one transaction rather
     * than opening a new kind of hole. It does cost the parallel proof its old
     * bound — „höchstens `DB_POOL_MAX - 1` zu viel" was derived from the count
     * sitting *inside* the transaction and is simply not true any more; what
     * replaced it is a second wave that must be capped in full
     * (`test/public/mail-budget.spec.ts`, `BURST`).
     *
     * `queuedAt` is taken here too, so the window's near edge and the
     * `created_at` of the rows it will later count are literally one instant.
     */
    const queuedAt = this.mailClock.now();
    const budget =
      // Nothing to cap, so nothing to count (a review finding): a form without
      // a notification queues no row whatever the budget says, and paying an
      // aggregate query per submission to learn that is a cost every such form
      // carries for nothing. The edit path takes the same shortcut, one step
      // further down, where it also knows that *this* edit changed something.
      mail.notifications.length === 0
        ? null
        : await this.mailAllowance(
            form,
            settings,
            mail.honeypotFilled,
            queuedAt,
          );

    const editToken = mintEditToken();
    const data = {
      // From the resolved form, never from the request — the participant says
      // which form, and the form says which Organisation.
      tenantId: form.tenantId,
      formId: form.id,
      formVersionId,
      answers: toStoredAnswers(answers),
      editToken,
    };

    const outcome = await this.prisma.$transaction(
      async (tx): Promise<StoreOutcome> => {
        // **One lock for both limits, before either is counted** . See the note on this method for why it is taken
        // once rather than per limit.
        if (settings.maxResponsesEnabled || bounded.length > 0) {
          await lockForm(tx, form.id, form.tenantId);
        }

        if (settings.maxResponsesEnabled) {
          const taken = await tx.response.count({
            // Soft-deleted answers do not occupy a place: an organisation that moves a
            // duplicate registration to the trash has freed the seat,
            // and this is the same `where` the read path's verdict counts with.
            where: {
              formId: form.id,
              tenantId: form.tenantId,
              deletedAt: null,
            },
          });
          if (taken >= settings.maxResponses) {
            return { stored: false, reason: 'limit_reached' };
          }
        }

        /*
         * **The participant limit** (the concept).
         *
         * Lock (above), sum, decide — and all three **before** anything is
         * written. The order is the point, in both directions:
         *
         * - Moving this behind `tx.response.create` breaks the evidence —
         *   the third registration of 4 against an Obergrenze of 10 counts its
         *   own four seats and refuses itself, or counts them and lets 12 in,
         *   depending on which side of the write it lands.
         * - Moving it behind the `mail_log` rows further down breaks it further: a
         *   submission that hit the Obergrenze would then have queued the
         *   confirmation for a registration nobody has. The rollback would take
         *   the rows with it — but only for as long as nothing between here and
         *   the `COMMIT` ever sends, and „es rollt ja zurück" is not a property
         *   a queue keeps by itself.
         *
         * ⚠️ **This is that rule inverted, on purpose.** Budget and
         * Honeypot cap the *mail* and never let a registration fail; a
         * participant limit caps the *registration* — that is what makes it a
         * limit. `return` and not `throw`, unlike the attachment claim below:
         * nothing has been written yet, so there is nothing to abort, and a
         * returned verdict cannot be swallowed by a `catch` that was written for
         * something else.
         *
         * The refusal names the **position** and not the form: the
         * rest of this registration is still acceptable, and the participant is
         * told which number to change. Nothing of it is stored in the meantime —
         * „abgewiesen wird die Position" is a statement about what they may do
         * next, not a licence to file a registration they did not make.
         */
        if (bounded.length > 0) {
          const position = exhaustedPosition(
            bounded,
            await takenSeats(tx, form.id, form.tenantId),
          );
          if (position !== null) {
            return { stored: false, reason: 'event_full', position };
          }
        }

        /*
         * **The draft is gone afterwards — in the same transaction, and it is
         * the idempotency key of this submission**.
         *
         * Inside the `BEGIN` and not around it, and both halves of that are the
         * claim: a deletion that committed while the answer rolled back would
         * take somebody's half-filled form away for a submission that never
         * happened, and one that ran after the `COMMIT` would leave a draft
         * standing whose answers are already filed — the address still open,
         * still handing out the field definition, until the retention runs out.
         *
         * It sits **behind every refusal** for the same reason the enqueue does:
         * the transaction returns before reaching this line when the
         * Antwortlimit or a participant limit stops the submission, so a refused
         * participant still has their draft to correct and resend from.
         *
         * ## Why `count === 0` is a refusal
         *
         * „Das Absenden aus einem Entwurf erzeugt **eine** Antwort" is a promise
         * about the *address*, not about a click, and the count used to be
         * discarded on the ground that a missing draft is „einfach nicht da".
         * *Measured on 2026-08-05:* two simultaneous submissions of the same
         * token answered 200/200 and filed **two** answers, on a
         * Veranstaltung with `SUM(seats) = 6` instead of 3 — two tabs, a double
         * click, a retry after a connection breakdown: every one
         * of these everyday cases was a double registration.
         *
         * **The row lock is what serialises them**, and it needs nothing added
         * to do it: the second transaction blocks on the lock the first holds
         * until that one commits, and then matches **nothing**. So „nichts
         * getroffen" *behind a token that was offered* means „dieser Entwurf
         * ist gerade abgesendet worden" and is refused — before
         * `tx.response.create` below, so the second submission writes no row
         * rather than writing one and rolling it back. *(Previously the lock
         * came from the `DELETE` itself; it comes from the `SELECT … FOR
         * UPDATE` now, and both halves are argued at the statement.)*
         *
         * ⚠️ **It is a refusal of the submission and therefore visible.** A
         * draft that a settings write revoked, and a token that
         * never named anything, land in the same 409 although their sender did
         * nothing wrong. That is the lesser of the two errors — the old
         * behaviour ended with an organisation holding two registrations for one person
         * and no way to tell which was meant — but it is the reason the message
         * beside `draft_already_submitted` does **not** claim the registration
         * exists. A submission carrying **no** token is untouched by all of
         * this.
         *
         * **An *expired* draft is not one of these cases**, and the first
         * version of this comment said it was. There is no expiry predicate in
         * the statement below: the row is still there until the purge takes it,
         * so it matches, is consumed, and the submission goes through. That is
         * the right outcome — the participant is submitting *now*, and whether
         * *now* is still within the deadline is `availabilityOf`'s answer, given
         * above, not this token's.
         *
         * Scoped to **this form of this organisation**: `token` alone is unique, so the
         * two extra predicates cannot widen the statement — what they do is make
         * a token naming another form's draft match nothing instead of taking it
         * (`CONTRIBUTING.md`, and the one rule this whole service is built on: the
         * participant says which form, the form says which Organisation).
         */
        /*
         * **Split in two by now: locked here, deleted below** (the requirement).
         *
         * The reason is the transfer of the claim: the attachments of this draft
         * belong to **it**, and the claim further down needs its
         * id in order to take them over. A `DELETE` at this point would take
         * them away from it beforehand — `draft_id` is `ON DELETE SET NULL` —, and
         * a thirty-day-old attachment would thereby fall back into the
         * 24-hour condition: „Anhang abgelaufen" for a file the
         * participant is submitting right now.
         *
         * **The serialization does not change through that**, and that is the
         * point on which this rearrangement would stand or fall. It was the
         * `DELETE` that forced two simultaneous submissions of the same draft
         * one after the other; it is now this `SELECT … FOR UPDATE`, and
         * it does the same: the second transaction waits for the lock, and
         * when the first has committed, the row is gone — under
         * `READ COMMITTED` the lock then delivers **nothing**, and the
         * submission is refused **before** `tx.response.create` runs.
         * If the first rolls back, the second gets the draft and may proceed.
         *
         * Everything else holds unchanged: `token` alone is unique, so the
         * two additional conditions cannot widen the statement — what they do
         * is make a token that names the draft of *another* form
         * match nothing instead of deleting it.
         */
        let consumedDraftId: string | undefined;
        if (draftToken !== undefined) {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id"
              FROM "response_draft"
             WHERE "token"     = ${draftToken}
               AND "form_id"   = ${form.id}::uuid
               AND "tenant_id" = ${form.tenantId}::uuid
               FOR UPDATE`;
          consumedDraftId = rows[0]?.id;
          if (consumedDraftId === undefined) {
            return { stored: false, reason: 'draft_already_submitted' };
          }
        }

        const response = await tx.response.create({ data });

        // The seats, in the same transaction as the answer they belong to and
        // from the same list that was just measured. Written
        // after the answer because they carry its id, and unconditionally — an
        // event „ohne Grenze" is counted for the evaluation (the capacity rule)
        // even though nothing bounds it.
        await writeSeats(
          tx,
          {
            formId: form.id,
            tenantId: form.tenantId,
            responseId: response.id,
          },
          seats,
        );

        /*
         * **The attachments are claimed here — in this transaction, with five
         * conditions** (ADR-0014 no. 13).
         *
         * Inside the `BEGIN` and behind the answer, because the claim needs the
         * `response_id` that only exists once the row above is written, and
         * because a refusal has to take the answer with it: an answer that
         * committed while its attachment was claimed by somebody else would be
         * a registration with a proof that is not there.
         *
         * A refusal therefore **throws** rather than returning a verdict — that
         * is what aborts the transaction. It is caught by the caller and turned
         * into the two 409s of the refusal chain. And the per-answer limits of
         * no. 6 (ten files, 25 MiB) are enforced in there for the reason the ADR
         * gives: before this point there is no answer to measure them against.
         *
         * `attachmentsIn` found nothing until the `file` question type
         * existed. The wiring was here all the same, because the
         * alternative — „adding it later too" — is how a field ships whose
         * files nothing owns, and its exhaustive switch was a compile error the
         * day the type arrived.
         */
        await claimAttachments(tx, {
          files: attachments,
          formId: form.id,
          tenantId: form.tenantId,
          responseId: response.id,
          // **The transfer of the claim: draft → answer, in *this*
          // transaction** (the requirement). The id comes
          // from the row that was locked further up — never from the
          // request —, and the one `UPDATE` writes `response_id` and clears
          // `draft_id`. Were the transfer to lie *behind* this transaction,
          // a failed submission would already have released the file; were it to run
          // in one *of its own*, the takeover would survive a
          // rolled-back answer. For both shapes there is one test each
          // (`test/public/draft-attachment.spec.ts`).
          draftId: consumedDraftId,
          // **The database's own clock**, not a second one of ours: it is the
          // instant this answer was written, and `file.created_at` — the column
          // condition 5 compares it against — is written by that same clock.
          // Two clocks over one comparison is how „abgelaufen" comes to mean
          // two things, which is the whole worry of no. 13/no. 15. The purge of
          // the trash purge cuts on the same column and inherits the same requirement.
          now: response.submittedAt,
        });

        /*
         * **And only now is the draft gone** — after the transfer of the claim,
         * in the same transaction.
         *
         * The order is the statement: the attachments of this draft belong
         * to the answer by now, so the `SET NULL` of the
         * foreign key only finds what the participant **no longer** named on
         * submitting — and that is exactly right: an attachment that
         * carries no answer has no owner any more and goes with the
         * purge of ADR-0014 no. 15.
         *
         * The lock on the row has held since the `SELECT … FOR UPDATE` above,
         * so the idempotency hangs not on this statement but on that one.
         * `deleteMany` with the id from the locked row, and the organization
         * beside it, because every write of this file carries it along.
         */
        if (consumedDraftId !== undefined) {
          await tx.responseDraft.deleteMany({
            where: { id: consumedDraftId, tenantId: form.tenantId },
          });
        }

        /*
         * The requirement — **the enqueue is in the same transaction as the
         * answer, and that is the whole claim.**
         *
         * Both directions of it, which is why they are two statements and one
         * `BEGIN` rather than two calls: a mail that committed while the answer
         * rolled back would confirm a registration nobody has, and an answer
         * that committed while the enqueue failed would leave a participant
         * with a promise on screen and nothing in the mail log — the
         * second being the more expensive of the two, because nobody notices
         * it.
         *
         * The rows are built from `response`, so the date in the subject is the
         * answer's own `submitted_at` and cannot drift from the date the body
         * renders at send time.
         */
        const pending = submissionMails({
          trigger: 'submit',
          notifications: mail.notifications,
          replyToDefaults,
          context: mailContextOf({
            tenantName: form.tenant.name,
            formTitle: form.title,
            submittedAt: response.submittedAt,
            definition: mail.definition,
            answers,
            // A first submission changed nothing, so `{{aenderungen}}` renders
            // to nothing here — the same rule `{{bearbeiten}}` follows when
            // there is no link. Said explicitly because a notification may fire
            // on both triggers (the acceptance run): the *same* template can
            // reach this line and the edit path below.
            previousAnswers: null,
          }),
        });

        // Applied **behind the write, never in front of it** :
        // what the two measures change is the `status` of these rows, never
        // whether the answer above was stored. `capMails` is a pure function —
        // the query that fed it ran before the transaction, see `budget`.
        const rows =
          budget === null
            ? pending
            : capMails(pending, budget.allowance, budget.reason);

        if (rows.length > 0) {
          await tx.mailLog.createMany({
            data: rows.map((row) =>
              toMailLogRow(form, response.id, row, queuedAt),
            ),
          });
        }

        return { stored: true, editToken };
      },
      // Generous, because the point of the lock is that submissions *do* wait
      // for each other: with twenty arriving at once the last one waits for
      // nineteen short transactions. The defaults (2 s to start, 5 s to run)
      // would turn a successful queue into a spurious failure.
      { maxWait: 20_000, timeout: 20_000 },
    );

    // **After the commit, never inside it** (ADR-0014 no. 7): the quota is
    // process memory, and memory does not roll back. Releasing before the
    // `COMMIT` would hand the allowance back for a claim that a later statement
    // undid — the one direction of this bookkeeping that must not be wrong,
    // because it is the direction that *permits* writes. A release that never
    // happens costs the caller their waiting room for a day; one that happens
    // too early costs the volume.
    if (outcome.stored) {
      releaseUploads(refsOf(attachments));
    }
    return outcome;
  }

  /**
   * How many mails this submission may still queue, and under which reason the
   * rest is capped — the **one** place the requirements are decided.
   *
   * ## Where it sits, and why nowhere else
   *
   * **Outside the caller's transaction, in front of it** (a review finding).
   * It used to run inside, behind the answer's write and behind
   * the `FOR UPDATE` of the answer limit, and that was the one shape neither
   * allows: a `count` that throws — statement timeout, exhausted
   * pool, the transaction's own 20-second budget — aborts the transaction, and
   * with it the `response` row that had already been written. The submission
   * then answers 500 and the registration is gone, which is precisely the
   * outage this exists to prevent. Catching the error would not help; a
   * failed statement leaves the transaction aborted either way.
   *
   * What that costs is a count read a moment before the rows it governs are
   * written, i.e. a slightly stale number — and that is affordable **because
   * this limit is soft by construction** (see the „no lock" paragraph below).
   * The window it widens is the one the parallel proof already tolerates, not a
   * new one. The *application* of the number stays inside the transaction, as a
   * pure `capMails`, so the rows still commit with the answer exactly as
   * the requirement promises.
   *
   * Both call sites are here rather than each doing its own arithmetic: the
   * submission and the edit are two mail triggers of one form, they share one
   * budget, and two implementations of „wie viel ist noch übrig" would be two
   * answers to it. Neither calls it when there is nothing to cap — no
   * notification on the submission, no changed answer on the edit (a review finding):
   * the cheapest query is the one that is not sent.
   *
   * ## The honeypot short-circuits, and that is not a shortcut
   *
   * A filled decoy allows nothing and asks the database nothing. The saved
   * round trip is incidental; what matters is the consequence for the count
   * below: rows suppressed at creation do **not** consume the budget, so an
   * automated flood cannot spend an organisation's budget on mails it was never going to
   * send and silence the confirmations of the people registering alongside it.
   * That is the assertion `mail-budget.spec.ts` proves at „Köder verbraucht
   * nichts" — and it is what removing the `NOT` clause below would break.
   *
   * The saved query does make a baited submission measurably faster than a
   * clean one, and that is a **named open point rather than an oversight**
   * (a review finding; written up under the requirement in
   * `abnahmekriterien-m3.md`). Closing it would mean running the count for bot
   * traffic too — reinstating exactly the amplification this branch prevents —
   * to hide something the decoy's own field name, fixed and rendered into every
   * page, already gives away.
   *
   * ## What counts as spent, and what does not
   *
   * The window is counted over rows of **this form** — the budget is „je
   * Formular" — and `tenant_id` is in the `where` beside `form_id`
   * although `form_id` alone is unique. `mail_log` carries no composite foreign
   * key (see {@link toMailLogRow}), so this is the same rule the write follows:
   * both come from the one resolved form row, and a count is not exempt from it.
   * `@@index([formId, createdAt])` on `mail_log` exists for exactly this
   * statement (`schema.prisma`) — without it every submission of a busy Organisation
   * scans that organisation's whole window.
   *
   * `NOT (failed AND attempts = 0)` is the rest: a row that was never handed to
   * the queue is not a mail. That covers the ones this method itself capped, the
   * ones `submissionMails` refused for want of a readable recipient — and, named
   * rather than hidden, a row the worker failed on a broken SMTP block
   * (`MailIdentityService`'s `fail` arm leaves `attempts` untouched). The last
   * one errs towards letting *more* mail out, for an organisation whose mail cannot go
   * out at all; the alternative reading would have a broken configuration
   * silently eat the budget as well.
   *
   * **No lock, and that is the decision** (second proof). The
   * answer limit takes `SELECT … FOR UPDATE` on the form row because a
   * seat count has to be exact. A sending budget does not: it is deliberately
   * generous, so exceeding it by a few mails under a burst is harmless, while a
   * second form-wide lock at the start of a registration — taken by *every*
   * submission, including the overwhelming majority of forms that will never
   * come near their budget — is not. The proof says so out loud by asserting
   * „höchstens Budget + Toleranz" with the tolerance written down as a number.
   */
  private async mailAllowance(
    form: { id: string; tenantId: string },
    settings: FormSettings,
    honeypotFilled: boolean,
    /** The instant these rows will carry — the same one the window is cut at. */
    queuedAt: Date,
  ): Promise<MailAllowance> {
    if (honeypotFilled) {
      return { allowance: 0, reason: HONEYPOT_SUPPRESSION_REASON };
    }

    const spent = await this.prisma.mailLog.count({
      where: {
        formId: form.id,
        tenantId: form.tenantId,
        createdAt: { gte: budgetWindowStart(queuedAt, settings) },
        NOT: { status: 'failed', attempts: 0 },
      },
    });

    return {
      allowance: settings.mailBudgetLimit - spent,
      reason: MAIL_BUDGET_EXCEEDED_REASON,
    };
  }

  /**
   * The notifications this form might send on — read straight, because there is
   * no `TenantScope` on the public path (see the class comment).
   *
   * **`tenant_id` is in the `where`, not in a filter afterwards** (`AGENTS.md`),
   * and it comes from the form the slug resolved to. Which notifications
   * are silent — inactive, `save`, participant-bound while the switch is off —
   * is `submissionMails`' decision and not this query's: the filter belongs
   * where the rule is written down, or „abwesend, nicht deaktiviert" would be
   * enforced in two places and provable in neither.
   */
  private notificationsOf(form: {
    id: string;
    tenantId: string;
  }): Promise<SubmissionNotification[]> {
    return this.prisma.notification.findMany({
      where: { formId: form.id, tenantId: form.tenantId },
      select: {
        id: true,
        triggers: true,
        format: true,
        toSubmitter: true,
        recipients: true,
        subject: true,
        // Since the body is frozen at the enqueue it is read here, with the
        // rest of the notification, and not again by the worker.
        body: true,
        // The topmost level of the `Reply-To` chain — read here,
        // because the effective value is frozen at the enqueue and the
        // worker does not touch the notification again.
        replyTo: true,
        active: true,
      },
    });
  }

  /**
   * The edit link for an answer that is **already stored**, defensive against
   * the one failure this call cannot avoid any more (a review finding).
   *
   * `PublicUrlService.responseEditUrl` became a database read — a
   * organisation's own address, then the installation's — and both `submit` and
   * `updateByEditToken` call it **after** the transaction that wrote the
   * response has already committed. Before that the address was configuration
   * held in memory and could not fail here; now it can, and letting that
   * throw would turn an accepted, stored answer into a 500 the participant
   * reads as „hat es nicht geklappt" and resends against — the exact double
   * registration the confirmation promise exists to prevent.
   *
   * `null` is the safe answer regardless of cause: it is what a missing base
   * address returns on its own, and the mechanics already carry it
   * (`{{bearbeiten}}` resolves to nothing, `editUrl: null`). A database
   * hiccup gets the same treatment as „nicht konfiguriert" rather than a
   * status code that implies the request itself failed.
   */
  private async editUrlOrNull(
    tenantId: string,
    editToken: string,
  ): Promise<string | null> {
    try {
      return await this.publicUrls.responseEditUrl(tenantId, editToken);
    } catch (error: unknown) {
      // `tenantId` names *which* organisation's link failed — without it, an organisation
      // that loses its link on every submission produces the same sentence
      // over and over with nothing to tell it apart from a one-off hiccup
      // (a review finding). The detail falls back to `String(error)` because
      // this call can also fail on a plain string throw, and `undefined`
      // told a reader nothing was wrong at all.
      this.logger.error(
        `Building the edit link for tenant ${tenantId} failed after the ` +
          'response was already stored; answering without one rather than ' +
          'failing the request.',
        error instanceof Error ? error.stack : String(error),
      );
      return null;
    }
  }

  /**
   * Writes a broken-document line the **first** time it happens, and never
   * again — see {@link reportedDocuments} for why a public route may not log
   * per request.
   *
   * Deliberately not `warn` with sampling: the first occurrence is the whole
   * message, and a sampled stream makes „how often" look meaningful when it
   * only tracks how often somebody reloaded.
   */
  private reportOnce(message: string): void {
    if (this.reportedDocuments.has(message)) {
      return;
    }
    this.reportedDocuments.add(message);
    this.logger.error(message);
  }

  /**
   * Resolves a public address, or refuses — the single place the 404 is
   * raised, so the unknown slug and the unpublished form cannot drift apart.
   */
  private async load(slug: string) {
    // Bounded **and** spelled like a slug before the database sees it. The
    // value comes from a URL anyone may write, so neither is optional:
    //
    // - the length, because an unbounded string has no business becoming a
    //   query parameter (200 is far above the 22 characters a real slug has);
    // - the alphabet, because a percent-escape is decoded before it gets here.
    //   `%00` arrived as a NUL byte, PostgreSQL refuses U+0000 inside `text`,
    //   and the query threw — a **500 where every other unknown address
    //   answers 404**, which is exactly the probe this closes. A slug is
    //   `randomBytes(16).toString('base64url')` (`forms.service.ts`), so its
    //   alphabet is fixed and nothing outside it can name a form.
    if (!isPublicSlug(slug)) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }

    /*
     * **Both refusals are conditions of this statement, not `if`s after it**
     * (a finding of the query-conditions review).
     *
     * The body of the two 404s is byte-identical and a suite asserts it, but
     * they used to differ in *shape*: `findUnique` on the slug alone found the
     * deleted form, so Prisma went on to issue the relation queries for
     * `publishedVersion`, `tenant` and its Logo files — three round trips an
     * invented address never costs, and the difference is measurable from
     * outside without reading a single byte of the body. „byte-gleich" is worth
     * having; „byte-gleich und gleich teuer" is what it was meant to be.
     *
     * It is also the cheaper build, not a price paid for the property: nothing
     * matches, so no relation query is issued at all, and the successful path
     * keeps the one statement it always had. `public_slug` is unique, so this
     * is the same index lookup with two more predicates on the row it finds.
     */
    /*
     * **Filter 5 of the six of the requirement — `tenant.deleted_at`**, and it
     * is a third condition of this same statement for exactly the reason the
     * comment above gives: a deleted organisation's form must cost the same three
     * absent round trips an invented address costs, or the difference between
     * „gelöschte Organisation" and „gibt es nicht" is measurable from outside without
     * reading a byte of the body.
     *
     * It is the one filter of the six that a stranger on the internet reaches,
     * and the only one whose absence carries data out of the house on its own:
     * an organisation taken out of service would go on collecting Anmeldungen under its
     * old links.
     */
    const form = await this.prisma.form.findFirst({
      where: {
        publicSlug: slug,
        deletedAt: null,
        status: 'active',
        tenant: { deletedAt: null },
      },
      include: {
        publishedVersion: true,
        // With the organisation's own Logo files, so `tenantOf` can prove a
        // `logo_ref` that names an upload (ADR-0014 no. 12, shore 1).
        tenant: { include: OWNED_LOGO_INCLUDE },
      },
    });

    if (form === null) {
      throw new NotFoundException(PUBLIC_FORM_NOT_FOUND_MESSAGE);
    }
    return form;
  }
}

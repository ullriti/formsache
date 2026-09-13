import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PURGE_STORAGE_UNAVAILABLE_MESSAGE,
  RESTORE_REFUSAL_MESSAGES,
  boundedRequests,
  exhaustedPosition,
  formDefinitionSchema,
  inDefinitionOrder,
  withLiveCapacity,
  type DeletedForm,
  type DeletedResponse,
  type FormSettings,
  type RestoreRefusal,
  type RestoreRefusalReason,
  type SeatRequest,
  type TrashPurgeResult,
  type TrashView,
} from '@formsache/shared';

import { FORM_NOT_FOUND_MESSAGE } from '../common/form-not-found';
import { isUuid } from '../common/uuid';
import { requireForm } from '../forms/forms.service';
import { MailClock } from '../mail/mail-clock';
import {
  UnreadableSettingsError,
  enforcedSettings,
} from '../settings/settings-enforcement';
import type { FormRestriction } from '../tenancy/form-restriction';
import {
  PermanentDeletionService,
  type PermanentDeletionOutcome,
} from './permanent-deletion.service';
import type {
  DeletedResponseRow,
  RestoreFacts,
  TenantScope,
} from '../tenancy/tenant-scope';

/**
 * **The trash.**
 *
 * `form.deleted_at` and `response.deleted_at` have existed and every
 * read of both has filtered them to `null` since then. This is the service that
 * *writes* them — and with that, the promises hanging off those two columns
 * come due: a deleted form must be gone from the public address as thoroughly
 * as one that never existed, and an answer coming back out has to fit into a
 * form that carried on without it.
 *
 * No `PrismaService`: every statement goes through the `TenantScope` the guard
 * chain hands in, so „diese Abfrage hat die Organisation vergessen" has no spelling
 * here.
 */

/**
 * The one answer for an answer the caller may not have — „gibt es nicht",
 * „gehört einer anderen Organisation", „liegt nicht im Papierkorb" and „gehört zu
 * einem gelöschten Formular", all through the same door.
 *
 * One message for four states for the same reason `FORM_NOT_FOUND_MESSAGE`
 * exists: two doors are two bodies that can drift, and the drift is an oracle
 * — here one that would confirm the existence of a registration by refusing it
 * differently.
 */
export const RESPONSE_NOT_FOUND_MESSAGE = 'Antwort nicht gefunden.';

/**
 * Answer to a restore whose form's settings cannot be read.
 *
 * Fail closed, exactly like the submission path (`settings-enforcement.ts`):
 * an unreadable document must never be read as „kein Limit", because that is
 * the reading that lets the trash around the very limit the requirement is
 * about. The reason goes into the log where the ids belong.
 */
export const UNREADABLE_SETTINGS_MESSAGE =
  'Die Einstellungen dieses Formulars können gerade nicht gelesen werden. Bitte später erneut versuchen.';

@Injectable()
export class TrashService {
  private readonly logger = new Logger(TrashService.name);

  constructor(
    /**
     * **The one clock**, `MailClock` (which asks for „**eine**
     * Uhr … oder eine gleich gebaute" and gets the first).
     *
     * `deleted_at` is not decoration on this route: it is the instant the
     * 30-day countdown starts from, and the purge that enforces it will
     * be proven at „29 Tage bleibt, 31 Tage ist weg" with an injected clock. A
     * `new Date()` in here would mean that proof can never delete through the
     * *route* — the only way to a 31-day-old row would be to write `deleted_at`
     * into the table by hand, i.e. to test the purge against a state the
     * application is not shown to produce.
     *
     * `MailClock` rather than a `TrashClock` of its own for the reason its own
     * note gives: two clocks are two opinions about now, and this timestamp and
     * the `mail_log` purge's cut-off are read by the same tests.
     */
    private readonly clock: MailClock,
    /**
     * The physical deletion itself — **session-free on purpose**, as the requirement puts it. This service resolves and
     * refuses; that one removes bytes and rows and knows nothing about HTTP, so
     * the 30-day purge can call it with a scope it minted itself.
     */
    private readonly permanent: PermanentDeletionService,
  ) {}

  /**
   * The two sections of the trash — tenant-wide, newest
   * deletion first.
   *
   * **The per-form restriction is part of the statement, not a filter after
   * it**, the same way `FormsService.list` applies it: a
   * form somebody is locked out of must not become visible again by being
   * deleted, and „im Papierkorb" is not an exception to a revocation.
   */
  async view(
    scope: TenantScope,
    restriction: FormRestriction,
  ): Promise<TrashView> {
    const forms = await scope.forms.findManyDeleted(restriction.formFilter());
    // The same fragment, nested under the answer's form: a revoked form's
    // answers are its answers, and „im Papierkorb" is not an exception to a
    // revocation. In the `where`, never in a filter afterwards — a revoked
    // registration must not leave PostgreSQL at all.
    const responses = await scope.forms.deletedResponses(
      restriction.formFilter(),
    );

    // **The effective rights per form**, from the one calculation the guard
    // chain also decides by (`FormsService.list` asks the same method for the
    // same reason). A cap does not *hide* a form — it answers 403, not 404 —
    // so a capped form is in the section above and has to have its answers
    // kept out of the one below: „wer Antworten nicht sehen darf" must not
    // learn from the trash that a registration was made and withdrawn.
    const byForm = await restriction.effectivePermissionsIn(scope);
    const mayViewAnswersOf = (formId: string): boolean =>
      (byForm.get(formId) ?? restriction.heldPermissions).canViewResponses;

    return {
      forms: forms.map(toDeletedForm),
      responses: responses
        .filter((response) => mayViewAnswersOf(response.formId))
        .map(toDeletedResponse),
    };
  }

  /** Moves a form into the trash. */
  async deleteForm(scope: TenantScope, id: string): Promise<void> {
    // The one 404: unknown, malformed, another organisation's — and one already in the
    // trash, which is what makes a double press a no-op with an answer
    // rather than a second deletion moment.
    await requireForm(id, (formId) => scope.forms.findSettingsById(formId));

    if (!(await scope.forms.softDelete(id, this.clock.now()))) {
      // Somebody deleted it between the read and the write. The outcome they
      // asked for is the outcome that holds, so this is the same 404 as above
      // rather than a 409 about a race nobody can act on.
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }
  }

  /** Takes a form back out of the trash. */
  async restoreForm(scope: TenantScope, id: string): Promise<void> {
    // Not `requireForm`: that one refuses a deleted form, which is the only
    // kind this route is about. The other three refusals are the same.
    if (!isUuid(id)) {
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }
    const form = await scope.forms.findDeletedById(id);
    // „Gibt es nicht", „gehört einer anderen Organisation" and „liegt gar nicht im
    // Papierkorb" leave through the one door — a live form must not be
    // distinguishable here from an unknown id.
    if (form?.deletedAt == null) {
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }

    if (!(await scope.forms.restore(id))) {
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }
  }

  /**
   * Moves one answer into the trash.
   *
   * The form is resolved first and through the **same** door every other form
   * route uses, so an answer of another organisation's form is a 404 about the form and
   * never a 404 about an answer whose existence the message would confirm.
   */
  async deleteResponse(
    scope: TenantScope,
    formId: string,
    responseId: string,
  ): Promise<void> {
    await requireForm(formId, (id) => scope.forms.findSettingsById(id));

    if (!isUuid(responseId)) {
      throw new NotFoundException(RESPONSE_NOT_FOUND_MESSAGE);
    }
    if (
      !(await scope.forms.softDeleteResponse(
        { id: responseId, formId },
        this.clock.now(),
      ))
    ) {
      throw new NotFoundException(RESPONSE_NOT_FOUND_MESSAGE);
    }
  }

  /**
   * **Moves several answers of one form into the trash** (the action bar of the responses table).
   *
   * Same rights as {@link deleteResponse} — the pair `can_view_responses` **and**
   * `can_build`, declared on the route. Deleting twenty answers is
   * not a weaker act than deleting one of them.
   *
   * ## Why the ids are deduplicated here
   *
   * `softDeleteResponses` decides „alles oder nichts" by comparing the number
   * of rows it wrote against the number of ids it was given. `[a, a]` writes
   * one row for two ids and would look exactly like „eine Id passte nicht" — a
   * 404 for a request that named nothing wrong. Deduplicating is therefore part
   * of the verdict, not tidiness, and it happens **before** the count is fixed.
   *
   * ## Every other refusal is the one door
   *
   * An id of the wrong shape, an id of another organisation, an id of another form of
   * this organisation, an id that is already in the trash: all of them are
   * `RESPONSE_NOT_FOUND_MESSAGE`, and none of them deletes anything — the
   * transaction rolls back. A caller can therefore not use this route to find
   * out which of the four a given id is, which is the same promise the single
   * route makes.
   */
  async deleteResponses(
    scope: TenantScope,
    formId: string,
    responseIds: readonly string[],
  ): Promise<void> {
    await requireForm(formId, (id) => scope.forms.findSettingsById(id));

    const ids = [...new Set(responseIds)];
    if (ids.some((id) => !isUuid(id))) {
      throw new NotFoundException(RESPONSE_NOT_FOUND_MESSAGE);
    }
    if (
      !(await scope.forms.softDeleteResponses(
        { ids, formId },
        this.clock.now(),
      ))
    ) {
      throw new NotFoundException(RESPONSE_NOT_FOUND_MESSAGE);
    }
  }

  /**
   * **Takes an answer back out of the trash — or says why it stays**.
   *
   * The two refusals are the price of two earlier promises, and they are
   * checked in the order the submission path checks them (Antwortlimit, then
   * Obergrenze) so that an editor and a participant are told the same thing
   * about the same form in the same order.
   *
   * The **lock** is not here: it is in `ScopedFormDelegate.restoreResponse`,
   * together with the two counts it protects, and this method hands that
   * transaction a pure verdict. Deciding out here and writing in there would
   * put the window back that the lock exists to close.
   */
  async restoreResponse(
    scope: TenantScope,
    formId: string,
    responseId: string,
  ): Promise<void> {
    await requireForm(formId, (id) => scope.forms.findSettingsById(id));

    if (!isUuid(responseId)) {
      throw new NotFoundException(RESPONSE_NOT_FOUND_MESSAGE);
    }
    const row = await scope.forms.findDeletedResponse({
      id: responseId,
      formId,
    });
    if (row === null) {
      throw new NotFoundException(RESPONSE_NOT_FOUND_MESSAGE);
    }

    const settings = this.settingsFor(row);
    const capacities = liveDefinitionOf(row);

    const outcome = await scope.forms.restoreResponse(
      { id: responseId, formId },
      (facts) => this.verdict(facts, settings, capacities),
    );

    switch (outcome.kind) {
      case 'restored':
        return;
      case 'refused':
        // 409, like every refusal of the submission path: the request is
        // well-formed and permitted, the *state* of the form is what says no.
        throw new ConflictException(outcome.refusal);
      case 'not-found':
        // The row stopped matching between the read and the write — restored in
        // another tab, or its form deleted. Never reported as a refusal: that
        // would tell an editor „ausgebucht" about an answer that is not in
        // the trash any more.
        throw new NotFoundException(RESPONSE_NOT_FOUND_MESSAGE);
      default: {
        /*
         * **Exhaustive by the compiler, not by inspection.** A statement switch
         * without this branch asks TypeScript nothing (the lesson written out at
         * `toStoredAnswers` in `public-forms.service.ts`): a fourth outcome —
         * „refused because the form is now deleted", say — would compile green
         * and fall out of this method as a silent 204, i.e. a restore the caller
         * is told succeeded and that did not happen.
         */
        const unhandled: never = outcome;
        throw new Error(
          `restoreResponse: unhandled outcome ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Physical deletion — the requirement
  // -------------------------------------------------------------------------

  /**
   * **Deletes a form permanently** .
   *
   * The refusals are the ones this controller pair uses everywhere: the same
   * 404 for „gibt es nicht / anderer Organisation / liegt nicht im Papierkorb", and a
   * **repeatable** 503 when the storage would not release an attachment's bytes
   * — nothing was deleted in that case, and saying „endgültig gelöscht" about
   * something that is not is the one answer that would be worse than a failure.
   */
  async purgeForm(scope: TenantScope, id: string): Promise<void> {
    if (!isUuid(id)) {
      throw new NotFoundException(FORM_NOT_FOUND_MESSAGE);
    }
    this.assertPurged(
      await this.permanent.deleteForm(scope, id),
      FORM_NOT_FOUND_MESSAGE,
    );
  }

  /**
   * **Deletes an answer permanently** .
   *
   * The form is resolved first and through the same door every other form route
   * uses, so an answer of another organisation's form is a 404 about the form and never
   * one about an answer whose existence the message would confirm.
   */
  async purgeResponse(
    scope: TenantScope,
    formId: string,
    responseId: string,
  ): Promise<void> {
    await requireForm(formId, (id) => scope.forms.findSettingsById(id));

    if (!isUuid(responseId)) {
      throw new NotFoundException(RESPONSE_NOT_FOUND_MESSAGE);
    }
    this.assertPurged(
      await this.permanent.deleteResponse(scope, { formId, responseId }),
      RESPONSE_NOT_FOUND_MESSAGE,
    );
  }

  /**
   * **Emptying the trash**  — one batch of what this caller may
   * reach, and a count of what actually went.
   *
   * No 404 and no 503: an empty trash is a legitimate outcome of the verb,
   * and an item the storage refused is one number in the answer rather than a
   * failure of the whole call — the rest of the trash has been emptied, and
   * reporting that as an error would leave an editor guessing what stands.
   *
   * A call is bounded (`TRASH_PURGE_BATCH_SIZE`) and says how much is left, so
   * a trash larger than one batch takes more than one press — see
   * {@link PermanentDeletionService.emptyTrash} for why that is the shape.
   */
  emptyTrash(
    scope: TenantScope,
    restriction: FormRestriction,
  ): Promise<TrashPurgeResult> {
    return this.permanent.emptyTrash(scope, restriction);
  }

  /** The two refusals of a single-item purge, in one place so they cannot drift. */
  private assertPurged(
    outcome: PermanentDeletionOutcome,
    notFoundMessage: string,
  ): void {
    switch (outcome) {
      case 'deleted':
        return;
      case 'not-found':
        throw new NotFoundException(notFoundMessage);
      case 'files-stuck':
        // 503 and not 500: the volume is a temporary operating state and the
        // request is repeatable — the same reading `UNREADABLE_SETTINGS_MESSAGE`
        // takes one method above. The reason stays in the log; the message says
        // what was *not* done.
        throw new ServiceUnavailableException(
          PURGE_STORAGE_UNAVAILABLE_MESSAGE,
        );
      default: {
        // Exhaustive by the compiler: a fourth outcome must not leave this
        // method as a silent 204 — a deletion the caller is told succeeded and
        // that did not happen.
        const unhandled: never = outcome;
        throw new Error(
          `assertPurged: unhandled outcome ${JSON.stringify(unhandled)}`,
        );
      }
    }
  }

  /**
   * The verdict what is required is — **pure**, and evaluated under the
   * form's lock by the delegate that reads the facts.
   *
   * `exhaustedPosition` is called with its **default** delta, i.e. with the
   * full seat count of every position, and that is the difference between a
   * restore and a correction: a correction's own seats are already inside
   * `takenSeats` and have to be subtracted (`seatsBeyond`), whereas this
   * answer is deleted while the sum is read and therefore contributes nothing
   * to it. Passing a difference here would let a registration for twelve
   * people back into a hall with two seats left.
   */
  private verdict(
    facts: RestoreFacts,
    settings: FormSettings,
    capacities: ReturnType<typeof liveDefinitionOf>,
  ): RestoreRefusal | null {
    if (
      settings.maxResponsesEnabled &&
      facts.liveResponses >= settings.maxResponses
    ) {
      return refusal('limit_reached');
    }

    if (capacities !== null) {
      // **In the form's order before anything is judged** (a review
      // finding). `restoringSeats` are `event_registration` rows and arrive in
      // PostgreSQL's order, not the definition's — so „die erste volle
      // Veranstaltung" in the refusal named an arbitrary one of the full
      // positions on a form with several. `inDefinitionOrder` is what makes
      // that sentence mean the same thing here as on the submission path, where
      // `seatRequests` produces the order by walking the definition.
      const bounded = boundedRequests(
        withLiveCapacity(
          inDefinitionOrder(facts.restoringSeats, capacities).map(
            (seat): SeatRequest => ({
              ...seat,
              capacity: null,
            }),
          ),
          capacities,
        ),
      );
      const position = exhaustedPosition(bounded, facts.takenSeats);
      if (position !== null) {
        return refusal('event_full', position);
      }
    }

    return null;
  }

  /**
   * The effective settings of the form this answer belongs to — read
   * **strictly**, i.e. fail closed.
   *
   * The same reading `PublicFormsService.settingsForEnforcement` makes, and for
   * the same reason: „unreadable" must not become „kein Limit" on a path that
   * decides whether an answer joins the count. Here the consequence would be
   * precisely the scenario this guards against — the Antwortlimit bypassed through the
   * trash.
   */
  private settingsFor(row: DeletedResponseRow): FormSettings {
    try {
      return enforcedSettings(row.form);
    } catch (cause) {
      if (!(cause instanceof UnreadableSettingsError)) {
        // A programming error has to reach the 500 path where it is loud,
        // instead of being answered with a calm „bitte später erneut".
        throw cause;
      }
      // The reason goes into the log, where the ids belong; the editor
      // learns only that the form cannot be judged right now. Nothing about the
      // document leaves the house — it holds a sealed Zugangswort.
      this.logger.error(
        `${cause.message}; refusing to restore response ${row.id} (fail closed).`,
      );
      throw new ServiceUnavailableException(UNREADABLE_SETTINGS_MESSAGE);
    }
  }
}

function refusal(
  reason: RestoreRefusalReason,
  position?: { questionId: string; eventKey: string },
): RestoreRefusal {
  return {
    message: RESTORE_REFUSAL_MESSAGES[reason],
    reason,
    // Omitted rather than `null` on `limit_reached`, the reading
    // `restoreRefusalSchema` documents.
    ...(position === undefined ? {} : { position }),
  };
}

/**
 * The definition whose Obergrenzen govern this restore, or `null` when there
 * is none to read.
 *
 * The **live** one, because a capacity is an operating limit the organisation changes
 * without republishing what the form asks (`withLiveCapacity` writes out what
 * reading the snapshot instead cost).
 *
 * The snapshot is the fallback for a form with no published version or with one
 * that no longer parses, and it is that for one reason only: it is **the other
 * description of this form that exists**, and some description of the positions
 * is better than none, the same fallback `loadForEdit` takes. It is deliberately
 * *not* claimed to be the safe direction: „kann nur ablehnen, nie zulassen"
 * is false in one of the two directions, which
 * is the sharper one. Snapshot „ohne Grenze", live „10" yields no bounded
 * position at all, so nothing is checked and a registration for twelve walks
 * back into a hall for ten; the mirror image (snapshot bounds what the live form
 * has freed) merely refuses too much. Both are reachable in principle and the
 * fallback picks neither.
 *
 * What bounds the damage is not the direction but the *reachability*: this arm
 * needs a form whose published version is missing or unparseable, and such a
 * form serves nobody publicly either — the public read route answers 404 for
 * exactly that state — so there is no live registration flow left to overbook.
 *
 * `null` — neither parses — means no position is bounded, so no restore is
 * refused on seats. That is the admitting direction again, and the paragraph
 * above is what bounds it: same state, same 404, same absence of anybody left
 * to overbook.
 */
function liveDefinitionOf(
  row: DeletedResponseRow,
): ReturnType<typeof formDefinitionSchema.parse> | null {
  const live = formDefinitionSchema.safeParse(
    row.form.publishedVersion?.schema,
  );
  if (live.success) {
    return live.data;
  }
  const snapshot = formDefinitionSchema.safeParse(row.formVersion.schema);
  return snapshot.success ? snapshot.data : null;
}

function toDeletedForm(form: {
  id: string;
  title: string;
  deletedAt: Date | null;
  _count: { responses: number };
}): DeletedForm {
  return {
    id: form.id,
    title: form.title,
    responseCount: form._count.responses,
    // The row came out of `findManyDeleted`, whose `where` is
    // `deletedAt: { not: null }` — the column is nullable in the type and not
    // in this result set. Answered with the epoch rather than asserted: a
    // non-null assertion in a payload builder is a claim the builder cannot
    // check, and an impossible timestamp is visible where a crash is not.
    deletedAt: (form.deletedAt ?? new Date(0)).toISOString(),
  };
}

function toDeletedResponse(response: {
  id: string;
  formId: string;
  submittedAt: Date;
  deletedAt: Date | null;
  form: { title: string };
}): DeletedResponse {
  return {
    id: response.id,
    formId: response.formId,
    formTitle: response.form.title,
    submittedAt: response.submittedAt.toISOString(),
    deletedAt: (response.deletedAt ?? new Date(0)).toISOString(),
  };
}

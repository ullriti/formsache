import type { ReactElement, ReactNode, RefObject } from 'react';
import { useId } from 'react';
import type {
  PublishBlockedCondition,
  PublishBlockedPlaceholder,
  PublishDiffQuestion,
  PublishPreview,
} from '@formsache/shared';
import {
  ORPHANED_PLACEHOLDER_LEAD,
  PLACEHOLDER_PLACE_LABELS,
  RETIRED_COLUMN_NOTE,
  UNRESOLVABLE_CONDITION_LEAD,
  unresolvableConditionText,
} from '@formsache/shared';

import { QUESTION_TYPE_LABELS } from '../../builder/question-defaults';
import { useFocusTrap } from '../../shell/use-focus-trap';

/**
 * One group of the notice: a heading, the questions by name, and what happens
 * to the answers already given to them.
 *
 * A component rather than three copies of the same JSX, because the copies are
 * what let a review swap two of them without a single test noticing — the
 * notice then said „Diese Fragen werden entfernt" over the questions being
 * *added*, which is Konzept no. 23 turned exactly upside down.
 */
function ChangeGroup({
  title,
  note,
  children,
}: {
  readonly title: string;
  readonly note: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="publish-notice__group" aria-label={title}>
      <h3 className="publish-notice__group-title">{title}</h3>
      <ul className="publish-notice__list">{children}</ul>
      <p className="publish-notice__note">{note}</p>
    </section>
  );
}

/**
 * One kind of block: the lead sentence that says what is wrong, and the
 * findings by name (the requirements).
 *
 * A component for the reason {@link ChangeGroup} is one — there
 * are two of these standing under each other, and two copies of „Leitsatz plus
 * Liste" are what lets a review swap the two lists without a test noticing.
 *
 * **A heading, not a `role="alert"`.** Both leads can be freshly mounted in the
 * same dialog, and two live regions appearing at once is typically announced as
 * one of them or as neither; what carries the information is the dialog title
 * („Veröffentlichen nicht möglich") and the block's own name. As `h3` the two
 * leads are also something to navigate between, which is what an editor with a
 * long repair list actually needs.
 *
 * The lead comes in as a string, always from `@formsache/shared`: it is the same
 * sentence the 422 states, and a lead written here would be free to explain the
 * block differently from the refusal that enforces it.
 */
function BlockedGroup({
  lead,
  children,
}: {
  readonly lead: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <>
      <h3 className="publish-notice__problem">{lead}</h3>
      <ul className="publish-notice__list">{children}</ul>
    </>
  );
}

function questionItem(question: PublishDiffQuestion): ReactElement {
  return (
    <li key={question.id}>
      {question.label}{' '}
      <span className="publish-notice__type">
        {QUESTION_TYPE_LABELS[question.type]}
      </span>
    </li>
  );
}

/**
 * One notification whose placeholder would be left pointing at nothing.
 *
 * **Both names, always:** the notification and the token. „Irgendwo in Ihren
 * Benachrichtigungen" would send the editor searching n texts by hand, which is
 * exactly what this dialog exists to prevent. The question's old caption comes along
 * when the version in force still knows it — an id is precise and unreadable, a
 * caption readable and ambiguous, and together they are something to act on.
 *
 * The place is named with `PLACEHOLDER_PLACE_LABELS` from `@formsache/shared` — the
 * same wording the server's 422 uses. Two copies of „Betreff / Text /
 * Empfängerliste" describe the same three places to the same person, and the
 * day one of them says „Empfänger" instead, the editor searches for the wrong
 * thing.
 */
function blockedItem(
  finding: PublishBlockedPlaceholder,
  index: number,
): ReactElement {
  const places = finding.places
    .map((place) => PLACEHOLDER_PLACE_LABELS[place])
    .join(', ');

  return (
    <li key={`${finding.notificationName}-${finding.token}-${String(index)}`}>
      Benachrichtigung <strong>{finding.notificationName}</strong>
      {places === '' ? '' : ` (${places})`}:{' '}
      {finding.label === null ? null : <>„{finding.label}" – </>}
      <code className="publish-notice__token">{finding.token}</code>
    </li>
  );
}

/**
 * One *Bedingte Anzeige* whose source no longer resolves (the requirement).
 *
 * The sentence comes from `unresolvableConditionText` in `@formsache/shared` — the
 * very function that builds the server's 422 and the mark on the question card
 * (`condition-status.ts`). Not politeness: this dialog is required to say
 * „derselbe Text, den die 422 nennt", and a sentence assembled here from
 * `defect` would be a fourth wording of the same four defects, free to drift
 * from the refusal it is announcing.
 */
function conditionItem(
  finding: PublishBlockedCondition,
  index: number,
): ReactElement {
  return (
    <li key={`${finding.questionLabel}-${finding.defect}-${String(index)}`}>
      {unresolvableConditionText(finding)}
    </li>
  );
}

/**
 * The notice before republishing over existing answers (Konzept no. 23).
 *
 * It states the number of answers on file and **names** every question that is
 * removed, added or changes type — and next to each group, what actually
 * happens to the answers already given. „Entfernt" reads like data loss to
 * anyone who has not read Konzept no. 22; that group therefore says in as many
 * words that nothing is deleted.
 *
 * It decides nothing: the editor publishes or cancels, exactly as before. The
 * server's publish endpoint is unchanged and asks for no confirmation.
 */
export function PublishNotice({
  preview,
  outdated,
  busy,
  openerRef,
  openLegalPageNames,
  onCancel,
  onConfirm,
}: {
  /** What the server reported, or `undefined` when it could not be asked. */
  readonly preview: PublishPreview | undefined;
  /**
   * The draft has moved on since the preview was taken, so the list below no
   * longer describes what would be published.
   */
  readonly outdated: boolean;
  /** The publish this notice confirmed is in flight. */
  readonly busy: boolean;
  /** The publish button, so focus can return to it — see `useFocusTrap`. */
  readonly openerRef: RefObject<HTMLElement | null>;
  /**
   * **The names of this organisation's unfinished legal-text pages** — the
   * *second* stage of the hint below, and empty for whoever may not have them
   * (ADR-0028, open item 3).
   *
   * Empty is not „alles fertig": whether anything is missing at all comes out
   * of `preview.organisationLegal` and is asked there. This list only decides
   * whether the notice can go on to name the pages — an editor with
   * `can_build` alone gets the sentence without them, because the documents
   * behind them sit behind `can_manage_settings`.
   *
   * Handed in instead of read here, for the reason this dialog has for
   * everything else as well: it displays what it is told, and puts no
   * questions of its own to the server. Who fills it and under which
   * condition stands in `use-open-legal-page-names.ts`.
   */
  readonly openLegalPageNames: readonly string[];
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactElement {
  const titleId = useId();
  const { panelRef, onKeyDown } = useFocusTrap({
    onClose: onCancel,
    openerRef,
  });

  const changes = preview?.changes;
  /**
   * the requirements — the one part of this dialog that is not advice.
   *
   * The server refuses such a publish with a 422; showing it here turns that
   * refusal into something the editor reads *before* pressing, and disables the
   * confirm button, because offering a button that cannot succeed is how a
   * refusal gets read as a bug.
   *
   * **Two kinds, one field, one rule.** A dangling placeholder and a Bedingung
   * whose source no longer resolves are the same refusal to the editor, so the
   * button asks `blocked.length`, not one question per kind — a control that
   * enumerated the kinds would go on offering itself for a third one.
   */
  const blocked = preview?.blocked ?? [];
  // The literal comparison narrows on its own; a named type guard for a
  // predicate used once would only be a second place to keep the two kinds
  // apart.
  const placeholders = blocked.filter(
    (finding) => finding.kind === 'placeholder',
  );
  const conditions = blocked.filter((finding) => finding.kind === 'condition');

  return (
    <div className="publish-notice">
      {/* Redundant convenience: Escape and „Abbrechen" do the same, so this
          stays out of the accessibility tree instead of becoming a second,
          unlabelled cancel control. */}
      <div
        className="publish-notice__scrim"
        aria-hidden="true"
        onClick={busy ? undefined : onCancel}
      />
      <div
        className="publish-notice__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <h2 className="publish-notice__title" id={titleId}>
          {blocked.length > 0
            ? 'Veröffentlichen nicht möglich'
            : 'Erneut veröffentlichen?'}
        </h2>

        {preview !== undefined && preview.privacyNotice !== 'ready' ? (
          /*
            **The privacy notice for this form** (ADR-0028 no. 4) —
            before the hint about the legal texts of the organisation, because
            it is the more specific one: purpose and legal basis are to be
            stated per **processing** under Art. 13 (1) (c), and this
            processing is the form that is being published right now.

            It comes out of the preview, thereby stands behind `can_build` and
            therefore reaches **every** person who can publish. Since ADR-0028
            open item 3, so does the hint below it — it used to presuppose
            `can_manage_settings` and to stay silent towards the very person
            standing here.

            **It locks nothing**, for the same reason as that one: an
            enforced legal text would be an invented one (ADR-0022 §1,
            ADR-0025 §1).
          */
          <section
            className="publish-notice__legal"
            aria-label="Datenschutzhinweis zu diesem Formular"
            data-testid="publish-form-privacy-hint"
          >
            <h3 className="publish-notice__problem">
              {preview.privacyNotice === 'empty'
                ? 'Zu diesem Formular ist kein Datenschutzhinweis hinterlegt.'
                : 'Der Datenschutzhinweis zu diesem Formular ist unvollständig.'}
            </h3>
            <p className="publish-notice__note">
              {preview.privacyNotice === 'empty'
                ? 'Wofür dieses Formular Angaben erhebt, auf welcher Rechtsgrundlage und wie lange sie aufbewahrt werden, sagt derzeit nur die allgemeine Erklärung dieser Organisation — falls sie es für dieses Formular überhaupt sagt. Art. 13 Abs. 1 lit. c DSGVO verlangt Zweck und Rechtsgrundlage je Verarbeitung. Nachtragen kannst du das in den Formular-Einstellungen unter „Datenschutzhinweise zu diesem Formular"; veröffentlichen lässt sich das Formular trotzdem.'
                : 'Teilnehmende sehen die offenen Stellen als markierte Lücken unter dem Formular. Ergänzen kannst du sie in den Formular-Einstellungen unter „Datenschutzhinweise zu diesem Formular"; veröffentlichen lässt sich das Formular trotzdem.'}
            </p>
          </section>
        ) : null}

        {preview !== undefined && preview.organisationLegal !== 'ready' ? (
          /*
            **The hint about this organisation's legal texts** (ADR-0028,
            open item 3) — after the notice of this form, because that one is
            the more specific: purpose and legal basis are owed per
            **processing**, and the processing is the form being published
            right now.

            **Two stages, and the guard sits between them.** *That* something
            is missing comes out of `preview.organisationLegal` — one traffic
            light over both pages, behind `can_build`, and therefore reaching
            everybody who can publish. *Which* page it is comes from
            `openLegalPageNames`, which is filled only for whoever holds
            `can_manage_settings` and thereby already has the documents. The
            second sentence therefore differs by reader: whoever can remedy it
            is sent to the pages by name, whoever cannot is told who can.

            The predecessor read `GET /tenant/legal` for both halves and so
            said nothing at all to an editor with `can_build` alone — the
            person this notice exists for.

            **It locks nothing.** „Veröffentlichen" stays operable, and that
            is the same decision ADR-0022 §1 and ADR-0025 §1 have already
            taken twice: enforced legal texts would be invented ones.
          */
          <section
            className="publish-notice__legal"
            aria-label="Rechtstexte dieser Organisation"
            data-testid="publish-legal-hint"
          >
            <h3 className="publish-notice__problem">
              {preview.organisationLegal === 'empty'
                ? 'Für diese Organisation fehlen Rechtstexte.'
                : 'Die Rechtstexte dieser Organisation sind unvollständig.'}
            </h3>
            <p className="publish-notice__note">
              {openLegalPageNames.length > 0
                ? `Betroffen: ${openLegalPageNames.join(', ')}. `
                : ''}
              {/*
                „ohne sie" and no longer „ohne Datenschutzhinweise", which is
                what stood here: that is the title of one of the two pages,
                and in the sentence without a „Betroffen:" in front of it an
                editor would read it as the answer to „welche denn?" — the one
                answer this stage deliberately does not give.
              */}
              Teilnehmende sehen auf diesen Seiten einen Hinweis, dass die
              Angaben fehlen — und ohne sie erfüllt dieses Formular die
              Informationspflicht nach Art. 13 DSGVO nicht. Veröffentlichen
              lässt es sich trotzdem.{' '}
              {openLegalPageNames.length > 0
                ? 'Nachtragen kannst du sie unter Verwaltung → Rechtstexte.'
                : 'Nachtragen kann sie, wer in dieser Organisation die Einstellungen verwaltet — unter Verwaltung → Rechtstexte.'}
            </p>
          </section>
        ) : null}

        {blocked.length > 0 ? (
          <section
            className="publish-notice__blocked"
            // Not „Platzhalter zeigen ins Leere" any more:/0.2 the
            // section also carries condition findings, and not the dialog's own
            // title either — two elements with one accessible name is a screen
            // reader announcing the same words twice.
            aria-label="Was das Veröffentlichen blockiert"
            data-testid="publish-blocked"
          >
            {/*
              The condition findings first, in the order the server refuses:
              `publish()` asks the draft's conditions before it reads this
              organisation's notifications, so an editor who repairs from the top meets
              the two refusals in the order they would arrive. That the server
              really answers in that order is measured, not assumed — „carries
              both shapes of one removal, the conditions first" in
              `apps/api/test/forms/condition-publish-lock.spec.ts`.
            */}
            {conditions.length > 0 ? (
              <BlockedGroup lead={UNRESOLVABLE_CONDITION_LEAD}>
                {conditions.map(conditionItem)}
              </BlockedGroup>
            ) : null}

            {placeholders.length > 0 ? (
              <BlockedGroup lead={ORPHANED_PLACEHOLDER_LEAD}>
                {placeholders.map(blockedItem)}
              </BlockedGroup>
            ) : null}
          </section>
        ) : null}

        {/*
          Both can be true at once — the preview failed *and* the draft moved
          on — and then both are worth saying. They used to be the two arms of
          one `? :`, which silently dropped the actual reason.
        */}
        {outdated ? (
          <p className="publish-notice__problem" role="alert">
            Der Entwurf hat sich geändert, seit diese Übersicht erstellt wurde.
            Sie beschreibt nicht mehr, was veröffentlicht würde. Bitte speichern
            und erneut auf „Erneut veröffentlichen" klicken.
          </p>
        ) : null}

        {preview === undefined || changes === undefined ? (
          <p className="publish-notice__problem" role="alert">
            Es lässt sich gerade nicht ermitteln, was sich durch das
            Veröffentlichen ändert – die Übersicht konnte nicht geladen werden.
            Wenn bereits Antworten vorliegen, betrifft das Veröffentlichen sie
            möglicherweise.
          </p>
        ) : (
          /*
            Kept on screen even when it is out of date, only dimmed: it is what
            the editor just read, and taking it away would leave them with
            „bitte speichern" and no memory of what the decision was about. The
            disabled confirm button already carries the rule.
          */
          <div
            className={
              outdated
                ? 'publish-notice__body publish-notice__body--outdated'
                : 'publish-notice__body'
            }
          >
            {/*
              The sentence of the decision, verbatim — except in the singular,
              where German simply does not allow „Es liegen bereits 1
              Antworten vor".
            */}
            <p className="publish-notice__lead">
              {preview.responseCount === 1
                ? 'Es liegt bereits 1 Antwort vor.'
                : `Es liegen bereits ${String(preview.responseCount)} Antworten vor.`}
            </p>

            {changes.removed.length > 0 ? (
              /*
                The group that reads like data loss and is not: Konzept no. 22 keeps
                every answer ever given and shows the column on. Saying so here
                is the difference between an editor who tidies up their form and
                one who does not dare to.
              */
              <ChangeGroup
                title="Diese Fragen werden entfernt"
                note={`Die bereits gegebenen Antworten bleiben erhalten und in der Antworten-Tabelle sichtbar; die Spalte wird nur als „${RETIRED_COLUMN_NOTE}" gekennzeichnet.`}
              >
                {changes.removed.map(questionItem)}
              </ChangeGroup>
            ) : null}

            {changes.added.length > 0 ? (
              <ChangeGroup
                title="Diese Fragen kommen hinzu"
                note="Bei den bisherigen Antworten bleiben sie leer."
              >
                {changes.added.map(questionItem)}
              </ChangeGroup>
            ) : null}

            {changes.typeChanged.length > 0 ? (
              <ChangeGroup
                title="Diese Fragen wechseln den Typ"
                note="Die bisherigen Antworten bleiben bei der alten Frage; die neue Frage beginnt leer."
              >
                {changes.typeChanged.map((change) => (
                  <li key={change.id}>
                    {change.label}{' '}
                    <span className="publish-notice__type">
                      {QUESTION_TYPE_LABELS[change.from]}
                      <span aria-hidden="true"> → </span>
                      <span className="visually-hidden"> wird zu </span>
                      {QUESTION_TYPE_LABELS[change.to]}
                    </span>
                  </li>
                ))}
              </ChangeGroup>
            ) : null}
          </div>
        )}

        <div className="publish-notice__actions">
          <button
            type="button"
            className="publish-notice__cancel"
            // Cancelling a publish that is already on its way would claim
            // something this dialog cannot do.
            disabled={busy}
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="publish-notice__confirm"
            // Nothing to confirm while the list describes another draft; the
            // way on is to close this and press publish again. `blocked` is the
            // harder case: the server would refuse this publish — for a
            // dangling placeholder  *or* for a Bedingung
            // whose source no longer resolves (the requirement) — so the
            // button is not offered at all. It asks the length, not the kinds,
            // which is why a third kind needs nothing here.
            disabled={outdated || busy || blocked.length > 0}
            onClick={onConfirm}
          >
            {busy ? 'Wird veröffentlicht…' : 'Erneut veröffentlichen'}
          </button>
        </div>
      </div>
    </div>
  );
}

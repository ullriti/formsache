import type { ReactElement, SyntheticEvent } from 'react';
import { useId, useState } from 'react';
import {
  AI_MONTHLY_CALL_LIMIT_MAX,
  type TenantOverviewRow,
} from '@formsache/shared';

import { useSetAiQuota } from '../../api/admin';
import { ApiError } from '../../api/http';
import { useServerDraft } from '../../hooks/use-server-draft';
import { actionErrorMessage } from '../api-messages';

/**
 * **„KI-Kontingent je Organisation"** — the section of the superadmin overview the
 * monthly call limit is set in (Konzept no. 7 and no. 86).
 *
 * ## Why a section of its own and not a further column
 *
 * The organisation table above it is fixed in the handoff and is compared
 * against it view by view. An additional column would produce
 * a deviation there that nobody commissioned — and an input field together with
 * a save button in a row whose remaining cells are pure display would
 * anyway be the most restless place one can put either of them. The blueprint is
 * `DeletedTenantsSection`: additive, own head, same style.
 *
 * ## Why the superadmin and not the organisation
 *
 * Konzept no. 86: the number determines a **bill of the operator**. An
 * organisation admin who were allowed to raise it would be a cost lever without
 * a guard. That is why the write path lies behind `SuperadminGuard`
 * (`PUT /admin/tenants/:tenantId/ai-quota`) and not in the organisation
 * administration. This section is the surface to exactly this route and to no
 * other.
 *
 * ## What the sentence under the heading has to achieve
 *
 * `0` is valid and means **switched off**, not „unbegrenzt" — the expensive
 * misreading, and it falls in the wrong direction (`aiQuotaWriteSchema`). A
 * number field alone does not say that, so the sentence next to it says it,
 * together with the reference quantity (per calendar month) and the upper limit.
 *
 * ## One mutation per row
 *
 * Like `GroupCard` in `TenantGroupsEditor`: every row is a component of its own
 * with its own `useSetAiQuota()`. Thereby `isPending` and the error belong to
 * the row that produced it — a refusal at one organisation must not
 * overwrite a message at another (the same worry that
 * `DeletedTenantsSection` solves with a set of ids, because it renders its rows
 * inline).
 */
export function AiQuotaSection({
  rows,
}: {
  readonly rows: readonly TenantOverviewRow[];
}): ReactElement {
  return (
    <section
      className="superadmin__quota-section"
      aria-labelledby="superadmin-quota-heading"
    >
      <div className="superadmin__quota-head">
        <h2 className="superadmin__quota-title" id="superadmin-quota-heading">
          KI-Kontingent je Organisation
        </h2>
        <span
          className="superadmin__count"
          data-testid="superadmin-quota-count"
        >
          {rows.length}
        </span>
      </div>

      <p className="superadmin__quota-note">
        Die Zahl gilt je Kalendermonat und beginnt am Monatsersten von vorn.{' '}
        <strong>
          0 schaltet die KI-Formularerzeugung für diese Organisation ab — es
          bedeutet nicht „unbegrenzt“.
        </strong>{' '}
        Höchstwert: {AI_MONTHLY_CALL_LIMIT_MAX.toLocaleString('de-DE')} Aufrufe.
      </p>

      {rows.length === 0 ? (
        <p className="superadmin__quota-empty">Keine Organisationen.</p>
      ) : (
        rows.map((row) => <AiQuotaRow key={row.tenant.id} row={row} />)
      )}
    </section>
  );
}

/**
 * One row: name, number field with the **current** value of the organisation, save.
 *
 * ## The draft is a string, not a number
 *
 * `<input type="number">` delivers `''` when the field is emptied, and
 * `Number('')` is `0` — of all things the off switch. A draft as `number` turned
 * "I have emptied the field" tacitly into "I switch this organisation off".
 * That is why what was typed stays typed, and the conversion happens exactly
 * once, on submitting.
 *
 * ## Who decides about valid and invalid
 *
 * **The server** — as everywhere in this application. `NumberSetting` says it
 * expressly for the settings fields ("what an impossible value produces is
 * a 400 that names this field"), `TenantDeleteConfirm` even has a
 * test for the fact that the typed-out name is *not* compared in the browser,
 * and `CONTRIBUTING.md` calls the client validation „reine UX, nie Wahrheit". A
 * negative number and a number above the upper limit therefore go out and
 * come back as a 400; `min`/`max` at the field are operating comfort for the
 * arrow keys and an announcement to assistive technology, no bouncer — see
 * `noValidate` at the form, without which the browser would be one after all.
 *
 * **One exception, and it is no validation**: an empty field is caught here.
 * Not because the rule would be better kept in the browser, but
 * because there is no number at all that one could send — were one to send `0`,
 * the browser would have *invented* a value that nobody typed, and the
 * most expensive one at that. That is the difference between "I check the rule of
 * the server in advance" and "I make up no input for myself".
 *
 * ## Why the 400 does not carry the words of the server
 *
 * The field messages of a 400 are Zod texts („Too big: expected number to be
 * <=10000") — English, and for a field with exactly two limits the
 * own sentence says more. The same division that `actionErrorMessage` makes
 * anyway: the server wins where a rule lives on it (409, 422), the
 * surface where it knows the situation.
 */
function AiQuotaRow({
  row,
}: {
  readonly row: TenantOverviewRow;
}): ReactElement {
  const setQuota = useSetAiQuota();
  const baseline = String(row.aiMonthlyCallLimit);
  const { draft, setDraft, beginSave } = useServerDraft<string>(
    row.tenant.id,
    baseline,
  );
  const shown = draft ?? baseline;
  /** Only the empty draft — see the paragraph "One exception" above. */
  const [emptyIssue, setEmptyIssue] = useState<string | null>(null);

  const fieldId = useId();
  const unitId = `${fieldId}-unit`;
  const issueId = `${fieldId}-issue`;

  const message =
    emptyIssue ??
    (setQuota.isError ? quotaErrorMessage(setQuota.error) : undefined);

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const typed = shown.trim();
    if (typed === '') {
      setEmptyIssue(
        'Bitte eine Zahl eintragen. 0 schaltet die KI für diese Organisation ab — ein leeres Feld tut das nicht von selbst.',
      );
      return;
    }
    setEmptyIssue(null);
    setQuota.mutate(
      { tenantId: row.tenant.id, monthlyCallLimit: Number(typed) },
      { onSuccess: beginSave() },
    );
  };

  return (
    <form
      className="superadmin__quota-row"
      data-testid="superadmin-quota-row"
      // **`noValidate`, and that is the core of the decision above, not a
      // detail beside it.** `min`/`max` at the field are there for the number
      // stepper and for the announcement to assistive technology
      // (`aria-valuemin`/`-valuemax`). Without
      // `noValidate` the browser makes a bouncer out of them: it holds the
      // submitting back and shows a speech bubble of its own — in *its* language,
      // fleeting, without `role="alert"`, and in jsdom completely invisible
      // (there simply no `submit` event occurs, which made this test red on the
      // first run). A refusal on this surface looks
      // like every other refusal of this application, and it comes from the
      // server.
      noValidate
      onSubmit={onSubmit}
    >
      <div className="superadmin__quota-identity">
        <label className="superadmin__quota-name" htmlFor={fieldId}>
          {row.tenant.name}
        </label>
        <p className="superadmin__quota-meta">{row.tenant.shortName}</p>
      </div>

      <span className="superadmin__quota-control">
        <input
          className="superadmin__quota-input"
          id={fieldId}
          type="number"
          inputMode="numeric"
          min={0}
          max={AI_MONTHLY_CALL_LIMIT_MAX}
          step={1}
          value={shown}
          aria-describedby={
            message === undefined ? unitId : `${unitId} ${issueId}`
          }
          aria-invalid={message === undefined ? undefined : true}
          onChange={(event) => {
            setDraft(event.target.value);
            setEmptyIssue(null);
            if (setQuota.isError) {
              // A refusal that stays standing next to a field that has
              // meanwhile changed describes an input that no longer exists.
              setQuota.reset();
            }
          }}
        />
        <span className="superadmin__quota-unit" id={unitId}>
          Aufrufe je Monat
        </span>
      </span>

      <button
        type="submit"
        className="superadmin__quota-save"
        // The visible text stands at the front of the accessible name
        // (WCAG 2.5.3), the organisation behind it — otherwise every button in
        // this section would be named alike.
        aria-label={`Speichern — KI-Kontingent für ${row.tenant.name}`}
        disabled={setQuota.isPending}
      >
        {setQuota.isPending ? 'Wird gespeichert…' : 'Speichern'}
      </button>

      {message === undefined ? null : (
        <p className="superadmin__quota-error" id={issueId} role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

/**
 * Why the setting was refused.
 *
 * The 400 gets a German sentence of its own instead of the Zod message of the
 * server (see the docblock of the row); everything else goes through
 * `actionErrorMessage`, so that 403 and 404 do not sound different here than on
 * every other superadmin surface.
 */
function quotaErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return `Bitte eine ganze Zahl zwischen 0 und ${AI_MONTHLY_CALL_LIMIT_MAX.toLocaleString('de-DE')} eintragen.`;
  }
  return actionErrorMessage(error, {
    forbidden: 'Diese Ansicht ist Superadmins vorbehalten.',
    failed: 'Das Speichern ist fehlgeschlagen. Bitte erneut versuchen.',
    missing: 'Diese Organisation gibt es nicht mehr.',
  });
}

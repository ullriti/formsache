import type { ReactElement } from 'react';

import { useForm } from '../api/forms';
import { useFormMembers, useSaveFormMember } from '../api/form-members';
import { ApiError } from '../api/http';
import { useSession } from '../api/session';
import { useTenantGroups } from '../api/tenant-admin';
import { DASHBOARD_PATH, TENANT_MEMBERS_PATH } from '../router/routes';
import { navigate } from '../router/use-route';
import { FormMemberRow } from './form-members/FormMemberRow';
import { PermissionMatrix } from './form-members/PermissionMatrix';
import { RoleLegend } from './form-members/RoleLegend';

import './form-members-view.css';

export interface FormMembersViewProps {
  readonly formId: string;
}

/**
 * Nutzerrechte je Formular.
 *
 * **Behind the whole chain, including the link it configures.**
 * `FormRestrictionGuard` runs on `GET`/`PUT /forms/:formId/members` too, so
 * somebody whose own access to this form was revoked gets the same 404 the
 * form itself gives them — this view has nothing special to say about that
 * case, it just shows the same „not found" every other form-scoped page shows.
 */
export function FormMembersView({
  formId,
}: FormMembersViewProps): ReactElement {
  const membersQuery = useFormMembers(formId);
  const formQuery = useForm(formId);
  const session = useSession();
  /**
   * The same hook and the same cache key tenant administration uses — the
   * groups of the **active** Organisation, scoped by its id (see `api/form-members.ts`
   * on why this page no longer has a hook of its own). A failure here degrades
   * the page rather than blocking it: the member list and the switches are this
   * page's job, the matrix is a reference next to it.
   */
  const groupsQuery = useTenantGroups(
    session.data?.activeTenantId ?? undefined,
  );
  const save = useSaveFormMember(formId);

  // Captured before any narrowing, like `SuperadminView`'s `document`:
  // a query result's own `data` narrows to "never undefined" the moment
  // `isError` is known false, which would make the `undefined` check below a
  // type error rather than the runtime guard it has to be for the case that
  // actually needs it — a query that has not settled yet.
  const list = membersQuery.data;
  const form = formQuery.data;
  const groupDetails = groupsQuery.data;

  if (membersQuery.isPending) {
    return (
      <div className="form-members">
        <p className="form-members__state" role="status">
          Nutzerrechte werden geladen…
        </p>
      </div>
    );
  }

  if (list === undefined) {
    const notFound =
      membersQuery.error instanceof ApiError &&
      membersQuery.error.status === 404;
    const forbidden =
      membersQuery.error instanceof ApiError &&
      membersQuery.error.status === 403;
    return (
      <div className="form-members">
        <p className="form-members__state" role="alert">
          {notFound
            ? 'Dieses Formular wurde nicht gefunden.'
            : forbidden
              ? 'Diese Rolle darf die Nutzerrechte dieses Formulars nicht verwalten.'
              : 'Die Nutzerrechte konnten nicht geladen werden.'}{' '}
          <button
            type="button"
            className="form-members__link"
            onClick={() => {
              navigate(DASHBOARD_PATH);
            }}
          >
            Zurück zum Dashboard
          </button>
        </p>
      </div>
    );
  }

  const { members, groups } = list;
  const activeTenant = session.data?.memberships.find(
    (membership) => membership.tenant.id === session.data?.activeTenantId,
  )?.tenant;
  const withAccess = members.filter(
    (member) => !member.restrictable || !member.accessRevoked,
  ).length;

  return (
    <div className="form-members">
      <div className="form-members__head">
        <h1 className="form-members__title">Nutzerrechte</h1>
        <p className="form-members__subtitle">
          Zugriff auf dieses Formular
          {form === undefined ? '' : ` · ${form.title}`}
        </p>
      </div>

      <div className="form-members__banner">
        <span className="form-members__banner-icon" aria-hidden="true">
          ↳
        </span>
        <p className="form-members__banner-text">
          Die Personen kommen aus der Nutzerverwaltung
          {activeTenant === undefined
            ? ''
            : ` der Organisation „${activeTenant.name}“`}
          . Hier lässt sich der Zugriff pro Person{' '}
          <strong>für dieses Formular</strong> einschränken. Administratoren
          sehen immer jedes Formular.
        </p>
        <button
          type="button"
          className="form-members__banner-action"
          onClick={() => {
            navigate(TENANT_MEMBERS_PATH);
          }}
        >
          Tenant-Nutzer verwalten
        </button>
      </div>

      <RoleLegend
        groups={groups}
        members={members}
        groupDetails={groupDetails?.groups}
      />

      <section className="form-members__list-card">
        <div className="form-members__list-head">
          {withAccess} von {members.length} Personen haben Zugriff
        </div>
        <ul className="form-members__list">
          {members.map((member) => (
            <FormMemberRow
              key={member.userId}
              formId={formId}
              member={member}
              groups={groups}
              isSelf={member.userId === session.data?.id}
              save={save}
            />
          ))}
        </ul>
      </section>

      {groupDetails === undefined ? null : (
        <PermissionMatrix groups={groupDetails.groups} />
      )}

      <p className="form-members__footnote">
        Einschränkungen gelten nur für dieses Formular. Neue Personen werden auf
        Tenant-Ebene angelegt.
      </p>
    </div>
  );
}

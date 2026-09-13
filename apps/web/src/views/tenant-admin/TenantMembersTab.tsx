import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  USER_PASSWORD_MIN,
  type AccountKind,
  type GroupSummary,
  type TenantMember,
  type TenantMemberCreate,
} from '@formsache/shared';

import { ApiError } from '../../api/http';
import {
  useCreateTenantMember,
  useOidcConfig,
  useRemoveTenantMember,
  useResendTenantMemberInvitation,
  useRevokeMemberSessions,
  useSetTenantMemberPassword,
  useTenantGroups,
  useTenantMembers,
  useUpdateTenantMember,
} from '../../api/tenant-admin';
import type { CustomPropertyStyle } from '../../styles/custom-property-style';
import { inkOn } from '../../styles/readable-ink';
import { actionErrorMessage, fieldIssues } from '../api-messages';
import { initials } from '../initials';
import { ConfirmPrompt } from './ConfirmPrompt';
import { TenantGroupsEditor } from './TenantGroupsEditor';

/**
 * Nutzerrechte (Tenant-Ebene) — the requirement, handoff.
 *
 * The list, „Person hinzufügen" and the group editor share one organisation's groups
 * (`useTenantGroups`), which is why they live in one component rather than
 * three: the role select of every row and the create form both need the same
 * list, and fetching it twice would only risk it disagreeing with itself for
 * one frame after a group is renamed.
 */
export function TenantMembersTab({
  tenantId,
  currentUserId,
  sections = 'all',
}: {
  readonly tenantId: string;
  readonly currentUserId: string;
  /**
   * Which of the two halves are shown — default: both.
   *
   * The tab shows „everything"; the organisation wizard (ADR-0025) makes
   * **two** steps out of it, because „who is on board?" and „what may a role
   * do?" are two questions and a step that asks both at once is the step one
   * skips. One parameter and not a second view: the lists, the role select and
   * the group editor are not supposed to drift apart — they live off **the
   * same** group list anyway, and fetching it twice would mean letting them
   * contradict each other for the length of one frame.
   */
  readonly sections?: 'all' | 'people' | 'groups';
}): ReactElement {
  const members = useTenantMembers(tenantId);
  const groups = useTenantGroups(tenantId);
  /**
   * Best-effort only. This tab needs `canManageUsers`, not `canManageSettings`
   * — the OIDC block itself requires both (`TenantOidcSection`) — so a caller
   * without the second flag gets a 403 here and simply cannot know whether SSO
   * is switched on. That is fine: the UI's guess only decides whether the
   * „OIDC-Konto"-button looks disabled, never whether a create request
   * succeeds — the server refuses a disallowed `kind: 'oidc'` with 422 either
   * way („die Oberfläche ist Komfort").
   */
  const oidcConfig = useOidcConfig(tenantId);
  const oidcKnownDisabled = oidcConfig.data?.enabled === false;

  const memberDocument = members.data;
  const groupDocument = groups.data;

  if (members.isPending || groups.isPending) {
    return (
      <p className="settings__state" role="status">
        Nutzerrechte werden geladen…
      </p>
    );
  }

  if (memberDocument === undefined || groupDocument === undefined) {
    const forbidden =
      (members.error instanceof ApiError && members.error.status === 403) ||
      (groups.error instanceof ApiError && groups.error.status === 403);
    return (
      <p className="settings__state" role="alert">
        {forbidden
          ? 'Diese Rolle darf die Nutzerrechte dieser Organisation nicht sehen.'
          : 'Die Nutzerrechte konnten nicht geladen werden.'}
      </p>
    );
  }

  const memberList = memberDocument.members;
  const groupList = groupDocument.groups;

  return (
    <div className="tenant-admin__tab">
      {sections === 'groups' ? null : (
        <>
          <section
            className="settings-card"
            aria-labelledby="tenant-admin-members"
          >
            <header className="settings-card__head">
              <div className="settings-card__text">
                <h2
                  className="settings-card__heading"
                  id="tenant-admin-members"
                >
                  {memberList.length}{' '}
                  {memberList.length === 1 ? 'Person' : 'Personen'} im
                  Organisation
                </h2>
              </div>
            </header>
            <ul className="tenant-admin__member-list">
              {memberList.map((member) => (
                <MemberRow
                  key={member.userId}
                  tenantId={tenantId}
                  member={member}
                  groups={groupList}
                  isYou={member.userId === currentUserId}
                />
              ))}
            </ul>
          </section>

          <AddMemberForm
            tenantId={tenantId}
            groups={groupList}
            oidcKnownDisabled={oidcKnownDisabled}
          />
        </>
      )}

      {sections === 'people' ? null : (
        <TenantGroupsEditor tenantId={tenantId} groups={groupList} />
      )}
    </div>
  );
}

/**
 * One person in the organisation.
 *
 * **Nothing here re-decides what the server decides.** The prototype disables
 * one's own role select and hides one's own „Entfernen", and that reads like a
 * rule but is not one: the server refuses exactly one case — the **last**
 * administrator of an organisation (409, `users.service.ts`) — and lets an admin who has
 * a colleague step down or leave. A page that forbids more than the server does
 * is a page that lies about the rule, and it locks in the one situation nobody
 * wants: the only way out of an admin seat would be to ask somebody else to do
 * it for you.
 *
 * What replaces the greyed-out control is a **confirmation**, for the two
 * actions that affect the person doing them and for every removal — those are
 * the losses that cannot be clicked back.
 */
function MemberRow({
  tenantId,
  member,
  groups,
  isYou,
}: {
  readonly tenantId: string;
  readonly member: TenantMember;
  readonly groups: readonly GroupSummary[];
  readonly isYou: boolean;
}): ReactElement {
  const updateMember = useUpdateTenantMember();
  const remove = useRemoveTenantMember();
  const revokeSessions = useRevokeMemberSessions();
  /** A role change of one's own row, waiting for the confirmation. */
  const [pendingGroupId, setPendingGroupId] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  /** The unfolded form for name, address and password of this row. */
  const [editing, setEditing] = useState(false);
  /** The number from the response — the confirmation that makes up this action. */
  const [revoked, setRevoked] = useState<number | null>(null);

  /**
   * A change to this member — **always all three fields**.
   *
   * `PUT` is a statement about the target state (`tenantMemberUpdateSchema`), so
   * every action here sends the complete state: the role from the select field,
   * name and address from the form or unchanged from the row. The server checks
   * only what **really** changes — whoever sends the same address back gets no
   * refusal for a change they are not making.
   */
  const save = (
    change: { groupId?: string; name?: string; email?: string },
    onDone?: () => void,
  ): void => {
    updateMember.mutate(
      {
        tenantId,
        userId: member.userId,
        update: {
          groupId: change.groupId ?? member.group.id,
          name: change.name ?? member.name,
          email: change.email ?? member.email,
        },
      },
      // `exactOptionalPropertyTypes`: `{ onSuccess: undefined }` is something
      // other than „no option", so the option is left out instead of set to
      // undefined.
      onDone === undefined ? undefined : { onSuccess: onDone },
    );
  };

  const changeGroup = (groupId: string): void => {
    save({ groupId }, () => {
      setPendingGroupId(null);
    });
  };

  return (
    <li className="tenant-admin__member-row">
      <span
        className="tenant-admin__avatar"
        style={
          {
            '--tenant-admin-avatar': member.group.color,
            // The initials sit *on* the organisation's group colour, so their ink
            // follows it — see `readable-ink.ts`.
            '--tenant-admin-group-ink': inkOn(member.group.color),
          } as CustomPropertyStyle
        }
        aria-hidden="true"
      >
        {initials(member.name)}
      </span>

      <div className="tenant-admin__member-text">
        <div className="tenant-admin__member-name">
          <span>{member.name}</span>
          {isYou ? <span className="tenant-admin__badge">Sie</span> : null}
          <AccountKindBadge kind={member.accountKind} />
        </div>
        <div className="tenant-admin__member-meta">{member.email}</div>
      </div>

      <select
        className="tenant-admin__role-select"
        aria-label={`Rolle von ${member.name}`}
        value={pendingGroupId ?? member.group.id}
        disabled={updateMember.isPending}
        onChange={(event) => {
          const groupId = event.target.value;
          if (isYou) {
            // Own role: ask first — the permissions given up apply immediately,
            // and the way back may need somebody else.
            setPendingGroupId(groupId);
            return;
          }
          changeGroup(groupId);
        }}
      >
        {groups.map((group) => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </select>

      {/*
        **Force sign-out** (a review finding) — the only handle against a
        betrayed password that this application knows. It stands next to the
        removal, because both answer the same question („this person is not
        supposed to be working right now"), and it is the weaker of the two: the
        membership stays.
      */}
      {/*
        **Edit** (finding 12) — name, address and password of this person.
        Unfoldable instead of always visible: the list is the overview „who works
        here", and three input fields per row make a form out of it.
      */}
      <button
        type="button"
        className="tenant-admin__edit"
        title="Bearbeiten"
        aria-label={`${member.name} bearbeiten`}
        aria-expanded={editing}
        onClick={() => {
          setEditing((open) => !open);
        }}
      >
        <span aria-hidden="true">✎</span>
      </button>

      <button
        type="button"
        className="tenant-admin__revoke"
        title="Überall abmelden"
        aria-label={`${member.name} überall abmelden`}
        disabled={revokeSessions.isPending}
        onClick={() => {
          setRevoked(null);
          setConfirmingRevoke(true);
        }}
      >
        <span aria-hidden="true">⏻</span>
      </button>

      <button
        type="button"
        className="tenant-admin__remove"
        title="Entfernen"
        aria-label={`${member.name} entfernen`}
        disabled={remove.isPending}
        onClick={() => {
          setConfirmingRemove(true);
        }}
      >
        ×
      </button>

      {editing ? (
        <MemberAccountForm
          tenantId={tenantId}
          member={member}
          isSaving={updateMember.isPending}
          onSave={(next, onDone) => {
            save(next, onDone);
          }}
        />
      ) : null}

      {pendingGroupId === null ? null : (
        <div className="tenant-admin__row-confirm">
          <ConfirmPrompt
            question={`Sie ändern Ihre eigene Rolle zu „${groupNameOf(groups, pendingGroupId)}“. Rechte, die Sie damit abgeben, gelten sofort.`}
            confirmLabel="Rolle ändern"
            // Not a deletion, but not takeable back either: the rights given
            // away here can be exactly the ones needed to give them back.
            tone="destructive"
            isPending={updateMember.isPending}
            onConfirm={() => {
              changeGroup(pendingGroupId);
            }}
            onCancel={() => {
              setPendingGroupId(null);
            }}
          />
        </div>
      )}

      {confirmingRemove ? (
        <div className="tenant-admin__row-confirm">
          <ConfirmPrompt
            /*
             * **Phrased conditionally, and that is not a matter of style** .
             *
             * Whoever is removed from their last organisation loses their
             * account — that belongs in the dialog. But „this person is in no
             * other organisation" is itself a cross-organisation piece of
             * information: showing it would reveal to an organisation admin
             * whether somebody is a member elsewhere, and that is exactly the
             * boundary the project defends everywhere else. The sentence
             * therefore names the **condition** and asks the server for
             * nothing: it reads the same for somebody with five organisations
             * and for somebody with one.
             *
             * The clause about the system administration stands there because
             * `deleteHomelessAccount` has it in the `where` (`isSuperadmin:
             * false`). Without it the sentence would be a promise that the code
             * does not keep — and `membership.isSuperadmin` is deliberately not
             * available to the list here, because that too would be a piece of
             * information about the installation.
             */
            question={
              isYou
                ? 'Du trägst dich selbst aus dieser Organisation aus. Danach kommst du nur über eine andere Person wieder hinein. Ist dies deine letzte Organisation und verwaltest du das System nicht, wird auch dein Konto gelöscht – mit Passwort bzw. SSO-Verknüpfung.'
                : `„${member.name}“ wird aus dieser Organisation entfernt. Formulare und Antworten bleiben, die Person verliert den Zugang. Ist dies ihre letzte Organisation und verwaltet sie das System nicht, wird auch ihr Konto gelöscht – sie braucht dann eine neue Einladung.`
            }
            confirmLabel="Entfernen"
            tone="destructive"
            isPending={remove.isPending}
            onConfirm={() => {
              remove.mutate(
                { tenantId, userId: member.userId },
                {
                  onSuccess: () => {
                    setConfirmingRemove(false);
                  },
                },
              );
            }}
            onCancel={() => {
              setConfirmingRemove(false);
            }}
          />
        </div>
      ) : null}

      {confirmingRevoke ? (
        <div className="tenant-admin__row-confirm">
          <ConfirmPrompt
            question={`Alle Sitzungen von ${member.name} beenden? Die Person bleibt Mitglied und muss sich neu anmelden — auch in jeder anderen Organisation, in der sie arbeitet.`}
            confirmLabel="Überall abmelden"
            tone="destructive"
            isPending={revokeSessions.isPending}
            onConfirm={() => {
              revokeSessions.mutate(
                { tenantId, userId: member.userId },
                {
                  onSuccess: (result) => {
                    setConfirmingRevoke(false);
                    setRevoked(result.revoked);
                  },
                },
              );
            }}
            onCancel={() => {
              setConfirmingRevoke(false);
            }}
          />
        </div>
      ) : null}

      {revoked === null ? null : (
        <p className="tenant-admin__row-note" role="status">
          {revoked === 0
            ? `${member.name} war nirgends angemeldet.`
            : `${String(revoked)} Sitzung${revoked === 1 ? '' : 'en'} von ${member.name} beendet.`}
        </p>
      )}

      {revokeSessions.isError ? (
        <p className="settings__alert tenant-admin__row-alert" role="alert">
          {memberActionErrorMessage(revokeSessions.error)}
        </p>
      ) : null}
      {updateMember.isError ? (
        <p className="settings__alert tenant-admin__row-alert" role="alert">
          {memberActionErrorMessage(updateMember.error)}
        </p>
      ) : null}
      {remove.isError ? (
        <p className="settings__alert tenant-admin__row-alert" role="alert">
          {memberActionErrorMessage(remove.error)}
        </p>
      ) : null}
    </li>
  );
}

/**
 * **Name, address and password of a member** (finding 12).
 *
 * ## Why the password has a button of its own and does not sit in the save
 *
 * Because it is a different action. A name is saved; a password is **set**, and
 * that ends every session of the person in doing so — in every other
 * organisation they work in as well. An effect of that size does not belong in
 * a button that says „Speichern", and the response to it is a number that one
 * reads afterwards.
 *
 * ## What this surface does **not** decide
 *
 * Whether an address change is allowed. That hangs on things this list
 * deliberately does not know — whether the account also works elsewhere,
 * whether it carries the system administration —, and both are pieces of
 * information about the installation that an organisation does not get (the
 * same line the removal query draws: it names the *condition*, never the
 * finding). The fields therefore stand there open, and the server answers with
 * its own sentence if it does not work. For an SSO account the badge in the row
 * is the hint that a human reads beforehand.
 */
function MemberAccountForm({
  tenantId,
  member,
  isSaving,
  onSave,
}: {
  readonly tenantId: string;
  readonly member: TenantMember;
  readonly isSaving: boolean;
  readonly onSave: (
    change: { name: string; email: string },
    onDone: () => void,
  ) => void;
}): ReactElement {
  const setPassword = useSetTenantMemberPassword();
  const resendInvitation = useResendTenantMemberInvitation();
  const [name, setName] = useState(member.name);
  const [email, setEmail] = useState(member.email);
  const [password, setPassword_] = useState('');
  const [saved, setSaved] = useState(false);
  const [revoked, setRevoked] = useState<number | null>(null);
  const [invitationSent, setInvitationSent] = useState(false);

  const dirty = name.trim() !== member.name || email.trim() !== member.email;

  return (
    <div className="tenant-admin__row-edit">
      <div className="setting__field">
        <label
          className="setting__label"
          htmlFor={`member-name-${member.userId}`}
        >
          Name
        </label>
        <input
          className="setting__control"
          id={`member-name-${member.userId}`}
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
        />
      </div>

      <div className="setting__field">
        <label
          className="setting__label"
          htmlFor={`member-email-${member.userId}`}
        >
          E-Mail-Adresse
        </label>
        <input
          className="setting__control"
          id={`member-email-${member.userId}`}
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setSaved(false);
          }}
        />
        <p className="tenant-admin__readonly">
          Die Adresse ist der Anmeldeschlüssel. Sie lässt sich nur an einem
          lokalen Konto ändern, das dieser Organisation allein gehört.
        </p>
      </div>

      <button
        type="button"
        className="settings__save"
        disabled={isSaving || !dirty}
        onClick={() => {
          onSave({ name: name.trim(), email: email.trim() }, () => {
            setSaved(true);
          });
        }}
      >
        {isSaving ? 'Wird gespeichert…' : 'Speichern'}
      </button>
      {saved ? (
        <p className="tenant-admin__row-note" role="status">
          ✓ Gespeichert.
        </p>
      ) : null}

      <div className="setting__field">
        <label
          className="setting__label"
          htmlFor={`member-password-${member.userId}`}
        >
          Neues Passwort setzen
        </label>
        <input
          className="setting__control"
          id={`member-password-${member.userId}`}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => {
            setPassword_(event.target.value);
            setRevoked(null);
          }}
        />
        <p className="tenant-admin__readonly">
          Mindestens {USER_PASSWORD_MIN} Zeichen. Beim Setzen werden{' '}
          <strong>alle</strong> Sitzungen dieser Person beendet — sie muss sich
          überall neu anmelden, auch in jeder anderen Organisation.
        </p>
      </div>

      <button
        type="button"
        className="settings__save"
        disabled={setPassword.isPending || password.length < USER_PASSWORD_MIN}
        onClick={() => {
          setPassword.mutate(
            { tenantId, userId: member.userId, password },
            {
              onSuccess: (result) => {
                setPassword_('');
                setRevoked(result.revoked);
              },
            },
          );
        }}
      >
        {setPassword.isPending ? 'Wird gesetzt…' : 'Passwort setzen'}
      </button>

      {setPassword.isError ? (
        <p className="settings__alert tenant-admin__row-alert" role="alert">
          {memberActionErrorMessage(setPassword.error)}
        </p>
      ) : revoked === null ? null : (
        <p className="tenant-admin__row-note" role="status">
          {revoked === 0
            ? '✓ Passwort gesetzt. Die Person war nirgends angemeldet.'
            : `✓ Passwort gesetzt, ${String(revoked)} Sitzung${revoked === 1 ? '' : 'en'} beendet.`}
        </p>
      )}

      {/*
        **„Einladung erneut senden" stands with every member, and the server
        decides** (ADR-0024).

        The list does not know whether this account has already set its password
        — `tenantMemberSchema` does not carry that, and to take it in for this
        purpose would mean fetching the password hash into the projection of the
        member list, which deliberately does not know it (`MEMBER_VIEW_SELECT`).
        So the same build as with the address change one section higher: the
        button stands there open, and if it does not work, the server answers
        with its own sentence.
      */}
      <div className="setting__field">
        <span className="setting__label">Einladung</span>
        <p className="tenant-admin__readonly">
          Verschickt die Einladung noch einmal — für eine Person, die ihr
          Passwort noch nie gesetzt hat oder deren Link abgelaufen ist. Ein
          Konto, das schon eingerichtet ist, lehnt der Server ab.
        </p>
      </div>

      <button
        type="button"
        className="settings__save"
        disabled={resendInvitation.isPending}
        onClick={() => {
          setInvitationSent(false);
          resendInvitation.mutate(
            { tenantId, userId: member.userId },
            {
              onSuccess: () => {
                setInvitationSent(true);
              },
            },
          );
        }}
      >
        {resendInvitation.isPending
          ? 'Wird verschickt…'
          : 'Einladung erneut senden'}
      </button>

      {resendInvitation.isError ? (
        <p className="settings__alert tenant-admin__row-alert" role="alert">
          {memberActionErrorMessage(resendInvitation.error)}
        </p>
      ) : invitationSent ? (
        <p className="tenant-admin__row-note" role="status">
          ✓ Einladung an {member.email} verschickt.
        </p>
      ) : null}
    </div>
  );
}

function groupNameOf(groups: readonly GroupSummary[], groupId: string): string {
  return groups.find((group) => group.id === groupId)?.name ?? 'einer Gruppe';
}

/**
 * The label of every {@link AccountKind} — a `Record`, not a chain of
 * ternaries (a review finding): the nested-ternary shape fell
 * through to „Eingeladen" for a **fourth**, unanticipated value instead of
 * failing to compile, which is exactly backwards for a label an admin reads
 * to decide whether somebody can sign in yet. `Record<AccountKind, string>`
 * has to name all three; a fourth value added to the schema tomorrow is a
 * type error here, not a silently wrong badge.
 */
const ACCOUNT_KIND_LABELS: Readonly<Record<AccountKind, string>> = {
  local: 'Lokal',
  oidc: 'OIDC',
  invited: 'Eingeladen',
};

/**
 * The „Lokal"/„OIDC"/„Eingeladen" badge — three distinct looks for the three
 * values of {@link AccountKind}, not a third label squeezed onto the OIDC
 * badge's appearance. An unclaimed invitation is not an
 * account that has ever signed in, and the difference — „access is set up"
 * versus „waiting for the first sign-in" — is exactly what an admin looking at
 * this list wants to tell apart at a glance.
 */
function AccountKindBadge({
  kind,
}: {
  readonly kind: AccountKind;
}): ReactElement {
  const className = `tenant-admin__badge tenant-admin__badge--${kind}`;
  return <span className={className}>{ACCOUNT_KIND_LABELS[kind]}</span>;
}

/** Reads the server's own sentence where it has one — see `api-messages.ts`. */
function memberActionErrorMessage(error: unknown): string {
  return actionErrorMessage(error, {
    forbidden:
      'Diese Rolle darf die Mitglieder dieser Organisation nicht ändern.',
    conflict:
      'Das ist nicht möglich: der letzte Administrator einer Organisation kann nicht entfernt oder herabgestuft werden.',
    missing: 'Diese Person ist nicht (mehr) Mitglied dieser Organisation.',
    invalid: 'Diese Gruppe ist ungültig.',
    failed: 'Das ist fehlgeschlagen. Bitte erneut versuchen.',
  });
}

type InviteAuth = 'oidc' | 'local';

/**
 * „Person hinzufügen".
 *
 * **The role is pre-selected with the least powerful group, not the first one
 * in the list.** `GET /tenant/groups` answers by rank *descending*, so
 * `groups[0]` was `admin`: a form whose one-click path handed out the strongest
 * role in the organisation, in the surface whose whole subject is who may do what. The
 * prototype's own default is `viewer`, and „the lowest rank" is that rule
 * without hard-coding a group name an organisation may have renamed or deleted.
 */
function AddMemberForm({
  tenantId,
  groups,
  oidcKnownDisabled,
}: {
  readonly tenantId: string;
  readonly groups: readonly GroupSummary[];
  readonly oidcKnownDisabled: boolean;
}): ReactElement {
  const create = useCreateTenantMember();
  const [authKind, setAuthKind] = useState<InviteAuth>('local');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [groupId, setGroupId] = useState<string>(
    () => lowestRankGroup(groups)?.id ?? '',
  );
  /**
   * Who was added last — **and whether an invitation went out in doing so.**
   *
   * Both, because the two cases need different sentences: a new account gets an
   * invitation, an existing one is only attached to this organisation and signs
   * in with the password it already has. The server's response says it
   * (`invited`); from the member alone it could not be read off.
   */
  const [justAdded, setJustAdded] = useState<{
    readonly name: string;
    readonly invited: boolean;
    /**
     * Wie sich dieses Konto anmeldet — für den Satz beim **Anhängen**
     * (Review-Runde 3 Nr. 13).
     *
     * Der Befund kam als Frage: *„Was passiert, wenn ein Nutzer in mehreren
     * Orgas mit OIDC drin ist mit der gleichen E-Mail?"* Die Antwort ist:
     * `user.email` ist installationsweit eindeutig, es gibt also **ein**
     * Konto, und die zweite Organisation hängt sich eine Mitgliedschaft daran
     * (ADR-0012 Nr. 3). Die Anmeldung bleibt die, über die das Konto
     * entstanden ist — die Bindung ist das Paar *(Issuer, Subject)*, und ein
     * zweiter Anmeldedienst erreicht sie nicht.
     *
     * Die Meldung sagte für **beide** Fälle „die Anmeldung läuft mit dem
     * vorhandenen Passwort". Bei einem SSO-Konto ist das schlicht falsch: es
     * hat keins. Wer der Meldung glaubte, wartete auf ein Passwort, das nie
     * kommt — und suchte den Fehler bei der eigenen SSO-Einrichtung.
     */
    readonly accountKind: TenantMember['accountKind'];
  } | null>(null);

  const effectiveKind: InviteAuth = oidcKnownDisabled ? 'local' : authKind;
  const issues = fieldIssues(create.error);

  const submit = (): void => {
    if (groupId === '') {
      return;
    }
    const payload: TenantMemberCreate =
      effectiveKind === 'local'
        ? { kind: 'local', email, name, groupId }
        : { kind: 'oidc', email, name, groupId };

    create.mutate(
      { tenantId, create: payload },
      {
        onSuccess: (member) => {
          setName('');
          setEmail('');
          setJustAdded({
            name: member.name,
            invited: member.invited,
            accountKind: member.accountKind,
          });
        },
      },
    );
  };

  return (
    <section
      className="tenant-admin__invite"
      aria-labelledby="tenant-admin-invite"
    >
      <h2 className="tenant-admin__invite-title" id="tenant-admin-invite">
        Person hinzufügen
      </h2>

      <div className="tenant-admin__invite-kind">
        <button
          type="button"
          className={
            effectiveKind === 'oidc'
              ? 'tenant-admin__pill tenant-admin__pill--on'
              : 'tenant-admin__pill'
          }
          disabled={oidcKnownDisabled}
          title={
            oidcKnownDisabled
              ? 'OIDC-Anmeldung ist für diese Organisation deaktiviert'
              : undefined
          }
          onClick={() => {
            setAuthKind('oidc');
          }}
        >
          OIDC-Konto (SSO)
        </button>
        <button
          type="button"
          className={
            effectiveKind === 'local'
              ? 'tenant-admin__pill tenant-admin__pill--on'
              : 'tenant-admin__pill'
          }
          onClick={() => {
            setAuthKind('local');
          }}
        >
          Lokaler Nutzer
        </button>
      </div>

      <div className="tenant-admin__invite-fields">
        <div className="setting__field">
          <label className="setting__label" htmlFor="tenant-admin-invite-name">
            Name
          </label>
          <input
            className="setting__control"
            id="tenant-admin-invite-name"
            type="text"
            value={name}
            aria-invalid={issues.name === undefined ? undefined : true}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          {issues.name === undefined ? null : (
            <p className="setting__issue">{issues.name}</p>
          )}
        </div>

        <div className="setting__field">
          <label className="setting__label" htmlFor="tenant-admin-invite-email">
            E-Mail-Adresse
          </label>
          <input
            className="setting__control"
            id="tenant-admin-invite-email"
            type="email"
            value={email}
            /*
             * **The hint is wired to the field, not hung on it as a `title`.**
             * `aria-describedby` is read out when the field takes focus; a
             * `title` reaches the mouse and nobody else, and this sentence is
             * the difference between a login that works and one that is refused
             * with „kein Konto".
             *
             * Only in the OIDC case, because only there is the address a
             * matching key: an invitation is redeemed by comparing it to what
             * the provider reports as verified (ADR-0012 no. 3). A
             * local account is not matched against anybody's claim.
             */
            aria-describedby={
              effectiveKind === 'oidc'
                ? 'tenant-admin-invite-email-hint'
                : undefined
            }
            aria-invalid={issues.email === undefined ? undefined : true}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
          {effectiveKind === 'oidc' ? (
            <p className="setting__note" id="tenant-admin-invite-email-hint">
              Diese Adresse muss exakt der Adresse entsprechen, die der
              Anmeldedienst als verifiziert meldet – sonst wird die Anmeldung
              mit „kein Konto“ abgewiesen.
            </p>
          ) : null}
          {issues.email === undefined ? null : (
            <p className="setting__issue">{issues.email}</p>
          )}
        </div>

        <div className="setting__field">
          <label className="setting__label" htmlFor="tenant-admin-invite-group">
            Rolle
          </label>
          <select
            className="setting__control"
            id="tenant-admin-invite-group"
            value={groupId}
            aria-invalid={issues.groupId === undefined ? undefined : true}
            onChange={(event) => {
              setGroupId(event.target.value);
            }}
          >
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          {issues.groupId === undefined ? null : (
            <p className="setting__issue">{issues.groupId}</p>
          )}
        </div>
      </div>

      {/*
        **What happens after the click stands before the click** (ADR-0024). The
        sentence replaces the password field that stood here: whoever creates a
        person should know that the new person gets a mail and sets their
        password themselves — otherwise the creator waits for a password they
        never learn, and calls the person.

        `role` deliberately none: this is a standing explanation of the form, not
        a message about an event.
      */}
      <p className="tenant-admin__readonly" id="tenant-admin-invite-note">
        {effectiveKind === 'local'
          ? 'Die Person bekommt eine Einladung per Mail und setzt ihr Passwort selbst. Niemand sonst kennt es.'
          : 'Die Person bekommt eine Mail mit dem Hinweis, dass die Anmeldung über die SSO-Anmeldung dieser Organisation läuft. Ein Passwort gibt es dafür nicht.'}
      </p>

      <button
        type="button"
        className="settings__save"
        disabled={create.isPending || groupId === ''}
        aria-describedby="tenant-admin-invite-note"
        onClick={submit}
      >
        Hinzufügen
      </button>

      {create.isError ? (
        <p className="settings__alert" role="alert">
          {createMemberErrorMessage(create.error)}
        </p>
      ) : justAdded !== null ? (
        <p className="tenant-admin__flash" role="status">
          {justAdded.invited
            ? `✓ ${justAdded.name} wurde hinzugefügt und hat eine Einladung per Mail bekommen.`
            : justAdded.accountKind === 'local'
              ? `✓ ${justAdded.name} wurde hinzugefügt. Das Konto gab es schon — die Anmeldung läuft mit dem vorhandenen Passwort, es geht keine Einladung hinaus.`
              : `✓ ${justAdded.name} wurde hinzugefügt. Das Konto gab es schon. Es meldet sich weiterhin über den Anmeldedienst an, bei dem es entstanden ist — auch wenn diese Organisation einen anderen einträgt — und wechselt danach oben über die Organisationsauswahl hierher. Es geht keine Einladung hinaus.`}
        </p>
      ) : (
        <p className="tenant-admin__readonly">
          {oidcKnownDisabled
            ? 'OIDC-Anmeldung ist für diese Organisation deaktiviert – es können nur lokale Nutzer angelegt werden.'
            : effectiveKind === 'local'
              ? 'Lokaler Nutzer: meldet sich mit E-Mail & Passwort an – für Personen ohne Organisationskonto.'
              : 'OIDC-Nutzer: meldet sich über die SSO-Anmeldung der Organisation an.'}
        </p>
      )}
    </section>
  );
}

/** The least powerful group of the organisation — see {@link AddMemberForm}. */
function lowestRankGroup(
  groups: readonly GroupSummary[],
): GroupSummary | undefined {
  return groups.reduce<GroupSummary | undefined>(
    (lowest, group) =>
      lowest === undefined || group.rank < lowest.rank ? group : lowest,
    undefined,
  );
}

function createMemberErrorMessage(error: unknown): string {
  return actionErrorMessage(error, {
    forbidden: 'Diese Rolle darf keine Personen hinzufügen.',
    conflict: 'Diese Person ist bereits Mitglied dieser Organisation.',
    invalid:
      'Diese Gruppe ist ungültig, oder OIDC ist für diese Organisation gesperrt.',
    failed: 'Anlegen fehlgeschlagen. Bitte erneut versuchen.',
  });
}

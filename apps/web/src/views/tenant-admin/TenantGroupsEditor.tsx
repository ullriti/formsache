import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  ADMIN_GROUP_RANK,
  DEFAULT_TENANT_BRANDING,
  type GroupDetail,
  type GroupWrite,
  type Permissions,
} from '@formsache/shared';

import {
  useCreateTenantGroup,
  useRemoveTenantGroup,
  useUpdateTenantGroup,
} from '../../api/tenant-admin';
import { useServerDraft } from '../../hooks/use-server-draft';
import type { CustomPropertyStyle } from '../../styles/custom-property-style';
import { inkOn } from '../../styles/readable-ink';
import { actionErrorMessage } from '../api-messages';
import {
  PERMISSION_LABELS,
  PERMISSION_TOTAL,
  permissionCount,
} from '../permission-labels';
import { SettingsSaveBar } from '../settings/SettingsSaveBar';
import { groupColorNotes } from './color-contrast';
import { ColorContrastNotes } from './ColorContrastNotes';
import { ConfirmPrompt } from './ConfirmPrompt';

/**
 * Gruppen & Rechte (handoff).
 *
 * Nested under *Nutzerrechte (Tenant-Ebene)* exactly as the handoff draws it —
 * one organisation's list of groups is what the role selects of the member list above
 * offer, so the two are one surface rather than two that happen to be near
 * each other.
 *
 * **Every card owns its own draft.** A group write is a *whole* document
 * (`groupWriteSchema` is a `strictObject`, not a patch), so two cards editing
 * two different groups must never share one `useServerDraft` slot — that would
 * be the tenant-switch bug of `TenantFormDefaultsView` one level down, between
 * two *groups* of the same organisation instead of two Organisationen.
 */
export function TenantGroupsEditor({
  tenantId,
  groups,
}: {
  readonly tenantId: string;
  readonly groups: readonly GroupDetail[];
}): ReactElement {
  const create = useCreateTenantGroup();

  return (
    <section
      className="settings-card tenant-admin__groups"
      aria-labelledby="tenant-admin-groups"
    >
      <header className="settings-card__head">
        <div className="settings-card__text">
          <h2 className="settings-card__heading" id="tenant-admin-groups">
            Gruppen &amp; Rechte
          </h2>
          <p className="settings-card__hint">
            Eigene Gruppen anlegen und Rechte per Klick festlegen. Der
            Administrator hat immer alle Rechte.
          </p>
        </div>
      </header>

      <div className="tenant-admin__group-list">
        {groups.map((group) => (
          <GroupCard key={group.id} tenantId={tenantId} group={group} />
        ))}
      </div>

      <div className="tenant-admin__group-add">
        <button
          type="button"
          className="tenant-admin__stripe-add tenant-admin__group-add-button"
          disabled={create.isPending}
          onClick={() => {
            create.mutate({
              tenantId,
              write: {
                name: 'Neue Gruppe',
                // The tenant's own accent, not a literal picked here — every
                // colour in this file comes from data, never from a string in
                // source (`formsache/no-hardcoded-colors`).
                color: DEFAULT_TENANT_BRANDING.accent,
                rank: nextGroupRank(groups),
                permissions: NO_PERMISSIONS,
              },
            });
          }}
        >
          + Gruppe hinzufügen
        </button>
        {create.isError ? (
          <p className="settings__alert" role="alert">
            {groupErrorMessage(create.error)}
          </p>
        ) : null}
      </div>
    </section>
  );
}

const NO_PERMISSIONS: Permissions = {
  canBuild: false,
  canViewResponses: false,
  canExport: false,
  canManageSettings: false,
  canManageFormSettings: false,
  canManageUsers: false,
};

/**
 * The rank a new group starts at — **below every group that exists**, never a
 * fixed number.
 *
 * A hard-coded `10` collided with any Organisation that already had a group there, and
 * the collision is not cosmetic: roles are compared by rank, so two groups at
 * one rank make „wer ist höher" ambiguous and with it the per-form cap of
 * the requirement (`capOptions` offers „strictly below"). A fresh group with no
 * permissions belongs at the bottom anyway, which is where the prototype puts
 * a new role too.
 *
 * The floor is 0 (`groupWriteSchema`), so an organisation that already owns a group at
 * rank 0 gets the same rank back and the server answers — that is one taken
 * name away from the duplicate-name 409 it already has, and inventing a free
 * slot by shuffling other groups would be this page rewriting rows nobody asked
 * it to touch.
 */
function nextGroupRank(groups: readonly GroupDetail[]): number {
  const lowest = groups.reduce(
    (rank, group) => Math.min(rank, group.rank),
    ADMIN_GROUP_RANK,
  );
  return Math.max(0, Math.min(lowest - 1, ADMIN_GROUP_RANK - 1));
}

function groupDraftOf(group: GroupDetail): GroupWrite {
  return {
    name: group.name,
    color: group.color,
    rank: group.rank,
    permissions: { ...group.permissions },
  };
}

function groupDirty(group: GroupDetail, draft: GroupWrite): boolean {
  return (
    group.name !== draft.name ||
    group.color !== draft.color ||
    group.rank !== draft.rank ||
    PERMISSION_LABELS.some(
      ({ key }) => group.permissions[key] !== draft.permissions[key],
    )
  );
}

/**
 * One group card.
 *
 * **The system group gets an answer, not disabled controls.** Its name, colour,
 * rank and five pills used to render as `disabled` inputs — five promises of a
 * function that does not exist, which this project has ruled out: a
 * greyed-out control still says „hier könnte man etwas ändern", and the server
 * refuses the write outright (`SYSTEM_GROUP_MESSAGE`, 409). What stays is the
 * information — the tint, the name, which permissions it holds and the badge
 * „System · alle Rechte" — because *that* is what the card is for.
 */
function GroupCard({
  tenantId,
  group,
}: {
  readonly tenantId: string;
  readonly group: GroupDetail;
}): ReactElement {
  const update = useUpdateTenantGroup();
  const remove = useRemoveTenantGroup();
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const { draft, setDraft, beginSave } = useServerDraft<GroupWrite>(
    group.id,
    groupDraftOf(group),
  );
  const shown = draft ?? groupDraftOf(group);
  const dirty = groupDirty(group, shown);

  const tint = {
    '--tenant-admin-group-tint': shown.color,
    // The pills below are filled with the organisation's own colour, so the ink on them
    // cannot be one fixed value — see `readable-ink.ts`.
    '--tenant-admin-group-ink': inkOn(shown.color),
  } as CustomPropertyStyle;

  if (group.isSystem) {
    return (
      <div className="tenant-admin__group-card" style={tint}>
        <div className="tenant-admin__group-head">
          <span className="tenant-admin__group-dot" aria-hidden="true" />
          <span className="tenant-admin__group-name-static">{group.name}</span>
          <span className="tenant-admin__group-count">
            {permissionCount(group.permissions)}/{PERMISSION_TOTAL} Rechte
          </span>
          <span className="tenant-admin__badge tenant-admin__badge--system">
            System · alle Rechte
          </span>
        </div>

        <div className="tenant-admin__group-pills">
          {PERMISSION_LABELS.map(({ key, label, icon }) => (
            <span
              key={key}
              className={
                group.permissions[key]
                  ? 'tenant-admin__pill tenant-admin__pill--static tenant-admin__pill--group-on'
                  : 'tenant-admin__pill tenant-admin__pill--static'
              }
            >
              <span aria-hidden="true">{icon}</span> {label}
            </span>
          ))}
        </div>
      </div>
    );
  }

  /*
    What the automatic ink above **cannot** solve.

    Two holes, and the message says which: in the mid-tone neither ink is
    enough for the pills, and `PermissionMatrix` writes the group name in this
    colour as *text* on white — where there is no ink to switch at all. Both are
    **reported, not refused**: nothing below touches `dirty`, the save button or
    the mutation.

    Below the `isSystem` return on purpose. That card offers no colour picker
    („Auskunft statt abgeschalteter Bedienelemente"), so a note telling somebody
    to pick a different colour would name a control that is not there.
  */
  const colorNotes = groupColorNotes(shown.color);
  const noteId = `group-${group.id}-contrast`;

  return (
    <div className="tenant-admin__group-card" style={tint}>
      <div className="tenant-admin__group-head">
        <span className="tenant-admin__group-dot" aria-hidden="true" />
        <label className="tenant-admin__group-color">
          <span className="visually-hidden">Farbe von {group.name}</span>
          <input
            type="color"
            value={shown.color}
            // The message sits below this card's head row, where there is
            // room for a sentence; `aria-describedby` is what ties it back to
            // this input.
            aria-describedby={colorNotes.length === 0 ? undefined : noteId}
            onChange={(event) => {
              setDraft({ ...shown, color: event.target.value });
            }}
          />
        </label>
        <input
          className="tenant-admin__group-name"
          type="text"
          value={shown.name}
          aria-label={`Name der Gruppe ${group.name}`}
          onChange={(event) => {
            setDraft({ ...shown, name: event.target.value });
          }}
        />
        <label className="tenant-admin__group-rank">
          <span className="visually-hidden">Rang von {group.name}</span>
          <input
            type="number"
            min={0}
            max={ADMIN_GROUP_RANK - 1}
            value={shown.rank}
            onChange={(event) => {
              setDraft({ ...shown, rank: Number(event.target.value) });
            }}
          />
        </label>
        <span className="tenant-admin__group-count">
          {permissionCount(shown.permissions)}/{PERMISSION_TOTAL} Rechte
        </span>
        <button
          type="button"
          className="tenant-admin__remove"
          title="Gruppe löschen"
          aria-label={`Gruppe ${group.name} löschen`}
          disabled={remove.isPending}
          onClick={() => {
            setConfirmingRemove(true);
          }}
        >
          ×
        </button>
      </div>

      <ColorContrastNotes id={noteId} notes={colorNotes} />

      <div className="tenant-admin__group-pills">
        {PERMISSION_LABELS.map(({ key, label, icon }) => (
          <button
            key={key}
            type="button"
            className={
              shown.permissions[key]
                ? 'tenant-admin__pill tenant-admin__pill--group-on'
                : 'tenant-admin__pill'
            }
            aria-pressed={shown.permissions[key]}
            onClick={() => {
              setDraft({
                ...shown,
                permissions: {
                  ...shown.permissions,
                  [key]: !shown.permissions[key],
                },
              });
            }}
          >
            <span aria-hidden="true">
              {shown.permissions[key] ? '✓' : icon}
            </span>{' '}
            {label}
          </button>
        ))}
      </div>

      {confirmingRemove ? (
        <div className="tenant-admin__group-confirm">
          <ConfirmPrompt
            question={`Die Gruppe „${group.name}“ wird mit ihren Rechten gelöscht. Das lässt sich nicht rückgängig machen.`}
            confirmLabel="Gruppe löschen"
            tone="destructive"
            isPending={remove.isPending}
            onConfirm={() => {
              remove.mutate(
                { tenantId, groupId: group.id },
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

      <SettingsSaveBar
        isSaving={update.isPending}
        dirty={dirty}
        onSave={() => {
          update.mutate(
            { tenantId, groupId: group.id, write: shown },
            { onSuccess: beginSave() },
          );
        }}
      />
      {update.isError ? (
        <p className="settings__alert" role="alert">
          {groupErrorMessage(update.error)}
        </p>
      ) : null}
      {remove.isError ? (
        <p className="settings__alert" role="alert">
          {groupErrorMessage(remove.error)}
        </p>
      ) : null}
    </div>
  );
}

function groupErrorMessage(error: unknown): string {
  return actionErrorMessage(error, {
    forbidden: 'Diese Rolle darf die Gruppen dieser Organisation nicht ändern.',
    conflict:
      'Diese Gruppe lässt sich nicht ändern oder löschen — sie ist entweder die Systemgruppe oder hat noch Mitglieder.',
    failed: 'Das ist fehlgeschlagen. Bitte erneut versuchen.',
  });
}

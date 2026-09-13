import type { MailIdentityConfig, MailIdentityWrite } from '@formsache/shared';

/**
 * The draft of *Mailversand* (ADR-0013, ADR-0023) —
 * the same split `system-mail-draft.ts` and `tenant-admin-draft.ts` use: kept
 * next to the fields that build and read it, typed **without** a lock (this
 * document carries none — see `useSaveTenantSmtp`'s comment).
 */

/**
 * What „Passwort" carries in the draft — **two** states, not three.
 *
 * Like `SmtpPasswordDraft` in `system-mail-draft.ts` and unlike
 * `ClientSecretDraft`: there is no „entfernen" here either, because a relay
 * that wants no login is expressed by switching `authEnabled` off, which
 * removes the whole `auth` pair on the wire (`auth: null`). Absent
 * (`kind: 'keep'`) means „lass das gespeicherte Passwort stehen" — the
 * load-bearing promise behind the task's second trap (a save that only
 * changes the port must not clear a working password).
 */
export type SmtpPasswordDraft =
  { readonly kind: 'keep' } | { readonly kind: 'set'; readonly value: string };

/**
 * The whole card in one value — **`enabled` decides whether there is a block at
 * all**.
 *
 * Before, `source: 'system' | 'own'` stood here: the choice between „erbt vom
 * System" and „eigener Server". The inheritance is gone (ADR-0023), so the
 * choice is gone too — what remains is the switch „Mailserver eingerichtet",
 * exactly the one the system administration already has for its own block
 * (`SystemMailDraft.enabled`). Two tabs, the same question, the same
 * construction.
 *
 * The block fields stay standing while `enabled` is off: flipping the switch
 * twice must not wipe away what somebody has already typed, and
 * {@link mailIdentityWriteOf} drops them of its own accord.
 */
export interface MailIdentityDraft {
  /** Whether this organisation has a mail server. Off means: it does not send. */
  readonly enabled: boolean;
  readonly host: string;
  /** As typed; parsed and bounds-checked server-side, not duplicated here. */
  readonly port: string;
  readonly secure: boolean;
  readonly from: string;
  readonly authEnabled: boolean;
  readonly user: string;
  readonly password: SmtpPasswordDraft;
}

/**
 * What the fields show before anything has loaded, and — the load-bearing
 * case — while the stored block cannot be read at all (the
 * unreadable-stored-block finding, `smtp-config.service.ts`'s 500).
 *
 * `enabled: false` is the deliberate default for that repair state: a caller
 * who saves without touching anything clears the unreadable document in one
 * click — the cheapest way out of a broken row, and one whose consequence the
 * card states in plain words (diese Organisation verschickt dann nichts).
 * Whoever wants to type a fresh block in instead flips the switch. Either way
 * the `PUT` replaces the unreadable document completely.
 */
export const FRESH_MAIL_IDENTITY_DRAFT: MailIdentityDraft = {
  enabled: false,
  host: '',
  port: '',
  secure: true,
  from: '',
  authEnabled: false,
  user: '',
  password: { kind: 'keep' },
};

export function mailIdentityDraftOf(
  config: MailIdentityConfig,
): MailIdentityDraft {
  if (config.smtp === null) {
    return FRESH_MAIL_IDENTITY_DRAFT;
  }
  return {
    enabled: true,
    host: config.smtp.host,
    port: String(config.smtp.port),
    secure: config.smtp.secure,
    from: config.smtp.from,
    authEnabled: config.smtp.auth !== null,
    user: config.smtp.auth?.user ?? '',
    password: { kind: 'keep' },
  };
}

/** Whether saving `draft` would change anything the server has. */
export function mailIdentityDirty(
  config: MailIdentityConfig,
  draft: MailIdentityDraft,
): boolean {
  const stored = config.smtp;
  if (stored === null) {
    return draft.enabled;
  }
  if (!draft.enabled) {
    return true;
  }
  return (
    draft.host.trim() !== stored.host ||
    draft.port.trim() !== String(stored.port) ||
    draft.secure !== stored.secure ||
    draft.from.trim() !== stored.from ||
    draft.authEnabled !== (stored.auth !== null) ||
    (draft.authEnabled && draft.user.trim() !== (stored.auth?.user ?? '')) ||
    draft.password.kind !== 'keep'
  );
}

/**
 * The draft, as the wire's write contract wants it — the whole block, or
 * `smtp: null` (there is no field-by-field write to want).
 *
 * `port` is handed on as typed, parsed with `Number.parseInt` — an invalid
 * number becomes `NaN`, which the server's own schema refuses with the field
 * named; there is no reason to duplicate that bound here (`CONTRIBUTING.md`, „der Server validiert immer selbst").
 */
export function mailIdentityWriteOf(
  draft: MailIdentityDraft,
): MailIdentityWrite {
  if (!draft.enabled) {
    return { smtp: null };
  }
  return {
    smtp: {
      host: draft.host.trim(),
      port: Number.parseInt(draft.port, 10),
      secure: draft.secure,
      from: draft.from.trim(),
      auth: draft.authEnabled
        ? {
            user: draft.user.trim(),
            // Absent means „lass das gespeicherte Passwort stehen" — the
            // two-state contract `mailIdentityAuthWriteSchema` describes,
            // carried through rather than defaulted to a third, wrong state.
            ...(draft.password.kind === 'set'
              ? { password: draft.password.value }
              : {}),
          }
        : null,
    },
  };
}

import type { SystemMailSettings } from '@formsache/shared';

import type { SaveSystemMailSettingsVariables } from '../../api/system-settings';
import { trimmedOrNull } from '../trimmed-or-null';

/**
 * The draft of *Mailserver & Basis-Adresse*  — the
 * same split `tenant-admin-draft.ts` uses for the OIDC tab: kept next to the
 * fields that build and read it, typed **without** the lock, which
 * `useServerDraft` owns and carries alongside the loaded
 * document rather than as part of what an editor types.
 */

/**
 * What „Passwort" carries in the draft — **two** states, not three.
 *
 * Unlike `ClientSecretDraft` there is no „entfernen": a relay that wants no
 * login is expressed by switching `authEnabled` off, which removes the whole
 * `auth` pair — there is no state “login on, but without a password” to
 * express separately. Absent (`kind: 'keep'`) means “leave the stored password
 * as it is”, the load-bearing promise of the requirement's second
 * reproduction.
 */
export type SmtpPasswordDraft =
  { readonly kind: 'keep' } | { readonly kind: 'set'; readonly value: string };

export interface SystemMailDraft {
  /** Whether a mail server is configured at all — `smtp` present or `null`. */
  readonly enabled: boolean;
  readonly host: string;
  /** As typed; parsed and bounds-checked server-side, not duplicated here. */
  readonly port: string;
  readonly secure: boolean;
  readonly authEnabled: boolean;
  readonly user: string;
  readonly password: SmtpPasswordDraft;
  readonly from: string;
  readonly publicBaseUrl: string;
  /**
   * The system-wide default for `Reply-To`.
   *
   * **Next to the block, not inside it** — and that goes here in the draft as
   * well, where it would most readily be pushed back together: the block is
   * indivisible *because it carries a secret*, and a field that could only be
   * saved together with {@link SmtpPasswordDraft} could not be set at all on an
   * installation without a mail server. It therefore lies outside the `enabled`
   * branch of {@link systemMailWriteOf}, just like {@link publicBaseUrl}.
   */
  readonly replyTo: string;
  /** Where an operations alert goes — empty means “nobody”. */
  readonly opsAlertEmail: string;
}

export function systemMailDraftOf(values: SystemMailSettings): SystemMailDraft {
  const smtp = values.smtp;
  return {
    enabled: smtp !== null,
    host: smtp?.host ?? '',
    port: smtp === null ? '' : String(smtp.port),
    // The convenient default for a fresh block — a human sees it and can
    // disagree, exactly the placement `smtpBlockSchema`'s own comment asks
    // for (`secure` has no default at the storage layer on purpose).
    secure: smtp?.secure ?? true,
    authEnabled: smtp !== null && smtp.authUser !== null,
    user: smtp?.authUser ?? '',
    password: { kind: 'keep' },
    from: smtp?.from ?? '',
    publicBaseUrl: values.publicBaseUrl ?? '',
    replyTo: values.replyTo ?? '',
    opsAlertEmail: values.opsAlertEmail ?? '',
  };
}

export function systemMailDirty(
  values: SystemMailSettings,
  draft: SystemMailDraft,
): boolean {
  const smtp = values.smtp;
  // The two values that stand next to the block — they make the draft
  // “changed” even when no mail server is set up at all (// ADR-0013 no. 3). That is precisely the yield of the separation.
  const besideBlockChanged =
    trimmedOrNull(draft.publicBaseUrl) !== values.publicBaseUrl ||
    trimmedOrNull(draft.replyTo) !== values.replyTo ||
    trimmedOrNull(draft.opsAlertEmail) !== values.opsAlertEmail;

  if (draft.enabled !== (smtp !== null)) {
    return true;
  }
  if (!draft.enabled) {
    return besideBlockChanged;
  }
  return (
    besideBlockChanged ||
    draft.host.trim() !== (smtp?.host ?? '') ||
    draft.port.trim() !== String(smtp?.port ?? '') ||
    draft.secure !== (smtp?.secure ?? true) ||
    draft.authEnabled !== (smtp?.authUser !== null && smtp !== null) ||
    (draft.authEnabled && draft.user.trim() !== (smtp?.authUser ?? '')) ||
    draft.password.kind !== 'keep' ||
    draft.from.trim() !== (smtp?.from ?? '')
  );
}

/**
 * The draft, as the wire's write contract wants it.
 *
 * `port` is handed on as typed, parsed with `Number.parseInt` — an invalid
 * number becomes `NaN`, which the server's own schema refuses with the field
 * named; there is no reason to duplicate that bound here (`CONTRIBUTING.md`, „der Server validiert immer selbst").
 */
export function systemMailWriteOf(
  draft: SystemMailDraft,
  lock: number,
): SaveSystemMailSettingsVariables {
  const publicBaseUrl = trimmedOrNull(draft.publicBaseUrl);
  // Empty means `null` — “no default” —, never the empty string: that one
  // `replyToAddressSchema` rejects with a 400, and the save operation meant
  // “delete” (the same trap `trimmedOrNull` already stands against for the
  // base address).
  const replyTo = trimmedOrNull(draft.replyTo);
  const opsAlertEmail = trimmedOrNull(draft.opsAlertEmail);

  if (!draft.enabled) {
    return { smtp: null, publicBaseUrl, replyTo, opsAlertEmail, lock };
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
            // Absent means “leave the stored password as it is” — the
            // three-state contract `systemSmtpAuthWriteSchema` describes,
            // carried through rather than defaulted to a fourth, wrong state.
            ...(draft.password.kind === 'set'
              ? { password: draft.password.value }
              : {}),
          }
        : null,
    },
    publicBaseUrl,
    replyTo,
    opsAlertEmail,
    lock,
  };
}

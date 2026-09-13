import { ApiError } from '../../api/http';
import {
  useSaveTenantBaseUrl,
  useSaveTenantReplyTo,
  useTenantBaseUrl,
  useTenantReplyTo,
} from '../../api/tenant-admin';
import { useServerDraft } from '../../hooks/use-server-draft';
import { fieldIssues, saveErrorMessage } from '../api-messages';
import type { SettingIssues } from '../settings/SettingsControls';
import {
  tenantBaseUrlDirty,
  tenantBaseUrlDraftOf,
  tenantBaseUrlWriteOf,
} from './tenant-base-url-draft';
import {
  tenantReplyToDirty,
  tenantReplyToDraftOf,
  tenantReplyToWriteOf,
} from './tenant-reply-to-draft';

/**
 * **The two addresses of an organisation as state** — base address and
 * reply address, each a document of its own on a route of its own.
 *
 * Two hosts since ADR-0025: the tab *Mailversand* (two cards with one
 * save bar each) and the third step of the organisation assistant (both
 * fields, one button). That they stay **two** documents is no
 * carelessness but ADR-0013 no. 3 and the reasoning at
 * `TenantReplyToCard`: neither of the two carries a secret, so neither may
 * be chained to the SMTP password — and the assistant makes no
 * exception of that, it only presses two buttons at once.
 *
 * Both states have **the same shape**, because both are the same sort of document:
 * one field, no counter, last-write-wins. A common generic
 * hook would nevertheless be wrong — the sentences differ in every field, and
 * exactly those are the essential thing here.
 */
export interface TenantAddressFieldState {
  readonly value: string;
  readonly setValue: (next: string) => void;
  /** The field refusal of the server, or `undefined`. */
  readonly issue: string | undefined;
}

export type TenantAddressState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly field: TenantAddressFieldState;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      readonly save: (onSaved?: () => void) => void;
    };

const BASE_URL_SAVE_SUBJECT = {
  changed: 'Die Basis-Adresse dieser Organisation wurde',
  forbidden:
    'Diese Rolle darf die Basis-Adresse dieser Organisation nicht ändern.',
};

const REPLY_TO_SAVE_SUBJECT = {
  changed: 'Die Antwortadresse dieser Organisation wurde',
  forbidden:
    'Diese Rolle darf die Antwortadresse dieser Organisation nicht ändern.',
};

/**
 * This organisation's own base address (ADR-0013 no. 3).
 *
 * `prefill` gibt es seit Review-Runde 3 Nr. 5 — siehe dort.
 */
export function useTenantBaseUrlState(
  tenantId: string,
  options: { readonly prefill?: (value: string) => string } = {},
): TenantAddressState {
  const baseUrl = useTenantBaseUrl(tenantId);
  const save = useSaveTenantBaseUrl();
  const config = baseUrl.data;

  const { draft, setDraft, beginSave } = useServerDraft(
    tenantId,
    config === undefined
      ? undefined
      : prefilled(tenantBaseUrlDraftOf(config), options.prefill),
  );

  if (baseUrl.isPending) {
    return { kind: 'loading' };
  }
  if (config === undefined || draft === null) {
    return {
      kind: 'failed',
      message:
        baseUrl.error instanceof ApiError && baseUrl.error.status === 403
          ? 'Diese Rolle darf die Basis-Adresse dieser Organisation nicht sehen.'
          : 'Die Basis-Adresse konnte nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  const issues: SettingIssues = fieldIssues(save.error);

  return {
    kind: 'ready',
    field: {
      value: draft.value,
      setValue: (value) => {
        setDraft({ value });
      },
      issue: issues.baseUrl,
    },
    dirty: tenantBaseUrlDirty(config, draft),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, BASE_URL_SAVE_SUBJECT)
      : null,
    save: (onSaved?: () => void): void => {
      const adopt = beginSave();
      save.mutate(
        { tenantId, write: tenantBaseUrlWriteOf(draft) },
        {
          onSuccess: () => {
            adopt();
            onSaved?.();
          },
        },
      );
    },
  };
}

/**
 * Wendet eine Vorbelegung auf den geladenen Entwurf an — oder gibt ihn
 * unverändert zurück (Review-Runde 3 Nr. 5).
 *
 * Als Funktion und nicht als Wert, damit sie den **geladenen** Stand sieht:
 * vorbelegt wird nur, was leer ist. Sonst überschriebe ein zweiter Besuch des
 * Schrittes eine hinterlegte Adresse mit der des Browsers — derselbe Aufbau
 * wie beim Assistenten der Installation (`views/setup/use-mail-step.ts`).
 */
function prefilled(
  draft: { readonly value: string },
  prefill: ((value: string) => string) | undefined,
): { readonly value: string } {
  return prefill === undefined ? draft : { value: prefill(draft.value) };
}

/** The reply address of this organisation. */
export function useTenantReplyToState(tenantId: string): TenantAddressState {
  const replyTo = useTenantReplyTo(tenantId);
  const save = useSaveTenantReplyTo();
  const config = replyTo.data;

  const { draft, setDraft, beginSave } = useServerDraft(
    tenantId,
    config === undefined ? undefined : tenantReplyToDraftOf(config),
  );

  if (replyTo.isPending) {
    return { kind: 'loading' };
  }
  if (config === undefined || draft === null) {
    return {
      kind: 'failed',
      message:
        replyTo.error instanceof ApiError && replyTo.error.status === 403
          ? 'Diese Rolle darf die Antwortadresse dieser Organisation nicht sehen.'
          : 'Die Antwortadresse konnte nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  const issues: SettingIssues = fieldIssues(save.error);

  return {
    kind: 'ready',
    field: {
      value: draft.value,
      setValue: (value) => {
        setDraft({ value });
      },
      issue: issues.replyTo,
    },
    dirty: tenantReplyToDirty(config, draft),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, REPLY_TO_SAVE_SUBJECT)
      : null,
    save: (onSaved?: () => void): void => {
      const adopt = beginSave();
      save.mutate(
        { tenantId, write: tenantReplyToWriteOf(draft) },
        {
          onSuccess: () => {
            adopt();
            onSaved?.();
          },
        },
      );
    },
  };
}

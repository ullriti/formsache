import type { TenantAiSwitch } from '@formsache/shared';

import { ApiError } from '../../api/http';
import {
  useSaveTenantAiSwitch,
  useTenantAiSwitch,
} from '../../api/tenant-admin';
import { useServerDraft } from '../../hooks/use-server-draft';
import { saveErrorMessage } from '../api-messages';

/**
 * **An organisation's own AI switch as state** (ADR-0025 no. 6).
 *
 * ## The route existed, the interface did not
 *
 * `GET`/`PUT /ai/tenant-settings` has been in the server since ADR-0015, is
 * covered by tests — and appeared in not a single line of `apps/web/src`. An
 * organisation could therefore neither switch itself off nor switch itself
 * back on, unless somebody called the route by hand. What was missing was
 * exactly this here and the card above it.
 *
 * ## Three values, not two
 *
 * `enabled` is `boolean | null`, and `null` is not a „not set" but a decision
 * of its own: *„what the installation prescribes applies here too."*
 * A switch with two positions could not express that — at the moment of
 * saving it would have turned the inheriting into a fixed yes or no, and the
 * organisation would hang on a value that was right once (the reasoning
 * stands at `tenantAiSwitchSchema`).
 *
 * ## And what the installation can do stands beside it
 *
 * `systemAvailable` is display, not a dial. If it is `false`, every position
 * of this switch is without consequence — and the card says so, instead of
 * offering a choice that has no effect.
 */

/** The three positions, as a string for a `select`. */
export type TenantAiChoice = 'inherit' | 'on' | 'off';

export function aiChoiceOf(enabled: boolean | null): TenantAiChoice {
  return enabled === null ? 'inherit' : enabled ? 'on' : 'off';
}

export function aiEnabledOf(choice: TenantAiChoice): boolean | null {
  return choice === 'inherit' ? null : choice === 'on';
}

export type TenantAiState =
  | { readonly kind: 'loading' }
  /** 403 — this role must not see the AI setting. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly document: TenantAiSwitch;
      readonly choice: TenantAiChoice;
      readonly setChoice: (next: TenantAiChoice) => void;
      /** Whether the installation has the feature at all. */
      readonly systemAvailable: boolean;
      readonly dirty: boolean;
      readonly isSaving: boolean;
      readonly errorMessage: string | null;
      readonly save: (onSaved?: () => void) => void;
    };

const AI_SAVE_SUBJECT = {
  changed: 'Die KI-Einstellung dieser Organisation wurde',
  forbidden:
    'Diese Rolle darf die KI-Einstellung dieser Organisation nicht ändern.',
};

export function useTenantAiState(tenantId: string): TenantAiState {
  const switchQuery = useTenantAiSwitch(tenantId);
  const save = useSaveTenantAiSwitch();

  const document = switchQuery.data;

  const { draft, setDraft, beginSave } = useServerDraft<TenantAiChoice>(
    tenantId,
    document === undefined ? undefined : aiChoiceOf(document.enabled),
  );

  if (switchQuery.isPending) {
    return { kind: 'loading' };
  }

  if (document === undefined || draft === null) {
    if (
      switchQuery.error instanceof ApiError &&
      switchQuery.error.status === 403
    ) {
      return { kind: 'absent' };
    }
    return {
      kind: 'failed',
      message:
        'Die KI-Einstellung dieser Organisation konnte nicht geladen werden. Bitte die Seite neu laden.',
    };
  }

  return {
    kind: 'ready',
    document,
    choice: draft,
    setChoice: setDraft,
    systemAvailable: document.systemAvailable,
    dirty: draft !== aiChoiceOf(document.enabled),
    isSaving: save.isPending,
    errorMessage: save.isError
      ? saveErrorMessage(save.error, AI_SAVE_SUBJECT)
      : null,
    save: (onSaved?: () => void): void => {
      const adopt = beginSave();
      save.mutate(
        { tenantId, write: { enabled: aiEnabledOf(draft) } },
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

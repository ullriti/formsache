import type { AiProvider, AiRegion, SystemAiSettings } from '@formsache/shared';

import type { SaveSystemAiSettingsVariables } from '../../api/system-settings';

/**
 * The draft of the tab *KI* — the same division that
 * `system-mail-draft.ts` has for the mail tab: next to the fields that
 * build and read it, and **without** the counter that `useServerDraft` keeps
 * beside the loaded document.
 *
 * It came with the setup wizard (ADR-0022, continuation
 * 2026-08-18). Until then the tab held five separate `useState`, each with
 * a third state `undefined` for „nobody has touched this" — which
 * worked, but could neither answer „changed or not" (there was
 * no save bar, only a button that always worked) nor close the race
 * that `useServerDraft` is built against.
 */

export interface SystemAiDraft {
  readonly enabled: boolean;
  readonly provider: AiProvider | null;
  /**
   * The model identifier, or `''` for „the provider's default".
   *
   * `''` and not `null`: that is the value of the empty `<option>`, and a
   * second way of saying the same thing would be a second opportunity to
   * compare them as unequal. The translation happens only on writing
   * ({@link systemAiWriteOf}).
   */
  readonly model: string;
  readonly region: AiRegion;
  /**
   * The newly typed key — **empty means „keep the stored
   * one"**.
   *
   * ⚠️ **`newApiKey` and not `apiKey`, and the name is a promise.**
   * `apps/api/test/ai/key-confinement.spec.ts` counts the files in the whole
   * repository that read the key as a **field access**, and allows exactly
   * four — the resolution, the unsealing and the two adapters. Every
   * further one is one more place at which a plaintext can be passed on,
   * and lengthening the list is expressly a deliberate act.
   * (The guard reads the source text, comments included — which is why
   * the spelling it searches for is not written out here.)
   *
   * This field is no such place: it carries what has **just been typed**,
   * on its way out — never the stored value, which
   * this browser does not get at all. The other name therefore keeps the two
   * apart, instead of extending the guard by an entry that means something
   * other than the four.
   *
   * The stored value never stands here. It does not leave the server, and
   * `systemAiSettingsSchema` is a `strictObject`, so that a server that did
   * send it along would fail on loading instead of bringing a secret onto the
   * screen.
   */
  readonly newApiKey: string;
}

export function systemAiDraftOf(values: SystemAiSettings): SystemAiDraft {
  return {
    enabled: values.enabled,
    provider: values.provider,
    model: values.model ?? '',
    region: values.region,
    newApiKey: '',
  };
}

export function systemAiDirty(
  values: SystemAiSettings,
  draft: SystemAiDraft,
): boolean {
  return (
    draft.enabled !== values.enabled ||
    draft.provider !== values.provider ||
    draft.model !== (values.model ?? '') ||
    draft.region !== values.region ||
    // A typed key is a change, even when everything else
    // stands: it is the only value of this page whose „before" nobody
    // can see.
    draft.newApiKey !== ''
  );
}

export function systemAiWriteOf(
  draft: SystemAiDraft,
  lock: number,
): SaveSystemAiSettingsVariables {
  return {
    enabled: draft.enabled,
    provider: draft.provider,
    // `null` means „take the provider's default".
    model: draft.model === '' ? null : draft.model,
    region: draft.region,
    // Empty means „keep" — which is why the field is then **not sent at
    // all**, instead of sending `null` (that would mean „remove").
    ...(draft.newApiKey === '' ? {} : { apiKey: draft.newApiKey }),
    lock,
  };
}

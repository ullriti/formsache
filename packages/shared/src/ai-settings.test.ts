import { describe, expect, it } from 'vitest';

import {
  parseTenantAiSwitch,
  updateTenantAiSwitchRequestSchema,
} from './ai-settings.ts';

/**
 * **An organisation's switch and the disclosure beside it** (ADR-0025
 * no. 6).
 *
 * Two promises, and both are boundaries and not cosmetics:
 *
 * 1. **What is read is a pair** — the own switch (`boolean | null`, where
 *    `null` means „erbt die Vorgabe der Installation") **and** whether the
 *    installation has the feature at all. Without the second field an
 *    organisation cannot interpret its own state: the session's
 *    `aiFormsAvailable` is already the and of both layers.
 * 2. **What is written is only the own field.** `systemAvailable` is a
 *    statement about the installation; a caller who sends it along gets a
 *    refusal instead of a silent adoption.
 *
 * *Reproduction:* make the `strictObject` in the write schema an `object` →
 * the last case turns red, and a body with `systemAvailable` would go through
 * without comment.
 */
describe('der KI-Schalter einer Organisation', () => {
  it('liest die drei Stellungen des eigenen Schalters', () => {
    for (const enabled of [null, true, false]) {
      expect(
        parseTenantAiSwitch({ enabled, systemAvailable: true }).enabled,
      ).toBe(enabled);
    }
  });

  it('verlangt die Auskunft über die Installation — sie ist kein Zusatz', () => {
    expect(() => parseTenantAiSwitch({ enabled: null })).toThrow();
  });

  it('nimmt nichts an, was nicht der Organisation gehört', () => {
    // A server that sent the provider or the key along would show up here —
    // the same allow-list promise `systemAiSettingsSchema` makes.
    expect(() =>
      parseTenantAiSwitch({
        enabled: null,
        systemAvailable: true,
        provider: 'anthropic',
      }),
    ).toThrow();
  });

  it('schreibt genau ein Feld — und weist die Auskunft im Rumpf ab', () => {
    expect(
      updateTenantAiSwitchRequestSchema.safeParse({ enabled: false }).success,
    ).toBe(true);
    expect(
      updateTenantAiSwitchRequestSchema.safeParse({
        enabled: false,
        systemAvailable: true,
      }).success,
    ).toBe(false);
  });
});

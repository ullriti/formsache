import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {} from '@formsache/shared';

import { SecretBoxService } from '../common/secret-box/secret-box.service';
import { tenantDefaultsContext } from '../common/secret-box/secret-context';
import { SettingsSecretsService } from './settings-secrets.service';

/**
 * **The log amplifier that the requirement opened, and the ration that closes
 * it.**
 *
 * `open()` writes one `logger.error` when a stored access word will not
 * decrypt. That was harmless while the only caller was the editor's settings
 * page: one line per page load, behind a session, behind `can_manage_settings`.
 *
 * The access-word check gave the same code path a **public** caller. `AccessWordService` opens the
 * settings of every form somebody offers a word for, so a rotated key, a
 * restored dump or a hand-edited row turns each gate attempt into a line — ten a
 * minute per address, from as many addresses as an outsider cares to use, all of
 * them naming the one organisation whose row is already broken. `PublicFormsService`
 * and `AccessWordService` each carry a `reportOnce` against exactly this; the
 * new caller reached past both, into a service that had none.
 *
 * The two things that have to hold together are what this file pins down: the
 * **line** is rationed, the **refusal** is not.
 */

const KEY = Buffer.alloc(32, 3);
const OTHER_KEY = Buffer.alloc(32, 4);

const TENANT_ID = '019ff600-0000-7000-8000-0000000000a1';
const OTHER_TENANT_ID = '019ff600-0000-7000-8000-0000000000a2';

/**
 * A document whose word was sealed under a **different** key — the shape a
 * rotated `SECRET_BOX_KEY` leaves behind, and the one real cause of this log
 * line.
 */
function sealedElsewhere(tenantId: string): unknown {
  const stranger = new SecretBoxService(OTHER_KEY);
  return {
    // The shape the column stands in: **one flat document**, the word
    // at the top level (review finding 10). The wrapper `{ overridden, values }`
    // has not existed since `20260817120000_tenant_form_defaults_flat` — a row
    // that still carries it is not one this version wrote, and
    // fails on the schema already rather than on the key.
    passwordEnabled: true,
    password: stranger.seal(
      'Jahrestagung2026',
      tenantDefaultsContext(tenantId, 'access.password'),
    ),
  };
}

describe('SettingsSecretsService.open (log amplification)', () => {
  function harness() {
    const secrets = new SettingsSecretsService(new SecretBoxService(KEY));
    // The service holds its own `Logger` instance, so the prototype is what a
    // spy has to sit on — the same way the application's other loggers are
    // silenced in `create-test-app.ts`.
    const errors = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {
        // swallowed: the assertion is the call count, not the output
      });
    return { secrets, errors };
  }

  it('writes the line once, however often the public route asks', () => {
    const { secrets, errors } = harness();
    const stored = sealedElsewhere(TENANT_ID);

    try {
      for (let attempt = 0; attempt < 25; attempt += 1) {
        expect(() => secrets.openTenantDefaults(stored, TENANT_ID)).toThrow();
      }

      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });

  /**
   * **Rationing the line must not ration the refusal.** A `reportOnce` written
   * around the `throw` instead of around the `logger.error` would hand the
   * second caller a value it could not decrypt — fail *open*, silently, and only
   * for callers after the first.
   */
  it('still refuses every single one of them', () => {
    const { secrets, errors } = harness();
    const stored = sealedElsewhere(TENANT_ID);

    try {
      const outcomes = Array.from({ length: 5 }, () => {
        try {
          secrets.openTenantDefaults(stored, TENANT_ID);
          return 'opened';
        } catch {
          return 'refused';
        }
      });

      expect(outcomes).toStrictEqual([
        'refused',
        'refused',
        'refused',
        'refused',
        'refused',
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  /**
   * Keyed by the context, so two broken rows are two lines. The set is bounded
   * by the number of faults in the installation, never by traffic — and an
   * operator has to be able to see that the *second* Organisation is affected too.
   */
  it('separates the faults instead of collapsing them into one', () => {
    const { secrets, errors } = harness();

    try {
      for (const tenantId of [TENANT_ID, OTHER_TENANT_ID, TENANT_ID]) {
        expect(() =>
          secrets.openTenantDefaults(sealedElsewhere(tenantId), tenantId),
        ).toThrow();
      }

      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });
});

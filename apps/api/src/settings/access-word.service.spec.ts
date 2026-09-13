import { describe, expect, it, vi } from 'vitest';

import {} from '@formsache/shared';

import { SecretBoxService } from '../common/secret-box/secret-box.service';
import { formOverrideContext } from '../common/secret-box/secret-context';
import { SigningService } from '../common/secret-box/signing.service';
import {
  ABSENT_FORM,
  AccessWordService,
  DUMMY_WORD,
  type AccessWordSource,
} from './access-word.service';
import { SettingsSecretsService } from './settings-secrets.service';

/**
 * **The timing invariant of the requirement, bullet 3 — asserted instead of
 * measured**, and the counterpart of `auth/auth.service.spec.ts`.
 *
 * The login has exactly this file: no database, `verifyPassword` mocked, and one
 * sentence pinned down — *the Argon2id verification runs even when there is no
 * user*. The password gate had no such file. What it had was a spy inside the
 * integration suite that watched `SigningService.sign`, and that watched the
 * wrong operation:
 *
 * - **HMAC-SHA256 over a short string is not the work.** The comparison's cost
 *   is the **AES-GCM open** — `this.box.open(this.dummySealed, DUMMY_CONTEXT)`
 *   in `expectedWord`, the line that makes „dieses Formular hat gar kein Wort"
 *   cost what „das Wort war falsch" costs. Deleting it left the old spy test
 *   green *and* the wall-clock test green (that one measures the same
 *   configured form twice, so neither of its two calls ever takes the dummy
 *   path).
 * - **Four calls against two sources are not four paths.** The old test offered
 *   three words to one configured form and one word to an unconfigured one:
 *   three times the same branch, once the other. The branch that answers an
 *   **unknown slug** ({@link ABSENT_FORM}, fed in by
 *   `PublicFormsService.unlock`) and the one that answers an **unreadable
 *   settings document** were not exercised at all.
 *
 * So this file names all five sources the comparison can be handed and requires
 * that each does the **same amount of work**: one `SecretBoxService.open` and
 * two `SigningService.sign`. Not „some work" — the *same* count, because an
 * oracle is a difference, not an absence.
 *
 * ## What it does not claim
 *
 * It says nothing about `timingSafeEqual` versus `===`; the MAC hides the
 * plaintexts from the comparison and `signing.service.ts` owns that half. And it
 * counts operations, not nanoseconds — an equal count is what makes the equal
 * cost plausible, and a wall clock over HTTP could never separate these paths
 * anyway.
 */

/** 32 bytes, fixed: this is a test key and there is nothing to protect. */
const TEST_KEY = Buffer.alloc(32, 7);

const TENANT_ID = '019ff500-0000-7000-8000-0000000000a1';
const FORM_ID = '019ff500-0000-7000-8000-0000000000b1';

const WORD = 'Jahrestagung2026';

/**
 * A real {@link SecretBoxService} and a real {@link SigningService} over a test
 * key, with spies **on top of the real implementations**.
 *
 * Not mocks: the sealed value in the configured source has to open, and a stub
 * that returned a constant would make „the dummy is decrypted too" unfalsifiable
 * — the very mistake this file exists to correct.
 */
function harness() {
  const box = new SecretBoxService(TEST_KEY);
  const signing = new SigningService(TEST_KEY);
  const secrets = new SettingsSecretsService(box);

  // Sealed before the spies are attached: the constructor of the service seals
  // its dummy as well, and neither belongs in the counts.
  const sealed = box.seal(
    WORD,
    formOverrideContext(TENANT_ID, FORM_ID, 'access.password'),
  );

  const words = new AccessWordService(box, signing, secrets);

  return {
    words,
    open: vi.spyOn(box, 'open'),
    sign: vi.spyOn(signing, 'sign'),
    configured: {
      id: FORM_ID,
      settingsOverride: {
        overridden: {
          access: true,
          confirm: false,
          display: false,
        },
        values: { passwordEnabled: true, password: sealed },
      },
      tenant: { id: TENANT_ID, formDefaults: {} },
    },
  };
}

/** A form whose *Zugriff & Sicherheit* section is simply not configured. */
function withoutPassword(): AccessWordSource {
  return {
    id: FORM_ID,
    settingsOverride: {},
    tenant: { id: TENANT_ID, formDefaults: {} },
  };
}

/**
 * A document that does not parse — an unknown key, which is what a *newer*
 * deployment's write looks like to an older one (`strictObject`).
 *
 * Deliberately without a `values.password`: the point of the case is the
 * `catch` in `openSettings`, and a sealed word inside it would be opened before
 * the parse failed and would move the count for a reason that has nothing to do
 * with the invariant.
 */
function unreadable(): AccessWordSource {
  return {
    id: FORM_ID,
    settingsOverride: { einstellungAusDerZukunft: true },
    tenant: { id: TENANT_ID, formDefaults: {} },
  };
}

type Harness = ReturnType<typeof harness>;

describe('AccessWordService.matches (bullet 3)', () => {
  /**
   * The five sources, each named after the branch it takes. „Wrong word" is the
   * same document as „configured" with a different offer — listed separately
   * because it is the pair the wall-clock test compares and the one an attacker
   * actually produces.
   */
  function cases(h: Harness): readonly {
    readonly name: string;
    readonly run: () => boolean;
  }[] {
    return [
      {
        name: 'the configured word',
        run: () => h.words.matches(h.configured, WORD),
      },
      {
        name: 'a wrong word on a configured form',
        run: () => h.words.matches(h.configured, 'Jahrestagung2027'),
      },
      {
        name: 'a form without a password',
        run: () => h.words.matches(withoutPassword(), WORD),
      },
      {
        name: 'a settings document that does not parse',
        run: () => h.words.matches(unreadable(), WORD),
      },
      {
        name: 'an address that leads nowhere',
        run: () => h.words.matches(ABSENT_FORM, WORD),
      },
    ];
  }

  it('answers true only for the configured word', () => {
    const h = harness();
    expect(cases(h).map((one) => one.run())).toStrictEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  /**
   * **The load-bearing assertion.** One AES-GCM open per call, on every one of
   * the five sources — the equalising `box.open(this.dummySealed, …)` is what
   * puts it on the four that have nothing to decrypt.
   *
   * Removing that one line makes this red four times over, which is precisely
   * what the old spy test could not do.
   */
  it('decrypts exactly once whichever source it is handed', () => {
    const h = harness();
    const opens: Record<string, number> = {};

    for (const one of cases(h)) {
      h.open.mockClear();
      one.run();
      opens[one.name] = h.open.mock.calls.length;
    }

    expect(opens).toStrictEqual({
      'the configured word': 1,
      'a wrong word on a configured form': 1,
      'a form without a password': 1,
      'a settings document that does not parse': 1,
      'an address that leads nowhere': 1,
    });
  });

  /**
   * The MAC, the half the old test did cover — kept, and extended to the two
   * sources it never reached. Two per call: the offered word, and the expected
   * side that `verify` signs for itself.
   */
  it('MACs both sides whichever source it is handed', () => {
    const h = harness();
    const signs: Record<string, number> = {};

    for (const one of cases(h)) {
      h.sign.mockClear();
      one.run();
      signs[one.name] = h.sign.mock.calls.filter(
        ([purpose]) => purpose === 'public.access-word',
      ).length;
    }

    expect(Object.values(signs)).toStrictEqual([2, 2, 2, 2, 2]);
  });

  /**
   * The offered word reaches the MAC **unchanged** on every path — the
   * short-circuit assertion, kept from the integration test it is replacing.
   *
   * Without it a service could satisfy the counts above by MACing a constant on
   * the paths that have nothing to compare, which would equalise the work and
   * lose the point.
   */
  it('MACs the word the caller offered, not a substitute', () => {
    const h = harness();

    for (const one of cases(h)) {
      h.sign.mockClear();
      one.run();
      const offered = h.sign.mock.calls.find(
        ([purpose]) => purpose === 'public.access-word',
      );
      expect(offered?.[1], one.name).toBe(
        one.name === 'a wrong word on a configured form'
          ? 'Jahrestagung2027'
          : WORD,
      );
    }
  });

  /**
   * **The regression line for the invariant that was written down wrongly.**
   *
   * The file comment used to argue that {@link DUMMY_WORD} cannot be guessed
   * because it carries a NUL byte. It can be sent — JSON has no trouble with
   * U+0000 — and the only reason it never let anybody in is the guard
   * `expected !== null && equal`. So the guard is what is asserted, with the
   * constant itself as the offer.
   *
   * Removing the `expected !== null &&` opens **every** form without a password
   * and **every** unknown address to a string that stands in the source.
   */
  it('refuses the dummy word itself on every source that has no real one', () => {
    const h = harness();

    expect(h.words.matches(withoutPassword(), DUMMY_WORD)).toBe(false);
    expect(h.words.matches(unreadable(), DUMMY_WORD)).toBe(false);
    expect(h.words.matches(ABSENT_FORM, DUMMY_WORD)).toBe(false);
    // …and it is not the configured form's word either.
    expect(h.words.matches(h.configured, DUMMY_WORD)).toBe(false);
  });
});

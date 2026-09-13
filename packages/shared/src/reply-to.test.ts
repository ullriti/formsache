import { describe, expect, it } from 'vitest';

import { smtpBlockSchema } from './mail-config.ts';
import {
  effectiveReplyTo,
  effectiveReplyToSchema,
  isUnusableReplyTo,
  replyToAddressSchema,
  type ReplyToLevel,
} from './reply-to.ts';

/**
 * The chain from the concept and the one address check behind it.
 *
 * The proof that the *sent header* is correct does not belong here — it lies in
 * `apps/api/test/mail/reply-to.spec.ts` against a real SMTP server. What is
 * measured here is the rule itself.
 */
describe('replyToAddressSchema', () => {
  /**
   * A version of its own instead of `smtpBlockSchema.shape.from` would be a
   * second opinion about what an address is — this case keeps the two literally
   * identical, not merely equivalent.
   */
  it('is the very predicate the sender address uses', () => {
    expect(replyToAddressSchema).toBe(smtpBlockSchema.shape.from);
  });

  it('refuses what would become a second recipient or a second header', () => {
    for (const bad of [
      'Max <max@example.org>',
      'a@example.org, b@example.org',
      'a@example.org\r\nBcc: c@example.org',
      'kein-at-zeichen',
      '',
    ]) {
      expect(replyToAddressSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts a bare address', () => {
    expect(replyToAddressSchema.parse('buero@example.org')).toBe(
      'buero@example.org',
    );
  });
});

describe('effectiveReplyTo', () => {
  /** The three levels from the concept, in the order in which they apply. */
  function chain(
    notification: string | null | undefined,
    tenant: string | null | undefined,
    system: string | null | undefined,
  ): ReplyToLevel[] {
    return [
      { origin: 'notification', value: notification },
      { origin: 'tenant', value: tenant },
      { origin: 'system', value: system },
    ];
  }

  it('takes the first level that carries an address', () => {
    expect(
      effectiveReplyTo(
        chain('bt@example.org', 'organisation@example.org', 'sys@example.org'),
      ),
    ).toEqual({ address: 'bt@example.org', origin: 'notification' });
    expect(
      effectiveReplyTo(
        chain(null, 'organisation@example.org', 'sys@example.org'),
      ),
    ).toEqual({ address: 'organisation@example.org', origin: 'tenant' });
    expect(effectiveReplyTo(chain(null, null, 'sys@example.org'))).toEqual({
      address: 'sys@example.org',
      origin: 'system',
    });
  });

  /**
   * **The origin is the answer to “why this one?”** and
   * therefore comes from the chain itself.
   *
   * The case that exposes an origin computed on the side: the notification has
   * a value, *and nevertheless* the organization's applies, because the
   * notification's falls through at the second gate. “Field set ⇒
   * `notification`” — the obvious shortcut — would be wrong here, without the
   * address itself giving it away.
   */
  it('names the level that actually won, not the one that was merely set', () => {
    expect(
      effectiveReplyTo(
        chain(
          'Dachorganisation <bt@example.org>',
          'organisation@example.org',
          'sys@example.org',
        ),
      ),
    ).toEqual({ address: 'organisation@example.org', origin: 'tenant' });
  });

  /**
   * **Trap 1, as a promise:** if nothing is set, there is no header — never a
   * guessed address and never a refusal. The reasoning stands at the function.
   *
   * And the origin is then likewise `null`: “no level contributed anything” is
   * a state of its own and not a fourth level.
   */
  it('answers null when no level has one — no header, never a guess', () => {
    expect(effectiveReplyTo(chain(null, null, null))).toEqual({
      address: null,
      origin: null,
    });
    expect(effectiveReplyTo([])).toEqual({ address: null, origin: null });
    expect(effectiveReplyTo(chain(undefined, undefined, undefined))).toEqual({
      address: null,
      origin: null,
    });
  });

  /**
   * A value that reached the column past the API counts like an unset one — the
   * chain falls through instead of handing out something unusable.
   *
   * *Reproduction, measured (2026-08-04):* replace the `safeParse` in
   * `effectiveReplyTo` with a mere emptiness check — **exactly this** case goes
   * red (1 failed, 1158 passed).
   */
  it('falls through a stored value that is not an address', () => {
    expect(
      effectiveReplyTo(chain('nicht; eine adresse', null, 'sys@example.org')),
    ).toEqual({ address: 'sys@example.org', origin: 'system' });
    expect(effectiveReplyTo(chain('  ', null, null))).toEqual({
      address: null,
      origin: null,
    });
  });

  /**
   * The result is what stands on the wire — not a second, similarly shaped
   * structure next to it (`CONTRIBUTING.md`).
   */
  it('produces exactly what the wire schema describes', () => {
    expect(
      effectiveReplyToSchema.parse(
        effectiveReplyTo(chain(null, 'organisation@example.org', null)),
      ),
    ).toEqual({ address: 'organisation@example.org', origin: 'tenant' });
    expect(
      effectiveReplyToSchema.parse(effectiveReplyTo(chain(null, null, null))),
    ).toEqual({ address: null, origin: null });
  });

  /**
   * **“Both fields or neither” — measured, not asserted** (review of package
   * 0-A).
   *
   * The comment at the schema stated the sentence, and the schema did not keep
   * it: two independently nullable fields let `{ address: 'a@b.de', origin:
   * null }` through — a combination the chain never produces. It did not stay
   * without consequence: the editor checked for *both* fields and displayed
   * „keine" for it, so it would have **concealed** a real reply address instead
   * of letting it stand out.
   *
   * *Reproduction:* write `effectiveReplyToSchema` again as
   * `z.strictObject({ address: z.string().nullable(), origin:
   * replyToOriginSchema.nullable() })` — both assertions below go red, and
   * `NotificationEditor.effectiveReplyToText` can then no longer be type-checked,
   * because `origin` could be `null` again.
   */
  it('refuses an address without an origin — and an origin without an address', () => {
    expect(
      effectiveReplyToSchema.safeParse({
        address: 'a@example.org',
        origin: null,
      }).success,
    ).toBe(false);
    expect(
      effectiveReplyToSchema.safeParse({ address: null, origin: 'tenant' })
        .success,
    ).toBe(false);
  });
});

/**
 * The predicate behind the message (another finding of the Reply-To review).
 *
 * It does not change the **effect** of an unusable value — the chain still
 * falls through. What it separates is “not set” from “set and unusable”: only
 * the second is a silent failure that somebody has to notice.
 */
describe('isUnusableReplyTo', () => {
  it('says nothing about a level that was never set', () => {
    expect(isUnusableReplyTo(null)).toBe(false);
    expect(isUnusableReplyTo(undefined)).toBe(false);
    // A field with nothing but spaces is not an entry but an empty field — and
    // must not fill up a log.
    expect(isUnusableReplyTo('')).toBe(false);
    expect(isUnusableReplyTo('   ')).toBe(false);
  });

  it('says nothing about a level that carries a usable address', () => {
    expect(isUnusableReplyTo('buero@example.org')).toBe(false);
  });

  /**
   * The case from the finding: a hand-written line that *looks* like an
   * address. It takes the header away from every mail of this level.
   */
  it('flags a stored value that is set but not an address', () => {
    for (const stored of [
      'geschaeftsstelle@example',
      'Max <max@example.org>',
      'a@example.org, b@example.org',
      'a@example.org\r\nBcc: c@example.org',
    ]) {
      expect(isUnusableReplyTo(stored), stored).toBe(true);
    }
  });
});

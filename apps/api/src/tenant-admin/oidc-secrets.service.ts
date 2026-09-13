import { Injectable, Logger } from '@nestjs/common';

import { SecretBoxService } from '../common/secret-box/secret-box.service';
import { tenantOidcContext } from '../common/secret-box/secret-context';

/** The one secret the `tenant` row itself holds — see `secret-context.ts`. */
const CLIENT_SECRET = 'oidc.client_secret';

/**
 * The column conversion, in both directions — see the class doc for why it is
 * UTF-8 of the sealed token and not a packed binary record.
 *
 * `TextDecoder` is not `fatal`, so bytes that are no valid UTF-8 decode to
 * replacement characters instead of throwing. That is deliberate: the failure
 * they then produce is the *one* failure this service has — `open()` refusing —
 * rather than a second, differently-shaped one from the decoder that a caller
 * would have to handle separately.
 */
const UTF8_OUT = new TextEncoder();
const UTF8_IN = new TextDecoder();

/**
 * The failure of {@link OidcSecretsService.open}.
 *
 * **A named error rather than an `InternalServerErrorException`**, which is
 * where this deliberately parts company with `SettingsSecretsService`. That one
 * has exactly one caller shape — an editor looking at a settings page — so an
 * HTTP status is the honest answer. This one is read on the **login** path,
 * where the right answer is a refused sign-in with a message, not
 * a JSON 500 in the middle of a browser redirect. Deciding that here would be
 * this service presuming an HTTP shape for a caller it does not own.
 *
 * What is *not* left to the caller: that it fails at all. There is no variant
 * of `open()` that returns a best effort, and no fallback to „no secret" — a
 * stored value that does not open is a value somebody put there, and continuing
 * with it (or without it) is the *fail open* the evidence is about.
 *
 * The message names the tenant and the field and nothing else. Both are ids the
 * server produced; neither is the secret. Errors reach logs by every path there
 * is (`SecretBoxError` was built on that assumption), so there must be nothing
 * in this one worth reading.
 */
export class OidcClientSecretUnreadableError extends Error {
  constructor(tenantId: string) {
    super(
      `stored OIDC client secret of tenant ${tenantId} cannot be opened; refusing to sign anybody in with it (fail closed)`,
    );
    this.name = 'OidcClientSecretUnreadableError';
  }
}

/**
 * Sealing and opening the **second** database secret of this application
 *  — the counterpart of `SettingsSecretsService`, and
 * different from it in the one way that matters.
 *
 * **The access word comes back out; this never does.** An editor has to be able
 * to read a form's access word aloud and pass it on, so
 * `SettingsSecretsService` has an `open…` method on the *read* path of a route.
 * Nobody has to read a client secret aloud. The read path of the
 * tenant administration therefore calls {@link isUsable}, which answers a
 * **boolean** — the plaintext is not returned, and no widening of a `select` or
 * a response schema can turn a boolean into one. {@link open} exists for the
 * login, which genuinely needs the value to talk to the token endpoint, and for
 * nothing else.
 *
 * **Bytes, not a string, in the column.** `tenant.oidc_client_secret_encrypted`
 * is `Bytes?`, chosen so a plaintext cannot be written there by accident
 * (`schema.prisma`), while `SecretBoxService.seal()` produces a string. The
 * conversion is **UTF-8 of the sealed token, in both directions**, and that is a
 * decision rather than the only option:
 *
 * - The token is deliberately self-describing ASCII — `formsache1.<key-id>.<context-id>.…`
 *   — so that a key rotation or a cipher change can be read off a stored value
 *   (`secret-box.service.ts`). UTF-8 of an ASCII-only string is byte-identical
 *   to it, so `SELECT encode(oidc_client_secret_encrypted, 'escape')` in psql
 *   shows exactly the token an operator would compare against a log line. That
 *   property is worth more than the bytes it costs.
 * - The alternative — base64-decoding the parts into a packed binary record —
 *   would save about a quarter of the length and destroy that: the format
 *   version would then live in a length convention rather than in the value,
 *   which is the situation the version prefix exists to avoid. The column is
 *   `Bytes` to keep a *plaintext* out, not to compress.
 */
@Injectable()
export class OidcSecretsService {
  /** Where the *reason* goes; a caller only ever learns that it failed. */
  private readonly logger = new Logger(OidcSecretsService.name);

  /**
   * Which „cannot be opened"-lines have already been written, so each is
   * written **once per process lifetime** — the same set, for the same reason,
   * as in `SettingsSecretsService` and `PublicFormsService`.
   *
   * It matters more here than there. {@link isUsable} runs on every read of the
   * tenant administration *and*, through the sign-in route, on every attempt to sign in —
   * and an attempt to sign in is reachable without a session. A line per call
   * would turn one broken row into an amplifier anybody can pull. Keyed by the
   * finished message, which is built from a tenant id and a fixed field name and
   * therefore bounded by the number of broken rows rather than by traffic.
   */
  private readonly reported = new Set<string>();

  constructor(private readonly box: SecretBoxService) {}

  /**
   * Plaintext -> the bytes that go into the column, bound to this organisation.
   *
   * The context names the holder (`tenant-oidc`), the tenant **and** the field,
   * so the result opens nowhere else: not in another organisation's row,
   * and not as the access word of a form or of this organisation's own standards — the
   * privilege escalation `secret-context.ts` describes, where somebody with
   * `can_manage_settings` reads a client secret off the settings page that is
   * allowed to show an access word in clear.
   */
  seal(plaintext: string, tenantId: string): Uint8Array<ArrayBuffer> {
    return UTF8_OUT.encode(
      this.box.seal(plaintext, tenantOidcContext(tenantId, CLIENT_SECRET)),
    );
  }

  /**
   * The stored secret of this organisation — **for the login and nothing else**.
   *
   * Throws {@link OidcClientSecretUnreadableError} for a value that does not
   * open here: a foreign one carried in by a raw write, a row from before a key
   * rotation, or edited bytes. It never returns `null` in those cases, because
   * „no secret" and „a secret I cannot read" are different facts and only the
   * first one is an organisation that has not finished configuring itself.
   */
  open(stored: Uint8Array, tenantId: string): string {
    const context = tenantOidcContext(tenantId, CLIENT_SECRET);
    try {
      return this.box.open(UTF8_IN.decode(stored), context);
    } catch {
      // Neither the stored bytes nor a plaintext reaches the log — only the
      // context, which is made of an id and a field name and is what makes the
      // line actionable (`CONTRIBUTING.md`). `SecretBoxError`'s own message is
      // dropped rather than chained: `cause` is printed by most log formatters,
      // and this code must not depend on somebody keeping those messages free
      // of their input.
      this.reportOnce(`Stored secret at ${context} cannot be opened.`);
      throw new OidcClientSecretUnreadableError(tenantId);
    }
  }

  /**
   * Whether a **usable** secret is stored for this organisation — the whole of the
   * „gesetzt / nicht gesetzt" the tab shows.
   *
   * *Fail closed, and the wording is the point:* bytes that are present but do
   * not open here are **not** a stored secret. Reporting them as „gesetzt"
   * would let an organisation switch SSO on against a value that no login can use, and —
   * in the case the evidence builds — against another organisation's secret
   * carried in by a raw write. Saying „nicht gesetzt" is both the safe answer
   * and the repairable one: the tab offers a field to replace it.
   *
   * **Returns a boolean, never the value.** That is the type-level half of
   * „der Klartext verlässt den Server nie": the read path has no expression in
   * which a plaintext exists, so no later widening of the response can carry
   * one out. The plaintext produced inside `box.open` is discarded in the same
   * statement that produced it.
   */
  isUsable(stored: Uint8Array | null, tenantId: string): boolean {
    if (stored === null || stored.length === 0) {
      return false;
    }
    try {
      this.open(stored, tenantId);
      return true;
    } catch {
      return false;
    }
  }

  private reportOnce(message: string): void {
    if (this.reported.has(message)) {
      return;
    }
    this.reported.add(message);
    this.logger.error(message);
  }
}

import { z } from 'zod';

/**
 * A mail server, as this application stores one — **whole or not at all**
 * ([ADR-0013](../../../docs/architecture/0013-versandidentitaet-je-organisation.md),
 * [ADR-0023](../../../docs/architecture/0023-getrennte-mailserver-instanz-organisation.md)).
 *
 * ## Two rows, one document (ADR-0023)
 *
 * There used to be two shapes here: a naked block for `system_setting.smtp` and
 * a discriminated union for `tenant.smtp`, whose second arm said „diese
 * Organisation erbt den Block der Installation". **Die Vererbung ist
 * abgeschafft** — the installation's mail server serves the operator (Alarme,
 * Testmail der Systemverwaltung), never an organisation that has none. With
 * nothing left to inherit from, the union's `system` arm had exactly one
 * meaning left and it was the wrong one, so both rows now hold the very same
 * document: {@link smtpBlockSchema}, or SQL NULL for „noch nicht eingerichtet".
 *
 * ## Why a block and not an object of optional fields
 *
 * The dangerous mixture is *somebody else's transport + an own sender address*.
 * A transport is authorised for its domain by SPF and DKIM, so a sender allowed
 * to replace only the address would send signed, technically flawless mail from
 * any address of that domain — identity forgery carrying that domain's own
 * authorisation, indistinguishable from real post because technically it *is*
 * real post.
 *
 * A rule („wenn `host`, dann auch `from`") would be a runtime promise, written
 * in one place and bypassed the moment somebody adds a second write path. The
 * block makes it a statement of the type system instead: **a document that sets
 * only `from` is not expressible**, so there is no test for it — and that is
 * stronger than a test somebody can forget to write.
 *
 * ⚠️ **The proof therefore hangs off `pnpm typecheck`, not off Vitest.** Vitest
 * runs through SWC, which strips types without checking them; a green suite says
 * nothing about this promise. The same trap `PUBLIC_BASE_URL` set.
 *
 * ## What is deliberately *not* in the block
 *
 * - The **display name** . It is a property of the organisation
 *   and stands in front of the address; it forges nothing, because the address
 *   next to it is the one this block names.
 * - The **base address** (`public_base_url`). It says *where a
 *   Organisation is reachable*, not who it is in the mail system. An organisation may well be
 *   reachable under its own address and send over a mail server whose name has
 *   nothing to do with it; that is a normal case, not a mixture.
 * - The **reply address**. It carries no secret, is not signed, and must stay
 *   settable on an organisation that has no mail server at all.
 */

/**
 * A TCP port as it stands in a stored block — a **number**, not a string.
 *
 * Deliberately not shared with `apiEnvSchema`'s port: that one coerces, because
 * the environment only knows strings. This value comes out of JSONB, where a
 * port that arrived as `"587"` is a document somebody wrote by hand, and
 * quietly accepting it would be the first crack in „ein gespeicherter Block hat
 * keine offenen Felder".
 */
const smtpPortSchema = z.number().int().min(1).max(65535);

/**
 * SMTP authentication — **a pair, or nothing at all.**
 *
 * `null` is a supported operating mode rather than an oversight: the `.env`
 * used to allow a relay without a login (`SMTP_USER=`/`SMTP_PASSWORD=` empty), and
 * dropping that silently would be an unannounced regression for whoever
 * runs one. As a *pair* the block stays indivisible all the same — `{ user }`
 * without `password` does not parse, and neither does `{ password }` alone.
 *
 * **`password` is a `string` here and a sealed envelope in the column.** The
 * same shape `access.password` has: the schema describes the
 * plaintext an editor types, and `MailSecretsService` seals it on the way into
 * JSONB and opens it on the way out. Nothing in this package ever sees the key.
 */
export const smtpAuthSchema = z.strictObject({
  user: z.string().min(1),
  password: z.string().min(1),
});
export type SmtpAuth = z.infer<typeof smtpAuthSchema>;

/**
 * The five fields of a transport, written **once**.
 *
 * One object rather than a spelling per row, because two spellings are two
 * chances to add a field to one of them: a system block that grew a `secure`
 * the organisation's block does not have would be a difference nobody can see
 * until a mail goes out over the wrong kind of TLS. Since ADR-0023 there is
 * only one shape left in this file, and this object is why the collapse cost
 * nothing.
 */
const SMTP_BLOCK_FIELDS = {
  host: z.string().min(1),
  port: smtpPortSchema,
  /**
   * Implicit TLS from the first byte (`smtps`, usually port 465) rather than an
   * upgrade through `STARTTLS` (usually 587).
   *
   * **Required, and not „absent decides from the port".** A *stored* block has
   * no open fields — that was the point of making it a block. The convenient
   * default (465 → true) belongs in the surface that offers the field,
   * where a human sees it and can disagree with it, not in the
   * schema, where it would quietly decide the encryption of somebody else's
   * mail server.
   */
  secure: z.boolean(),
  /** The credentials, or `null` for a relay that wants no login. */
  auth: smtpAuthSchema.nullable(),
  /**
   * The address every mail of this sender goes out **from**.
   *
   * Part of the block, and that is the whole of the requirement: an own address
   * without an own transport is the SPF/DKIM forgery described above.
   *
   * A bare address, never `Name <address>`: the display name is a separate
   * property of the organisation and is put in front of this at send time.
   */
  from: z.email(),
} as const;

/**
 * A mail server — the document `system_setting.smtp` **and** `tenant.smtp`
 * hold since ADR-0023.
 *
 * `strictObject`, so an unknown key is a refusal rather than a value that is
 * silently dropped. A leftover `{"source":"system"}` from the days of
 * inheritance therefore does **not** parse, and that is the intended answer:
 * there is no installation to migrate (ADR-0023 „Context"), and a document
 * this application can no longer produce is one it refuses rather than
 * interprets (ADR-0013 no. 4).
 *
 * Its absence (SQL NULL) is „noch nicht eingerichtet", which is a state of its
 * own and explicitly **not** a fault — see {@link parseStoredSmtpBlock}.
 */
export const smtpBlockSchema = z.strictObject(SMTP_BLOCK_FIELDS);
export type SmtpBlock = z.infer<typeof smtpBlockSchema>;

/**
 * A stored mail server, read — or `null` for „nicht eingerichtet".
 *
 * **One function for both rows** (ADR-0023): the installation's block and an
 * organisation's are the same document in two places, and two readers would be
 * two chances for one of them to start tolerating something the other refuses.
 *
 * The two answers are different facts and are kept apart on purpose
 * (ADR-0013 no. 5): `null` leaves a queued row `queued`, because nothing was
 * attempted and nothing refused, and a mail server entered later still sends
 * it. A document that does not parse **throws**, and that is the other row of
 * the table — `failed` with a readable reason, decided by the worker and not
 * here.
 *
 * `undefined` reads like NULL on purpose, because a `select` that dropped the
 * column produces it — the callers that must not confuse the two say so where
 * they read a row (`MailIdentityService`, `MailWorkerService`).
 */
export function parseStoredSmtpBlock(stored: unknown): SmtpBlock | null {
  if (stored === null || stored === undefined) {
    return null;
  }
  return smtpBlockSchema.parse(stored);
}

/**
 * A parse failure of this module, as a line a human can act on: **the field
 * first**.
 *
 * what is required is exactly that — „ein halb gefüllter eigener Block parst
 * nicht, und die Meldung nennt das fehlende Feld". Zod's own `message` is a JSON
 * dump in which the reader has to find `path`, and this text ends up in
 * `mail_log.last_error`, where an editor reads it.
 *
 * **Values are deliberately not repeated.** A block carries a password; a
 * message that echoed what it choked on would be the one line that fails
 * the requirement.
 */
export function describeMailConfigError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.map(String).join('.');
      return field === '' ? issue.message : `${field}: ${issue.message}`;
    })
    .join('; ');
}

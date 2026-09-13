/**
 * What a **organisation's own** mail server is allowed to say about itself in
 * `mail_log.last_error` (ADR-0013 no. 4).
 *
 * ## Why the raw text cannot travel here
 *
 * By design, an organisation's admin names host and port, and the server dials
 * them. That is the point of Konzept no. 38 and a carried risk — a host allow-list
 * would break legitimate Organisationen. But the *reason* the queue stores is read back
 * by the same admin, and `describeMailError` passes the remote's own words
 * through: „connection refused" against „timed out" against a protocol error
 * distinguishes an open port from a closed one. Fill in `127.0.0.1:6379` or
 * `169.254.169.254:80`, read the mail log, and the mail log is
 * a port scanner run from inside the server's network.
 *
 * So an own block gets **categories**, not transcripts. „Lesbar" and
 * „kategorisiert" are compatible; „lesbar" and „wörtlich" are not the same
 * thing, and only the first is what for.
 *
 * ## Why only an own block
 *
 * A row that went out over the **system** block keeps the verbatim reason. The
 * host there was chosen by the superadmin, not by the reader, so nothing is
 * disclosed that the reader could not look up anyway — and a `535` from the
 * installation's own server is exactly the sentence its operator needs. The
 * oracle exists only where the reader also picks the target.
 *
 * ## What an editor can do with each of these
 *
 * The categories are the different *actions*: check the address and port, check
 * the credentials, look at the mail itself.
 *
 * **„Nicht erreichbar" and „keine Antwort" are one of them**, and they used not
 * to be. Two categories where the reader has one action („Adresse prüfen") are
 * two answers to a question nobody asked — but they are a perfectly good answer
 * to „is this port open?": `127.0.0.1:6379` (open, not SMTP) stalled and gave
 * *Zeitüberschreitung*, `127.0.0.1:6380` (closed) refused and gave *nicht
 * erreichbar*. The file claimed at this point that any finer distinction would
 * be scanner information; it then drew that very distinction, one screen down
 * (a review finding).
 *
 * ## What is left, said out loud rather than claimed away
 *
 * The oracle is narrowed here, not closed, and the file no longer pretends
 * otherwise:
 *
 * 1. **The send deadline of `mail-timeouts.ts` still travels verbatim.** It is
 *    this application's own sentence about a budget we chose, and it is the one
 *    reason that explains an attempt which ended without any answer — but it
 *    only ever fires when the connection *was* established and then stalled past
 *    every transport timeout, so its presence still marks „something answered"
 *    apart from „nothing did". Rare (the transport's own socket timeout is
 *    shorter and lands in the merged category), and kept because a reader who
 *    sees it can act on it.
 * 2. **The timing in the mail log.** A refusal is recorded in
 *    milliseconds, a stall after the transport's socket timeout; `created_at`
 *    and the next attempt are both visible to the same reader. No wording can
 *    take that away.
 *
 * Both are carried, not fixed here, and named in ADR-0013 „Consequences".
 */

/**
 * Nothing usable answered: host, port, name resolution — or a server that
 * accepted the connection and then said nothing.
 *
 * **One category for both**, see the block above: the action is the same
 * („Adresse, Port und Verschlüsselung prüfen"), and telling them apart is the
 * answer to a question only a scanner asks. The second sentence keeps what the
 * separate timeout category was worth to a reader: the queue tries again.
 */
export const MAIL_CATEGORY_UNREACHABLE =
  'Eine Verbindung zum Mailserver war nicht möglich oder es kam keine ' +
  'Antwort. Bitte Server-Adresse, Port und Verschlüsselung im Reiter ' +
  '„Mailversand" prüfen; der Versuch wird später wiederholt.';

/** The server answered and refused the login. */
export const MAIL_CATEGORY_AUTH =
  'Der Mailserver hat die Anmeldung abgelehnt. Bitte Benutzername und ' +
  'Passwort im Reiter „Mailversand" prüfen.';

/** Everything else — including anything unrecognised, which is the point. */
export const MAIL_CATEGORY_REJECTED =
  'Der Mailserver hat die Nachricht nicht angenommen.';

/**
 * `nodemailer`'s own error codes, mapped to the categories.
 *
 * Read off the error object defensively: it is a library's field, so it is
 * `unknown` until proven otherwise, and anything unrecognised falls through to
 * {@link MAIL_CATEGORY_REJECTED}. **Fail closed for the oracle** — a new code in
 * a future version becomes coarser, never more talkative.
 */
const CATEGORY_BY_CODE = new Map<string, string>([
  ['ECONNECTION', MAIL_CATEGORY_UNREACHABLE],
  ['ECONNREFUSED', MAIL_CATEGORY_UNREACHABLE],
  ['ENOTFOUND', MAIL_CATEGORY_UNREACHABLE],
  ['EHOSTUNREACH', MAIL_CATEGORY_UNREACHABLE],
  ['ENETUNREACH', MAIL_CATEGORY_UNREACHABLE],
  ['EDNS', MAIL_CATEGORY_UNREACHABLE],
  ['EAUTH', MAIL_CATEGORY_AUTH],
  // Merged with the four above on purpose — a stall and a refusal are the same
  // instruction to a reader and different answers to a port scan.
  ['ETIMEDOUT', MAIL_CATEGORY_UNREACHABLE],
  ['ETIMEOUT', MAIL_CATEGORY_UNREACHABLE],
  ['ESOCKET', MAIL_CATEGORY_UNREACHABLE],
]);

/**
 * One category for a delivery failure against an organisation's own mail server.
 *
 * @param ownReason a sentence **this application** produced and may therefore
 *   keep verbatim — the send deadline of `mail-timeouts.ts`. It names a number
 *   of seconds we chose and nothing about the remote, and dropping it would
 *   lose the one reason that explains why an attempt ended without an answer.
 */
export function categoriseMailError(error: unknown, ownReason: string): string {
  if (error instanceof Error && error.message === ownReason) {
    return ownReason;
  }
  const code = codeOf(error);
  return (
    (code === undefined ? undefined : CATEGORY_BY_CODE.get(code)) ??
    MAIL_CATEGORY_REJECTED
  );
}

/** The `code` a `nodemailer` error carries, if it carries a usable one. */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

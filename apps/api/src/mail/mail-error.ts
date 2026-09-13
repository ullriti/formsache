/**
 * Turns whatever a transport threw into the sentence `mail_log.last_error`
 * carries — readable for an editor, and free of anything from `.env`
 * (the requirements).
 */

/** Longest reason stored. A stack trace is not an explanation. */
export const MAIL_ERROR_MAX_LENGTH = 500;

/** What a redacted credential looks like in a stored reason. */
export const MAIL_ERROR_REDACTION = '[redigiert]';

/**
 * Shortest value that is worth redacting.
 *
 * A two-character password would match half the alphabet of every error
 * message; blanking those would make the reason unreadable without protecting
 * anything worth protecting.
 */
const MIN_REDACTABLE_LENGTH = 4;

/** German, because it is shown in the mail log. */
const UNKNOWN_REASON = 'Unbekannter Fehler beim Versand.';

/**
 * @param secrets values that must never end up in a column: the SMTP user and
 *   password of the block **this row went out under**. Passed in rather than
 *   read here, so this stays a pure function; they come from
 *   `mailCredentialsOf(identity.block)` at the handover rather than from `ApiEnv`
 *   or from state on the transport. With one transport per organisation, a „credentials
 *   I last used" field would redact Organisation B's error with Organisation A's password.
 *
 * **The redaction is a second fence, not the first.** The first is that nothing
 * in this module logs or stores the transport's configuration at all; that claim is
 * proven by capturing `stdout`/`stderr` over a full cycle and by searching
 * *every* column of the written rows. This exists because the one string we do
 * keep comes from a library we do not control — a server that answers
 * `535 5.7.8 authentication failed for user@…` decides what nodemailer puts in
 * `error.message`, and „the current version happens not to echo the password"
 * is not a property worth relying on.
 */
export function describeMailError(
  error: unknown,
  secrets: readonly (string | undefined)[] = [],
): string {
  const raw = error instanceof Error ? error.message.trim() : '';
  const message = raw === '' ? UNKNOWN_REASON : raw;
  return truncate(redact(message, secrets), MAIL_ERROR_MAX_LENGTH);
}

function redact(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  let result = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < MIN_REDACTABLE_LENGTH) {
      continue;
    }
    result = result.replaceAll(secret, MAIL_ERROR_REDACTION);
  }
  return result;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

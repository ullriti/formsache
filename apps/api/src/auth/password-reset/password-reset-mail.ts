import {
  PASSWORD_RESET_LINK_MARK,
  PASSWORD_RESET_TTL_MINUTES,
  collapseWhitespace,
} from '@formsache/shared';

/**
 * The text of the reset mail — fixed, German, without any template.
 *
 * **No notification template and no placeholder that somebody can edit.** An
 * organisation sets nothing here: the text is part of the sign-in path, not of
 * the form system, and a mail whose wording an organisation determines would be
 * a way to write something to somebody in the name of the installation that
 * looks like a system message.
 *
 * What goes in is therefore exactly two things: the name of the person and the
 * name of the organisation under whose sender the mail goes out. Both stand in
 * the database and are not an input of *this* call — somebody did write them,
 * however: `userNameSchema` and `tenantBrandingWriteSchema.name` respectively.
 * Since ADR-0026 both demand `isSingleLineText`, and {@link collapseWhitespace}
 * below is the second bolt for rows that came into being before this rule.
 * Without it a name with `\n` would produce additional lines in a mail that goes
 * out under the identity of the installation; here the channel was weaker than
 * with the invitation (the attacker chooses neither recipient nor point in
 * time), but it is the same channel.
 */

/**
 * The subject.
 *
 * Fixed and recognisable, so that the row in the mail log does not look like a
 * confirmed registration — the same consideration as with `TEST_MAIL_SUBJECT`.
 */
export const PASSWORD_RESET_SUBJECT = 'Formsache: Passwort zurücksetzen';

/**
 * The body, **with the mark instead of the address**.
 *
 * {@link PASSWORD_RESET_LINK_MARK} is the reason why this function has no `url`
 * argument and must not get one either: the body is frozen and displayed
 * (`mail_log.body_text`, mail log), the address comes into being only on
 * delivery. A caller who passed a finished address in here would put the
 * authority into a column that a read view outputs — see
 * `password-reset-token.ts` for the whole justification.
 */
export function passwordResetMailBody(
  personName: string,
  tenantName: string,
): string {
  return (
    `Hallo ${collapseWhitespace(personName)},\n\n` +
    `für Ihr Formsache-Konto wurde ein neues Passwort angefordert ` +
    `(Organisation „${collapseWhitespace(tenantName)}").\n\n` +
    `Über diese Adresse vergeben Sie ein neues Passwort:\n` +
    `${PASSWORD_RESET_LINK_MARK}\n\n` +
    `Der Link gilt ${String(PASSWORD_RESET_TTL_MINUTES)} Minuten und lässt ` +
    `sich genau einmal benutzen. Sobald Sie ihn benutzt haben, werden alle ` +
    `Ihre offenen Sitzungen beendet — auch auf anderen Geräten.\n\n` +
    `Waren Sie das nicht, brauchen Sie nichts zu tun: ohne den Link ändert ` +
    `sich an Ihrem Konto nichts, und er verfällt von allein.\n`
  );
}

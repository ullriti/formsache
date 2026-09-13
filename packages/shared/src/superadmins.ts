import { z } from 'zod';

import { emailAddressSchema, personNameSchema } from './auth.ts';

/**
 * **Who carries the system administration of this installation** (ADR-0029).
 *
 * Up to this point an installation got its *first* superadministrator via
 * `POST /api/setup` or `scripts/create-superadmin.sh` (ADR-0022) and a
 * **second** one via nothing at all: the command refuses as soon as accounts
 * exist, and `is_superadmin` was not settable through any route. The one
 * superadministrator was thereby a single point of failure — once they lose
 * their access, nobody gets to the system administration any more.
 *
 * This module is the wire contract of the surface that fixes that. It is
 * deliberately **small**: one list, one email address, nothing else.
 *
 * ## What deliberately is **not** here
 *
 * - **No `isSuperadmin` field.** Nowhere — neither in the request nor in the
 *   response as something writable. The appointment is the *route*, not a
 *   value in a document; whoever carries it out has passed the guard. The same
 *   line is drawn by `setupRequestSchema` (ADR-0022 §6), and for the same
 *   reason the request below is a `strictObject`.
 * - **No identifier of the target in the appointment.** {@link superadminPromoteSchema}
 *   carries an **address**, not a `userId`. The address is what a human knows
 *   of another person; an identifier they would have to copy down somewhere
 *   — and the only list that showed it would be a list of **all** accounts of
 *   the installation. That is exactly what does not exist here: the superadmin
 *   surface reads no members of an organisation (ADR-0029 §3).
 */

/**
 * A person who carries the system administration.
 *
 * **An account, not a membership** — unlike `tenantMemberSchema`, which
 * describes a person *in an organisation*. `is_superadmin` hangs off the
 * account and off no organisation (`SuperadminGuard`), and that is why this
 * row carries no group, no role and no permission flags either: there is only
 * the one property, and whoever stands in this list has it.
 *
 * `strictObject`, so that a later `...user` in the mapper does not quietly
 * bring along a password hash or an OIDC identity.
 */
export const superadminSchema = z.strictObject({
  userId: z.uuid(),
  email: z.email(),
  name: z.string().min(1),
  /**
   * **Whether this account is a member of at least one organisation.**
   *
   * No ornament, but the preview of a refusal: an account **without** a
   * membership whose appointment is withdrawn would be an account without a
   * place — and `deleteHomelessAccounts` (`tenancy/homeless-account.ts`)
   * deletes exactly that on the next cleanup run, `isSuperadmin: false` stands
   * literally in its `where`. The server therefore rejects the withdrawal; the
   * surface says so **beforehand**, instead of offering a button that can only
   * do 409.
   *
   * A number would be too much here: „in how many organisations" is a piece of
   * information about the installation that nobody needs for this decision.
   */
  hasMembership: z.boolean(),
  /**
   * **This account has never signed in** — neither with a password nor via
   * SSO.
   *
   * True for an open invitation in both of its forms (ADR-0024, ADR-0012 §3):
   * a locally invited account that has not yet set its first password, and an
   * SSO invitation whose `oidc_subject` is still missing. In both cases
   * **whoever holds the invitation link** resp. **whoever identifies themselves
   * to the sign-in service as this address** decides who administers the
   * installation.
   *
   * It is deliberately **not** an `accountKind` like in the member list of an
   * organisation: `deriveAccountKind` reads only the two OIDC columns and calls
   * a not yet redeemed *local* account `'local'` — bearable for a role list,
   * not for the widest granting of permissions in the application. This
   * question is asked directly and answered directly.
   */
  invitationPending: z.boolean(),
});
export type Superadmin = z.infer<typeof superadminSchema>;

/**
 * The list. An object and not a bare array, like every other list of this
 * application — so that it can grow without breaking the contract.
 */
export const superadminListSchema = z.strictObject({
  superadmins: z.array(superadminSchema),
});
export type SuperadminList = z.infer<typeof superadminListSchema>;

/**
 * **„Zum Superadministrator ernennen"** — the request.
 *
 * Exactly one field, and `emailAddressSchema` is the same normalisation with
 * which the sign-in finds its row (trim, lowercase). A separate
 * `.trim().toLowerCase()` call here would be a second spelling of the same
 * rule — and a path that normalises *differently* does not find the other
 * one's row.
 *
 * `strictObject`: an `isSuperadmin`, `userId` or `name` sent along is a 400 and
 * not a silently ignored field.
 */
export const superadminPromoteSchema = z.strictObject({
  email: emailAddressSchema,
  /**
   * **Der Name — für den Fall, dass es zu dieser Adresse noch kein Konto
   * gibt** (Review-Runde 3 Nr. 13).
   *
   * Der Befund kam als Wunsch: *„dort würde ich ja auch gerne jemanden
   * einladen, der in keiner Orga ist."* Bis dahin konnte diese Route nur
   * **ernennen**, wer schon ein Konto hat — und ein Konto entstand in dieser
   * Anwendung immer zusammen mit einer Mitgliedschaft. Wer die zweite Person
   * für die Systemverwaltung wollte, musste sie erst in irgendeine
   * Organisation aufnehmen.
   *
   * ⚠️ **Pflichtfeld, und bei einem vorhandenen Konto ohne Wirkung.** Das ist
   * kein Widerspruch, sondern der Grund: ein optionales Feld, dessen
   * Vorhandensein entscheidet, ob ein Konto **entsteht**, wäre die
   * gefährlichste Art von Bequemlichkeit — ein vergessenes Feld legte dann
   * kein Konto an, ein versehentlich gesetztes eines. So ist die Route
   * dieselbe, die Anfrage dieselbe, und was geschieht, entscheidet allein die
   * Frage „gibt es diese Adresse schon?".
   *
   * Bei einem vorhandenen Konto gilt weiterhin **dessen** Name: die Antwort
   * nennt den gespeicherten, nicht den getippten — dieselbe Regel, die die
   * Mitgliederverwaltung einer Organisation hat.
   */
  name: personNameSchema,
});
export type SuperadminPromote = z.infer<typeof superadminPromoteSchema>;

/**
 * Die Antwort auf „Person zur Systemverwaltung hinzufügen" — **die Zeile plus
 * das, was dabei geschehen ist** (Review-Runde 3 Nr. 13).
 *
 * Dieselbe Bauform wie `tenantMemberCreatedSchema` eine Ebene tiefer, und aus
 * demselben Grund: „ernannt" und „eingeladen" brauchen zwei verschiedene
 * Sätze, und aus der Zeile allein sind sie nicht zu unterscheiden.
 */
export const superadminAddedSchema = superadminSchema.extend({
  /**
   * Ob dabei ein Konto **entstanden** ist und eine Einladung hinausging.
   *
   * Es gibt kein Feld „die Einladung ging nicht hinaus": ein Fehlschlag ist
   * hier kein Ergebnis, sondern eine **Absage** (422). Sie geht an der
   * Warteschlange vorbei (`SuperadminInvitationService` sagt warum), es gäbe
   * also weder einen zweiten Versuch von selbst noch einen Eintrag zum
   * Nachlesen — ein Konto ohne zugestellte Einladung wäre ein Konto, das
   * niemand einlösen kann und dessen Adresse installationsweit belegt ist.
   * Der Server nimmt es deshalb wieder zurück, und der zweite Versuch ist
   * derselbe Knopf (`SuperadminsService.invite`).
   */
  invited: z.boolean(),
});
export type SuperadminAdded = z.infer<typeof superadminAddedSchema>;

/** The list, parsed — the client does not cast (`CONTRIBUTING.md`). */
export function parseSuperadminList(document: unknown): SuperadminList {
  return superadminListSchema.parse(document);
}

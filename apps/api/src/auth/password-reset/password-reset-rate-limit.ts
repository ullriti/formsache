import { createHash } from 'node:crypto';

/**
 * The **second** dimension of the limitation of „Passwort vergessen": the
 * address (ADR-0020).
 *
 * ## Why the origin alone does not suffice
 *
 * `@Throttle` counts per sender address (`clientAddress`). That binds how
 * fast **one** attacker may knock, and nothing else: whoever comes via a
 * botnet or a mobile network has a fresh counter per request —
 * and what they trigger with it is a mail to somebody else. A hundred
 * requests for the same address are a hundred mails in somebody else's mailbox,
 * each with a valid link. The counter per address is therefore no
 * fine polish, but the half that makes the abuse expensive at all.
 *
 * ## Why an overrun does **not** become visible
 *
 * If the quota is used up, nothing happens — and the route answers
 * exactly as otherwise. A `429` at this place would be the disclosure that the
 * whole route tries to avoid: it would come only for addresses that somebody
 * has requested often enough, and an attacker who provokes it would thereby
 * have a measuring device. The limitation is therefore a silent forgoing of the
 * mail, not an error.
 *
 * ## What is stored
 *
 * Not the address, but its SHA-256 — the counter needs only
 * equality. An application that keeps a list of requested addresses in
 * memory has built a directory, and a crash dump would be
 * a copy of it.
 *
 * ## The price, named
 *
 * The counter lives **in the process**, like that of signing in
 * (`login-rate-limit.ts`): a second instance doubles the quota, a restart
 * resets it. That is bearable as long as the installation is one container; a
 * shared store is a question of horizontal scaling and not of this one.
 */

/** How many reset mails one address may trigger per window. */
export const PASSWORD_RESET_PER_ADDRESS = 3;

/**
 * The length of the window.
 *
 * One hour, so the same span for which a link is valid: more than three open
 * links at the same time makes no sense for anybody who has forgotten their
 * password — and for the one who types somebody else's address, three
 * is already two too many.
 */
export const PASSWORD_RESET_WINDOW_MS = 3_600_000;

/**
 * How many addresses the counter carries at most at the same time.
 *
 * Without a cap the counter itself would be the attack: one request per invented
 * address, and the process grows along with it.
 *
 * ⚠️ **At the cap it is refused, not evicted** — and that is the core
 * of this finding. An eviction in insertion order (the first version)
 * was a **reset of the quota by flooding**: 20 000 invented
 * addresses pushed the victim's window out, after which three
 * mails were available again — arbitrarily often. The limitation per origin does
 * not catch that: `clientAddress` reduces IPv6 to a /64, and a VPS with a /48
 * has 65 536 of them. The result would have been mail bombing with *valid* links —
 * and because every new one devalues the previous one, the victim would in fact
 * no longer have been able to reset their password.
 *
 * "Generous" makes that more expensive, not impossible; the first comment at
 * this place drew exactly this wrong conclusion.
 *
 * **What a full counter costs is named:** a *new* address then gets
 * no mail until windows expire (at most one hour). Already
 * tracked addresses keep their window — nobody can evict them any more.
 * That is the fail-closed direction: in case of doubt no mail rather than one mail
 * too many. And long before the cap takes hold, {@link PASSWORD_RESET_PER_HOUR} does.
 */
const MAX_TRACKED_ADDRESSES = 20_000;

/**
 * How many reset mails the **whole installation** may trigger per hour.
 *
 * The third dimension, and the only one an attacker does not get around by more
 * addresses and not by more prefixes. Two hundred is ample for
 * an installation with thousands of accounts — a reset is a
 * rare event, and three dozen in an hour would already be a lot — and
 * at the same time low enough that a flood does not burden mail costs and
 * mailboxes.
 *
 * ⚠️ **The price is the flip side and stands in ADR-0020:** whoever burns the
 * two hundred takes them from everyone in that hour. That is the deliberately
 * chosen direction — the mail is the harmful thing, so it is capped, and the way
 * via the administration („Passwort setzen") stays open next to it.
 */
export const PASSWORD_RESET_PER_HOUR = 200;

/** What one address has already triggered in this window. */
interface Window {
  /** Start of the running window. */
  startedAt: number;
  count: number;
}

export class PasswordResetAddressLimiter {
  private readonly windows = new Map<string, Window>();

  /** The installation-wide window — the same shape, one entry. */
  private readonly installation: Window = { startedAt: 0, count: 0 };

  /**
   * Counts a request and answers whether it may trigger a mail.
   *
   * Counts **always**, even when it may not: otherwise an attacker could
   * hold the window open by knocking on, instead of filling it.
   *
   * The order is deliberate: first the address (so that its quota counts even
   * when the installation is already closed), then the installation.
   * This way an attacker cannot spare a victim's window by
   * emptying the global counter first.
   */
  allow(email: string, now: number = Date.now()): boolean {
    const perAddress = this.allowAddress(email, now);
    const perInstallation = this.allowInstallation(now);
    return perAddress && perInstallation;
  }

  private allowAddress(email: string, now: number): boolean {
    const key = keyOf(email);
    this.expire(now);

    const current = this.windows.get(key);
    if (current !== undefined) {
      current.count += 1;
      return current.count <= PASSWORD_RESET_PER_ADDRESS;
    }
    if (this.windows.size >= MAX_TRACKED_ADDRESSES) {
      // Refused instead of evicted — see {@link MAX_TRACKED_ADDRESSES}.
      return false;
    }
    this.windows.set(key, { startedAt: now, count: 1 });
    return true;
  }

  private allowInstallation(now: number): boolean {
    if (now - this.installation.startedAt >= PASSWORD_RESET_WINDOW_MS) {
      this.installation.startedAt = now;
      this.installation.count = 1;
      return true;
    }
    this.installation.count += 1;
    return this.installation.count <= PASSWORD_RESET_PER_HOUR;
  }

  /** Throws expired windows away — the only way entries go. */
  private expire(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= PASSWORD_RESET_WINDOW_MS) {
        this.windows.delete(key);
      }
    }
  }
}

/** Not the address, but its digest — see the head of this file. */
function keyOf(email: string): string {
  return createHash('sha256').update(email, 'utf8').digest('base64url');
}

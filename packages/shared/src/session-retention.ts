/**
 * How long a **dead** session row stays around (a review finding).
 *
 * ## What the finding was
 *
 * `session` rows were **never** deleted. Signing out sets `revoked_at`
 * (`updateMany`), expiry sets nothing at all — the row stayed, and
 * `schema.prisma` promised a purge job for it that `JobKind` did not know
 * about. The table grew monotonically, and it carries personal data (`user_id`,
 * timestamps, most recently chosen organization).
 *
 * ## Why seven days and not zero
 *
 * A session is dead the moment it has expired **or** been revoked; it is never
 * usable again after that, and for running the application `0` would be just as
 * correct. The week stands for the one case that `0` makes more expensive than
 * necessary: “since when am I signed out?” is a question that comes days later,
 * and the row is the only thing that answers it.
 *
 * Short enough that it does not amount to a movement profile — and
 * **considerably** shorter than the 90 days of the mail log, because a session
 * row says nothing about content, only about presence.
 *
 * ⚠️ **The number is a constant, not an environment variable** — the same
 * reasoning as with `TRASH_RETENTION_DAYS` and `MAIL_LOG_RETENTION_DAYS`: the
 * cadence of the run is an operations matter (`SESSION_PURGE_INTERVAL_MS`), the
 * retention period is a promise.
 */
export const SESSION_RETENTION_DAYS = 7;

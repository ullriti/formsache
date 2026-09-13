/**
 * The textual form a PostgreSQL `uuid` column accepts.
 *
 * Foreign ids are checked against it **before** the database sees them: an
 * unparseable literal makes PostgreSQL raise, and a 500 would tell the sender
 * that their string got that far. Every caller answers a malformed id exactly
 * as it answers an unknown one, which is what keeps the two indistinguishable.
 *
 * Lifted out of `forms.service.ts` when the fourth link of the guard chain
 * needed the same check: the guard reads a form id out of the
 * route before any service resolves it, and a second copy of this pattern would
 * be a second place where the „malformed answers like unknown" promise could
 * quietly stop holding.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ⚠️ **Not `z.uuid()`, and the difference is measurable.** Zod 4 checks the
 * *version and variant* nibbles; PostgreSQL and this pattern accept any
 * hexadecimal literal of the right shape. Measured:
 * `11111111-1111-1111-1111-111111111111` and
 * `abcdefab-cdef-abcd-efab-cdefabcdefab` pass here and fail `z.uuid()`.
 *
 * Three services carried a private `const uuidSchema = z.uuid()` until
 * 2026-08-12 — so the same id was "malformed" on one route and "unknown" on
 * another, and a row with such an id was editable through one door and
 * permanently 404 through the other. They read this function now. What decides
 * is what the *column* accepts, not what a generator happens to produce.
 */
/** Whether a foreign string is a uuid literal PostgreSQL would accept. */
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

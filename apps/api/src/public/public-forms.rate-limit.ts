/**
 * Rate limit of the public fill-in endpoints (`CONTRIBUTING.md`).
 *
 * These are the routes anyone on the internet may call, and unlike the login
 * they are *meant* to be called by strangers. So the limit is not there to
 * make them expensive — it is there to bound what a single address can do
 * before a Jahrestagung registration fills up with noise that an organisation then has
 * to sift by hand.
 *
 * **Thirty submissions per minute, per address.** Generous on purpose: an organisation's
 * office or a mobile carrier's CGNAT presents one address for many people, and
 * the concept expects around twenty people filling in at once at a registration
 * start. A limit that a real crowd trips is a limit that gets
 * raised in a hurry during the one hour it matters. It still caps an
 * unattended script at 43 200 rows a day from one address rather than as many
 * as the network carries.
 *
 * **Reading the form is not throttled.** Only the write is. A participant
 * loading the page, going back a step and reloading is normal behaviour, and
 * the read costs one indexed lookup; putting a counter on it would trip on the
 * legitimate case first.
 *
 * Which address is counted follows `TRUST_PROXY_HOPS`, exactly as for the
 * login (`auth/login-rate-limit.ts` carries that reasoning in full). Behind the
 * compose stack's nginx front door the header is *replaced*, so `1` there is
 * safe; the default `0` ignores it entirely.
 *
 * Two limits the same routes also carry, and which this one does not replace:
 * the JSON body limit from `app-setup.ts` (a submission is a document, not an
 * upload) and the schema validation derived from the form itself — a
 * submission that passes the counter still has to be a submission.
 */

export const PUBLIC_SUBMIT_RATE_LIMIT = {
  limit: 30,
  ttl: 60_000,
} as const;

/**
 * Rate limit of the public **read**.
 *
 * Reading was unthrottled at first, with a real argument behind it: a
 * participant loading the page, stepping back and reloading is normal
 * behaviour, and a tight counter trips on the honest case before it troubles
 * anyone else. What that argument does not answer is `CONTRIBUTING.md`, which
 * makes rate-limiting part of *every* public endpoint.
 *
 * So the limit is deliberately far above use rather than absent: **120 per
 * minute and address**. Twenty people at a registration start, each loading
 * and paging through a four-page form, come nowhere near it; an unattended
 * script is still bounded. A limit nobody legitimate can reach is the honest
 * middle between "no counter at all" and "a counter that fires on real users".
 *
 * ## What one read costs, and why the number no longer follows from it
 *
 * 120 was chosen against the cost of an indexed lookup plus a full Zod
 * parse. That is no longer what a read costs (a security review). A form carrying **any**
 * Veranstaltung with an Obergrenze also runs `takenSeats` on every public read
 * — a `SUM … GROUP BY` over `event_registration` joined to `response`, over
 * every row of that form, uncached. That is work proportional to the number of
 * answers taken so far, and it grows exactly where the traffic is: the
 * Jahrestagung registration in the hour after it opens is the form with both the
 * most readers and the most rows.
 *
 * **Measured** on 2026-08-01 (one PostgreSQL 16 next to the API, one bounded
 * Veranstaltung, one `event_registration` row per answer, 100 interleaved reads
 * per point after 200 warm-up reads, median of the whole request):
 *
 * | Answers   | with cap   | without cap | surcharge |
 * |-----------|-----------|-------------|-----------|
 * |  2 000    |  8.4 ms   |  5.4 ms     |  +3.0 ms  |
 * |  5 000    | 12.0 ms   |  6.5 ms     |  +5.5 ms  |
 * | 20 000    | 31.9 ms   |  7.1 ms     | +24.8 ms  |
 *
 * So the surcharge is roughly linear in the number of answers — about a
 * millisecond per 800 of them here — while the read of a form *without* an
 * Obergrenze stays flat, which is what says the growth is this query and not
 * the payload. Two things bound it today, and neither is a cache:
 * `takenIfBounded` skips the query entirely for the overwhelming majority of
 * forms, which carry no Veranstaltung at all, and the sum is one grouped scan
 * of the (`form_id`, `question_id`, `event_key`) index rather than a scan per
 * event.
 *
 * **The number stays at 120 all the same, and now as a decision rather than as
 * something derived.** What the figures above bound is the damage, not the
 * limit: 120 reads a minute at the worst point measured is some 3.8 s of server
 * time a minute from one address, i.e. a fraction of one core — an unattended
 * script is still capped, and the number that would trip is the number of
 * addresses, which no per-address counter answers. Lowering 120 would need a
 * measurement of the *legitimate* side (how many reads a real registration
 * start produces), and lowering it blind is exactly the mistake this limit was
 * set high to avoid. What is open is the query's cost itself: a cached count or
 * a counter column, decided on a measurement, not a smaller number chosen to
 * feel safe.
 */
export const PUBLIC_READ_RATE_LIMIT = {
  limit: 120,
  ttl: 60_000,
} as const;

/**
 * Rate limit of the **password gate** (bullets 4 and 5).
 *
 * **Ten attempts a minute, per address *and* per form.** The second dimension is
 * what {@link accessAttemptTracker} adds; without it the counter would be the
 * plain per-address one every other public route uses, and the rule asks
 * for both.
 *
 * Ten, not thirty: unlike a submission this request is a *guess*, and the whole
 * job of the number is to make guessing the slow way in. Somebody reading a word
 * off a circular letter mistypes it once or twice; ten leaves room for that and
 * for an organisation's office behind one address without a support call.
 *
 * ## The arithmetic, done properly
 *
 * The line that used to stand here — „14 400 Versuche am Tag gegen ein Wort wie
 * ‚Jahrestagung2026' ist keine Suche, die fertig wird" — compared the limit
 * against the word an example happened to use, and it was wrong twice:
 *
 * 1. **The word need not be long.** `formSettingsSchema` bounds it above
 *    (`PASSWORD_MAX`) and demands only that it is not blank after `trim` — one
 *    character is a valid access word. There is no work factor either: a guess
 *    costs one indexed lookup, one AES-GCM open and one HMAC. Against a
 *    dictionary of 10^4 to 10^6 candidates, 14 400 a day is 0.7 to 69 days from
 *    **one** address, and under a day from a hundred.
 * 2. **„One address" was IPv4 thinking.** The tracker used to key on the address
 *    verbatim, and an IPv6 subscriber holds a whole /64 — 2^64 of them — so the
 *    ceiling was not 14 400 a day but whatever the line carries.
 *
 * Point 2 is fixed rather than described: {@link accessAttemptTracker} keys
 * through `common/client-address.ts`, which reduces an IPv6 caller to their /64,
 * and the same key now backs every other limit in the application. Point 1 is
 * **not** fixed here and is not this file's to fix — a minimum length belongs in
 * `formSettingsSchema`, and adding one to a schema that also parses *stored*
 * documents would make a form whose word is shorter unreadable, i.e. permanently
 * shut. It is written down as an open point instead of being quietly filed under
 * „gedrosselt".
 *
 * What remains true, and is the honest version of the old sentence: this limit
 * makes guessing **slow from any one caller**, and it is the only thing in the
 * way of a distributed campaign — see below, where that is stated rather than
 * glossed over.
 *
 * ## Why there is no form-wide counter, and that is the deliberate part
 *
 * The tempting second limit — „n failed attempts on this form and the gate
 * closes for everybody" — is precisely the lever bullet 5 forbids. It would let
 * any stranger switch off the Jahrestagung registration of a whole organisation by typing
 * nonsense at it, from a single laptop, for as long as they felt like it. A
 * denial of service that costs the attacker nothing and the organisation a registration
 * period is a worse outcome than a word guessed slowly, especially for a word
 * whose leak is *planned for*: it travels by circular letter, and the concept
 * says so out loud — es ist eine Hürde, keine Autorisierung.
 *
 * „Global wird höchstens langsam gedeckelt" is read here as the permission it is
 * and not as a requirement: every cap that could be reached by an outsider's
 * traffic is a cap an outsider can use. What does bound the whole installation is
 * unchanged and does not single out a form — the read and submit limits above,
 * the JSON body limit, and the fact that a guess costs one indexed lookup, one
 * AES-GCM open and one HMAC.
 *
 * **Distributed guessing is not stopped by this, and nothing here pretends
 * otherwise.** An attacker with a thousand addresses gets a thousand buckets.
 * That is the honest consequence of refusing the form-wide lock, and it is the
 * right trade for a word that is handed around by design: what a password gate
 * keeps out is the casual passer-by who found the link, not a determined
 * campaign. Everything that actually protects the data — the deadline, the
 * response limit, the tenant boundary — is enforced independently of it.
 */
export const PUBLIC_ACCESS_RATE_LIMIT = {
  limit: 10,
  ttl: 60_000,
} as const;

/**
 * Rate limit of the **upload** (ADR-0014 no. 8).
 *
 * **Ten uploads a minute, per address *and* per form** — the same key the
 * password gate counts by (`address-form-tracker.ts`), and for the same reason
 * in both dimensions: per address because that is the only handle a public
 * route has on „who", per form because two forms of one organisation are two
 * independent things to fill in.
 *
 * Ten, because a form may carry several file questions and because somebody who
 * grabbed the wrong file uploads again. It is **not the binding limit** — that
 * is the per-address quota of no. 7 (25 MiB and 20 files waiting per form,
 * 100 MiB and 60 files an hour), enforced in `upload-quota.ts`. This number is
 * what stops an unattended script *before* it gets there, at a tenth of the
 * rate.
 *
 * **Never form-wide, and that is the deliberate part.** The tempting second
 * limit — „n Uploads auf dieses Formular und der Upload macht zu" — is the
 * lever the requirement (bullet 5) forbids: a stranger would switch off an organisation's Jahrestagung
 * registration from a single laptop by uploading valid, tiny PNGs. Every cap an
 * outsider's traffic can reach is a cap an outsider can use, and ADR-0014 no. 7
 * repeats the rule for the volume itself: what protects it is a counter per
 * address, plus operations (volume size, alarms), never a quota per form or per
 * Organisation.
 *
 * The distributed case stays open, exactly as it does for the access word: a
 * thousand addresses are a thousand allowances. That is the honest consequence
 * of refusing the form-wide lock, not an oversight.
 *
 * ## Ten per door, **thirty together** — the number that stood nowhere before
 *
 * `ThrottlerGuard.generateKey` builds the key from
 * `ClassName-handlerName-throttlerName-tracker`, so **per route**. There are
 * three upload doors (slug, edit token, draft token), and each gets
 * its own ten. Until a security review the comment at the draft door claimed
 * the opposite — „one budget across every draft
 * that address is continuing" —, and that described a shared counter
 * that never existed. *Measured on 2026-08-05, one address:* draft door 10×201,
 * then 429 — and immediately afterwards the same address at the slug door **201**.
 *
 * **It stays at three counters, and that is a decision.** A
 * shared bucket would only work if all three doors used the same
 * tracker; the slug door counts „address ⊕ form" (no. 8, both
 * dimensions), the two token doors have no form in the path and count
 * the bare address. Unifying them would mean striking the form dimension
 * out of no. 8 — a change to what the ADR lays down, for
 * a counter that is not the binding limit anyway. The same
 * decision was taken once already for {@link PUBLIC_SUBMIT_RATE_LIMIT}
 * (in an earlier review) and is spelled out there.
 *
 * **What this does not move is the amount on disk**, and that is
 * the reason the aggregate number is bearable: the four counters of no. 7
 * (`upload-quota.ts`) hang on `key.bucket`, and the two token doors share
 * the „bare address" bucket there. What an address can leave lying around in
 * unclaimed bytes and files is untouched by it — this
 * rate limit only slows down, it does not bound.
 *
 * *Both are nailed down as a case* (`apps/api/test/public/draft.spec.ts`,
 * „zählt je Tür, nicht je Adresse"): the measurement itself — ten 201, then 429,
 * afterwards the same address at the slug door 201 — **and the number of doors**,
 * counted from the `controllers` of the built module against {@link PUBLIC_UPLOAD_DOORS}.
 * Whoever registers a fourth door thereby turns this line red instead of
 * quietly overtaking it.
 */
export const PUBLIC_UPLOAD_RATE_LIMIT = {
  limit: 10,
  ttl: 60_000,
} as const;

/**
 * How many upload doors multiply {@link PUBLIC_UPLOAD_RATE_LIMIT} per
 * address — the number the aggregate value is measured against.
 *
 * A constant and not a `3` in the test, so that „there is a fourth
 * door now" is **one** place: whoever introduces it changes this value and
 * reads the paragraph above while doing so.
 */
export const PUBLIC_UPLOAD_DOORS = 3;

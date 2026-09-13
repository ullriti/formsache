/**
 * The honeypot rule of the requirement — one question, answered in one place.
 *
 * **What this decides is whether a *mail* is sent, never whether an answer is
 * kept.** That is the whole shape of the rule: „er unterdrückt die Mail,
 * nicht die Anmeldung". A password manager that fills a hidden field is a real
 * case, and a silently discarded registration is the data loss nobody notices —
 * so a filled decoy produces a `failed` row in `mail_log` with a readable
 * reason, and the `response` row is written exactly as it would have been.
 *
 * It is a **pure function in a module of its own**, next to
 * `public-forms.service.ts` rather than inside it, for the same reason
 * `settings-enforcement.ts` was split out: the service is the file every
 * submission of this application goes through, and a rule that lives there can
 * only be exercised by standing up a database, a form and a request. Here it is
 * exercised by calling it. The one call site belongs to
 * `public-forms.service.ts`, which also owns the `mail_log` reason text.
 *
 * ⚠️ **A honeypot never proves that it works — only that it does no harm.**
 * Everything asserted about it is negative: it must not lose a registration, it
 * must not disturb assistive technology, and it must not answer differently
 * from a success, or a bot calibrates against it. That is not a gap in the
 * evidence; it is the honest thing to say about the measure.
 */

/**
 * Whether the decoy field was filled in.
 *
 * The argument is the `honeypot` member of `submitResponseRequestSchema` as it
 * arrives — which is why all three of `string`, `null` and `undefined` are
 * accepted rather than just `string`: the field is optional on the wire (a
 * client that sends nothing is an ordinary client), and any value that is not a
 * string is normalised to `null` there instead of refusing the submission.
 * Taking `unknown` would have been the other option and the worse one: it would
 * invite a caller to hand over an unparsed body and would move the wire's
 * decision into this file.
 *
 * **„Ausgefüllt" means: contains at least one non-whitespace character.** The
 * four ways of being empty are all the same verdict —
 *
 * | offered | verdict |
 * |---|---|
 * | `undefined` (field absent) | not filled |
 * | `null` (unparsable value, normalised on the wire) | not filled |
 * | `''` | not filled — this is what the shipped client sends every time |
 * | `'   '`, `'\t\n'`, U+00A0 | not filled |
 * | `' x '` | **filled** |
 *
 * Whitespace-only is the interesting line, and it falls on the „leer" side
 * deliberately: a password manager or an autofill writes a plausible *value*
 * into a field, not a space, whereas a stray space is what a mangling proxy, a
 * copy-paste or a keyboard on a phone produces. Reading `' '` as „ausgefüllt"
 * would suppress the confirmation mail of a real registration — a false alarm
 * on the side that costs a participant their receipt.
 *
 * `/\S/` rather than `value.trim() !== ''`: same verdict, no allocation. The
 * field is unbounded on the wire on purpose (see `public-form.ts`), so the
 * value may be as large as the 100 KiB body limit allows, and there is no
 * reason to copy it in order to throw it away. `\S` is the negation of
 * JavaScript's whitespace class, which already covers the Unicode spaces,
 * U+00A0 and U+FEFF.
 */
export function isHoneypotFilled(offered: string | null | undefined): boolean {
  return typeof offered === 'string' && /\S/.test(offered);
}

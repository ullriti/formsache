/**
 * **A foreign value, made safe** — escaping, markup removal, and the one
 * function that does both jobs of an HTML insertion in the one order that is
 * safe.
 *
 * ## Why this is a module of its own
 *
 * Everything here stood in `mail-template.ts` until the HTML export needed it,
 * and the *reason* it moved is the whole point of the requirement: a second
 * consumer had to be able to reach {@link neutraliseHtml} without importing the
 * mail module. Left where it was, it was module-private, absent from
 * `index.ts`, and typed on `MailFormat` — three separate invitations to write it
 * again, and „nachbauen statt benutzen" is the defect this package is written
 * against.
 *
 * The history is not hypothetical. Once the escaping and the line-break
 * handling were spelled out twice — once for a substituted `{{frage:…}}` and
 * once inside `{{antworten}}` — and they drifted: the table's cells broke their
 * lines while a substituted answer arrived as one run-on paragraph. One mail,
 * two renderings of one value. The fix was to write it **once**, in one order,
 * and this module is that one place, now that two features stand on it.
 *
 * ## Three levels of trust, one alphabet each
 *
 * - Text an **administrator** wrote as markup stays markup — nothing here is
 *   applied to it (see `neutraliseLiteral` in `mail-template.ts`).
 * - A value a **stranger** typed into a public form is escaped
 *   ({@link neutraliseHtml}) or has its markup removed ({@link stripMarkup}),
 *   depending on the alphabet of the target.
 * - The *decision* which of the two applies belongs to the caller, because it
 *   is a property of the output — a mail in `text` format, an HTML table cell.
 *   That is why {@link neutraliseHtml} takes a string and nothing else: it does
 *   not know about mails, formats or exports, and cannot grow an opinion about
 *   them.
 *
 * Every function here is pure: no transport, no database, no I/O.
 */

/**
 * HTML escaping of one untrusted value.
 *
 * `&` first — the other replacements introduce `&`, and doing it later would
 * escape those again and write `&amp;lt;` into the output.
 *
 * Quotes are included although the mail renderer writes no attribute from an
 * untrusted value. That is on purpose and has since paid off twice: the edit
 * link is written into an `href`, and the HTML export puts a
 * question's caption into a document whose only defence is this function.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tags that separate two blocks of text rather than decorating one.
 *
 * They leave a line break behind when the markup goes; everything else
 * (`<b>`, `<span>`, `<a href=…>`, and an unterminated `<script`) leaves
 * nothing. `\b` after the name is what keeps `<bruder>` out of this list while
 * `<br/>`, `<br />` and `<p class="x">` are in it.
 */
const BLOCK_TAG = /^<\/?(?:p|br|div|li|tr|h[1-6])\b/i;

/**
 * Anything spelled like a tag, removed — the plain-text counterpart of
 * {@link escapeHtml} .
 *
 * `<` followed by a letter (optionally after `/`) up to the next `>`, or to
 * the end of the string if it never comes: an unterminated `<script` must not
 * survive either. `<` that is not the start of a tag stays, so „Preis <5 Euro"
 * keeps its meaning — removing more than markup would be silent data loss in a
 * mail that is supposed to reproduce an answer.
 *
 * **A block tag leaves a line break behind.** Removing it outright turned
 * `<p>Hallo</p><p>Danke.</p>` into „HalloDanke." — the alternative half of an
 * HTML notification, read by everyone on a plain-text client and by every spam
 * filter that looks at `text/plain`, arrived as one run-on paragraph. What is
 * dropped is the markup, not the structure it stood for.
 *
 * Applied to each segment **separately** (see `renderMailTemplate`). Stripping
 * the assembled string instead would let a value ending in `<a` swallow the
 * template text behind it up to the next `>`.
 */
export function stripMarkup(value: string): string {
  return value.replace(/<\/?[a-zA-Z][^>]*>?/g, (tag) =>
    BLOCK_TAG.test(tag) ? '\n' : '',
  );
}

/**
 * **How a foreign value is inserted into HTML** — escaped *and* broken, in
 * that order, in one place.
 *
 * **Escape first, break second.** The `<` of the `<br />` is added *after*
 * every `<` the value brought along has become `&lt;`, so a value can never
 * contribute markup — the reverse order would hand a stranger a tag, which is
 * the difference between „the answer says `<script>`" and „the file runs it".
 *
 * **Both halves, always.** They are one function and not two because the two
 * ways of getting this wrong sit at opposite ends: forget the escaping and a
 * public form becomes an injection into a document a Mitglied opens; forget
 * the break and a multi-line answer silently loses its structure. This produced
 * the second one exactly this way — the escaping was called from two places,
 * the break from one of them (review of `8797060`) — which is why a caller
 * cannot choose one half here.
 *
 * The signature carries **no format**: a caller that already knows it is
 * writing HTML has nothing left to decide. `MailFormat` used to be a parameter
 * and made the function unusable outside the mail module for no reason of its
 * own; the switch between the two alphabets stays with the caller that has a
 * format (`neutralise` in `mail-template.ts`).
 *
 * The `<br />` spelling rather than `<br>`: it is what the mail renderer has
 * always written, and the two paths must produce the same bytes for the same
 * value — that is the property this move exists to keep.
 */
export function neutraliseHtml(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br />');
}

/**
 * **Single-line, literally** — the condition on a foreign value that gets into
 * the body of a system mail of this installation (ADR-0026).
 *
 * ## The attack it stands against
 *
 * The name of a person and the name of an organisation travel verbatim into
 * the invitation, the reset and the password notification mail — texts this
 * application writes itself and that go beyond the **identity of the
 * installation** (ADR-0023). The HTML version is covered by {@link escapeHtml}
 * and {@link neutraliseHtml}; the **text version** is not: there a `\n` is not
 * a character but a new line. A name like
 * `Max\n\nDein Zugang läuft ab: https://boese.example` yields an SPF/DKIM
 * signed mail of the installation whose wording somebody else has determined —
 * and when a person is created the same caller chooses the mailbox on top of
 * that.
 *
 * ## Why a predicate and not a second `replace` chain
 *
 * Because the condition has to hold **where** the value comes about: at
 * `userNameSchema` and at the name of the organisation, not first in the body.
 * A value that does not reach the column at all cannot stand in any future
 * mail — {@link collapseWhitespace} beside it is the second bolt for rows that
 * were written before this rule or come out of a backup (the same two-gate
 * construction `branding.ts` describes for the colours).
 *
 * ## What the alphabet excludes — and what it costs
 *
 * `\p{Cc}` are the C0/C1 control characters and thereby `\n`, `\r` and `\t`;
 * `\p{Cf}` are the invisible format characters — the bidi marks (which can
 * re-sort a displayed line, „Trojan Source"), U+FEFF and the zero-width
 * joiners. The price is named and not argued away: a Persian name is written
 * more cleanly with ZWNJ (U+200C), and whoever types it in gets a refusal
 * here. That is the side this rule deliberately falls on — visible text stays
 * allowed, invisible does not.
 *
 * Spaces are foreign characters of no kind and stay permitted; the calling
 * schemas put `.trim()` in front of it.
 */
export const SINGLE_LINE_TEXT = /^[^\p{Cc}\p{Cf}]+$/u;

/** The sentence of the refusal — one version for every field that pronounces it. */
export const SINGLE_LINE_TEXT_MESSAGE =
  'Bitte ohne Zeilenumbrüche und unsichtbare Steuerzeichen.';

/** Does this value carry exclusively visible text? See {@link SINGLE_LINE_TEXT}. */
export function isSingleLineText(value: string): boolean {
  return SINGLE_LINE_TEXT.test(value);
}

/**
 * **Every whitespace into one space** — the second bolt, immediately before
 * the insertion into a mail body.
 *
 * {@link isSingleLineText} defends the column, this function the mail. It is
 * no substitute for the schema but the answer to the question "and what if
 * something does stand in the column after all?" — a row from the time before
 * this rule, from a restore, or from a write path somebody adds later. Exactly
 * the same division `branding.ts` describes between saving and delivering.
 *
 * Folded together instead of removed: a name whose characters would otherwise
 * melt into one another („Max\nMustermann" → „MaxMustermann") stays readable.
 * And `\p{Cf}` falls away entirely, because an invisible character is no word
 * spacing.
 */
export function collapseWhitespace(value: string): string {
  return value
    .replace(/\p{Cf}/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
}

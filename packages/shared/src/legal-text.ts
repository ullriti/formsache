/**
 * **A legal text, made safe** — the one allow-list that every legal text of
 * this application goes through before a stranger gets to see it.
 *
 * ## The attack this module stands against
 *
 * A legal text is free text that an editor writes and that ends up on a page
 * **called up by strangers** — the same situation as in ADR-0026, only without
 * its lifeline: there the foreign value is single-line
 * ({@link isSingleLineText}), here it needs paragraphs, lists, tables
 * and links. The obvious convenience — "legal texts need
 * formatting, so let HTML through" — would be a stored
 * cross-site-scripting hole on exactly the path that knows no login
 * (`docs/legal/README.md`, sections 5.6 and 7.8). The CSP catches a lot,
 * `style-src 'unsafe-inline'` stands open and a `javascript:` link all the
 * more so.
 *
 * ## The three rules that here are code instead of intention
 *
 * 1. **What is stored is plain text.** No markup language, no HTML —
 *    what stands in the column is exactly what someone typed
 *    (`legal.ts` sets the upper limit).
 * 2. **What is rendered is text.** This module produces **blocks**, not
 *    strings with angle brackets. Whoever renders with it does not call
 *    `dangerouslySetInnerHTML` at all, because there would be nothing to
 *    hand into it: `LegalBlock` carries text and intentions, no markup.
 * 3. **Structure only from a narrow allow-list** — paragraph, heading of
 *    second and third order, list, table, emphasis and link, and
 *    for the link exclusively `http:`, `https:`, `mailto:` and this
 *    application's own paths, **checked after parsing** (`new URL`), never via
 *    a string check. That is the same build as
 *    `safeExternalUrl` in `form-settings.ts` already has for the redirect
 *    address, and it is used here instead of rebuilt, as far as it fits.
 *
 * Everything that is not on the list — `<script>`, `<img onerror=…>`, a
 * `javascript:` target, a `data:` target —, is **not a special case and not a
 * rejection**: it is simply text. A legal text in which someone types `<b>`
 * shows `<b>`. That is the only interpretation that does not depend on a
 * deny-list being complete.
 *
 * ## Two consumers, one parser
 *
 * The same parser reads the **shipped template** (`legal-templates.ts`,
 * a text that this repository writes) and the **own text** of an
 * organisation (a text that a stranger writes). Two parsers would be two
 * allow-lists, and the second would be the one that drifts — the same reason
 * that `html-text.ts` gives for its existence. The price is written out:
 * the template may not use anything that a foreign text would not be allowed to.
 */

/** A text run within a paragraph, a cell or a list item. */
export type LegalInline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  /**
   * A link with a **checked** target.
   *
   * `href` has passed {@link safeLegalHref}; a target that fails does not
   * reach this branch at all, but becomes `text`. That is the
   * fail-closed direction: a `javascript:` target becomes visible,
   * dead text and never a clickable link.
   */
  | { readonly kind: 'link'; readonly href: string; readonly label: string }
  /**
   * **A gap** — a placeholder of the template that nobody has filled in.
   *
   * The reason why this branch exists instead of a substitution with the
   * empty string: a `[[PLATZHALTER]]` that is published unchecked
   * is worse than an empty field (`docs/legal/README.md`, section 5.4),
   * and silently inserting nothing would be the third, worst
   * possibility — then the page would claim a complete statement that it
   * does not have. Visibly named, the page tells the truth about itself.
   */
  | { readonly kind: 'gap'; readonly label: string };

/** A block of a legal text. */
export type LegalBlock =
  | {
      readonly kind: 'heading';
      /** 2 or 3 — the allow-list does not yield more levels. */
      readonly level: 2 | 3;
      readonly runs: readonly LegalInline[];
    }
  | { readonly kind: 'paragraph'; readonly runs: readonly LegalInline[] }
  | {
      readonly kind: 'list';
      readonly items: readonly (readonly LegalInline[])[];
    }
  | {
      readonly kind: 'table';
      readonly head: readonly (readonly LegalInline[])[];
      readonly rows: readonly (readonly (readonly LegalInline[])[])[];
    };

/**
 * The characters that disappear before anything else — control characters
 * except the line break, and the invisible formatting characters.
 *
 * Two reasons, and the second is the more important one:
 *
 * 1. `\p{Cf}` are the bidi marks ("Trojan Source"): a displayed line
 *    that is read the other way round than it is stored is, in a
 *    legal text, no curiosity but a false statement made on purpose.
 * 2. {@link substituteSlots} inserts placeholders via **sentinels**, and a
 *    foreign value that contained a sentinel could feign a gap.
 *    After this line it can no longer do so — the same two-gates build that
 *    `html-text.ts` draws between schema and body.
 */
const CONTROL_CHARS = /\p{Cf}|(?!\n)\p{Cc}/gu;

/**
 * Control characters (except `\n`) and invisible formatting characters
 * removed — **the gate for foreign values**.
 *
 * It explicitly removes the two sentinels **as well**, with which
 * {@link substituteSlots} marks a gap. That is exactly the bolt: a
 * foreign value that brought a sentinel along could otherwise feign a gap
 * that nobody has.
 */
export function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, '');
}

/**
 * The checked target of a link, or `null`.
 *
 * **Checked after parsing, never via a string check** — the rule
 * from `docs/legal/README.md` 5.6 no. 3, and the same one that `safeExternalUrl`
 * applies for the redirect address. A check like
 * `href.startsWith('http')` falls for `httpx:`, for `java\nscript:` and for
 * every character that a browser throws away before the colon; `new URL`
 * does not fall for it, because it reads the same grammar as the browser.
 *
 * **Three schemes and a fourth case**, and the fourth is the reason why
 * this does not simply call `safeExternalUrl`: the legal texts link to
 * one another (`/imprint`, `/o/<kurzname>/privacy`), and a *relative*
 * path is not an absolute address. It is therefore allowed separately.
 *
 * ## The own path, too, is **parsed**, not spelled out
 *
 * Until 2026-08-18 `trimmed.startsWith('//') ? null : trimmed` stood here —
 * a string check, underneath a comment that explicitly forbids string
 * checks. It caught `//boese.example` and let the
 * neighbouring spelling through:
 *
 * ```
 * '/\\boese.example'.startsWith('//')                       → false
 * new URL('/\\boese.example', 'https://formsache.example/')  → https://boese.example/
 * ```
 *
 * For the URL grammar a `\` after the first slash is the same as
 * a second slash. A legal text could thus write
 * `[Datenschutz](/\boese.example)`, and the participating person saw
 * on the fill-in page a link that looks like an own path and leads to
 * a foreign origin.
 *
 * What is checked here, too, is therefore **after parsing**: resolved against a
 * base, and the origin must have stayed the same. That does not enumerate
 * two prefixes by hand, but asks the parser the same thing that the
 * browser will ask it — and covers every further spelling that
 * the same grammar allows.
 *
 * What comes back is the **resolved** path, not the input: `new URL`
 * normalises in the process (`/a/../b` → `/b`, spaces → `%20`), and what the
 * browser would make of it anyway should be what stands there.
 */
const PATH_BASE = 'https://pfad-vergleich.invalid';
const PATH_BASE_ORIGIN = 'https://pfad-vergleich.invalid';

export function safeLegalHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  // The own path — resolved against a base and checked at the origin.
  // The base is deliberately an `.invalid` address: it is never resolved and
  // does not appear in the result, it serves solely as a point of comparison.
  if (trimmed.startsWith('/')) {
    let own: URL;
    try {
      own = new URL(trimmed, PATH_BASE);
    } catch {
      return null;
    }
    return own.origin === PATH_BASE_ORIGIN
      ? `${own.pathname}${own.search}${own.hash}`
      : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'mailto:'
  ) {
    return null;
  }
  return parsed.href;
}

// ---------------------------------------------------------------------------
// Placeholders and conditional blocks — the template language
// ---------------------------------------------------------------------------

/**
 * How a placeholder is written in a template: `[[SCHLUESSEL]]`.
 *
 * The spelling is that of the templates in `docs/legal/vorlagen/` and
 * deliberately so conspicuous, „dass es beim Korrekturlesen anspringt"
 * (`docs/legal/README.md`, section 8). It **never** survives rendering:
 * either a value or a named gap stands there.
 */
const SLOT_PATTERN = /\[\[([A-Z0-9_]+)\]\]/gu;

/** How a conditional block is written: `⟪WENN:schluessel⟫ … ⟪ENDE⟫`. */
const CONDITION_PATTERN = /⟪WENN:([a-z0-9-]+)⟫\n?([\s\S]*?)\n?⟪ENDE⟫\n?/gu;

/**
 * The two sentinels with which a gap travels through the parser.
 *
 * Two control characters, because they can occur in **no** text that gets
 * this far: {@link stripControlChars} takes them away from every foreign value
 * and every template, **before** {@link substituteSlots} sets them. A
 * marking made of visible characters (`{{…}}`, `⟦…⟧`) would be typable, and then
 * a legal text could claim a gap that does not exist at all.
 */
const GAP_OPEN = '\u0011';
const GAP_CLOSE = '\u0012';

/** All placeholder keys of a template, in order and without duplicates. */
export function slotKeysOf(template: string): readonly string[] {
  const keys: string[] = [];
  for (const match of template.matchAll(SLOT_PATTERN)) {
    const key = match[1] ?? '';
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/** All condition keys of a template, in order and without duplicates. */
export function conditionKeysOf(template: string): readonly string[] {
  const keys: string[] = [];
  for (const match of template.matchAll(CONDITION_PATTERN)) {
    const key = match[1] ?? '';
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Resolves the conditional blocks: what does not apply disappears **entirely**.
 *
 * "Entirely" is the promise of the templates themselves — the marker text never
 * belongs in the published text. An unknown condition counts as **not
 * fulfilled**: a block that nobody has decided about is a claim
 * that nobody has made, and it falls away instead of travelling along.
 */
export function resolveConditions(
  template: string,
  answers: Readonly<Record<string, boolean>>,
): string {
  return template.replace(
    CONDITION_PATTERN,
    (_match, key: string, body: string) =>
      answers[key] === true ? `${body}\n` : '',
  );
}

/**
 * Inserts the placeholders — and turns every open one into a **named
 * gap**.
 *
 * The return value names the open ones too, because the caller needs them: they
 * are the difference between "deposited" and "deposited, but not
 * finished", and this distinction decides the list of open items
 * **and** the warning notice on the public page.
 */
export function substituteSlots(
  template: string,
  values: Readonly<Record<string, string>>,
  labels: Readonly<Record<string, string>>,
): { readonly text: string; readonly missing: readonly string[] } {
  const missing: string[] = [];
  const text = stripControlChars(template).replace(
    SLOT_PATTERN,
    (_match, key: string) => {
      const filled = stripControlChars(values[key] ?? '').trim();
      if (filled !== '') {
        return filled;
      }
      if (!missing.includes(key)) {
        missing.push(key);
      }
      return `${GAP_OPEN}${labels[key] ?? key}${GAP_CLOSE}`;
    },
  );
  return { text, missing };
}

/**
 * **Die offenen Angaben, herausgenommen** — was die öffentliche Ansicht seit
 * Review-Runde 5 Nr. 1 bekommt.
 *
 * Der Befund war eine Beobachtung über das Aussehen und trifft eine Aussage
 * über die Wahrheit: *„unvollständige Angaben sollten nicht in der öffentlichen
 * Ansicht angezeigt werden."* Bis dahin stand auf einer halb ausgefüllten Seite
 * „Telefon: ⟨Angabe fehlt: Telefonnummer⟩" — und darüber ein Warnhinweis, der
 * sie aufzählte. Beides ist gegenüber Fremden eine Auskunft, die niemandem
 * hilft: wer die Lücke schließen kann, sieht sie in der Verwaltung, im
 * Veröffentlichen-Hinweis und in der Vorschau des Editors.
 *
 * ## Die Regel, und der Befund, der sie geschärft hat
 *
 * **Es zählt die Zeile, aber es entscheidet der Nachbar auf ihr:**
 *
 * - Kein Platzhalter auf der Zeile → sie bleibt, unangetastet.
 * - Alle Platzhalter der Zeile sind offen → die Zeile fällt weg. Sie besteht
 *   dann aus einer Beschriftung ohne Wert, und „Telefon: " ist kein Satz.
 * - **Mindestens einer ist ausgefüllt** → die Zeile bleibt, und nur die offene
 *   Stelle verschwindet daraus.
 *
 * Der dritte Fall ist der Grund, aus dem diese Funktion nicht einfach jede
 * Zeile mit einer Lücke streicht — die erste Fassung tat das, und ein Review
 * hat es nachgerechnet: die Anschrift der Vorlagen steht als **eine** Zeile
 * `[[PLZ]] [[ORT]]`. Wer nur den Ort hinterlegt hatte, verlor öffentlich auch
 * den Ort — eine Angabe, die dasteht und wahr ist, und § 18 Abs. 1 MStV
 * verlangt genau die.
 *
 * ⚠️ **Der Preis des dritten Falls, ausdrücklich:** auf einer gemischten Zeile
 * bleibt der umgebende Text stehen, auch wenn er nach der Lücke ins Leere
 * greift („Modell " ohne Modell). Das ist die kleinere Ungenauigkeit — die
 * größere wäre, die ausgefüllte Angabe daneben wegzuwerfen.
 *
 * **Zeilenweise und nicht absatzweise:** ein Absatz dieser Vorlagen trägt
 * mehrere Zeilen — eine Postanschrift ist ein Absatz mit Zeilenumbrüchen
 * ({@link parseLegalText}). Den Absatz zu streichen nähme die Straße mit,
 * wenn die Hausnummer fehlt.
 *
 * ## Vor der Ersetzung und nicht danach
 *
 * Nur hier ist noch zu sehen, **welche** Stelle welchem Feld gehörte: nach
 * {@link substituteSlots} steht auf der Zeile Text und ein Sentinel, und
 * „daneben stand ein ausgefüllter Platzhalter" ist daraus nicht mehr
 * ablesbar. Der Preis ist eine zweite Ersetzung für die öffentliche Fassung;
 * der Gewinn ist, dass **kein** Sentinel und kein `[[…]]` in ihr überhaupt
 * entstehen kann.
 *
 * `values` ist derselbe Krug, aus dem {@link substituteSlots} schöpft, und
 * „ausgefüllt" ist hier genau seine Prüfung — sonst gälte eine Angabe an der
 * einen Stelle als vorhanden und an der anderen als fehlend.
 *
 * ## Der eigene Text ist der leere Krug
 *
 * Ein `mode: 'custom'`-Text ruft dieselbe Funktion mit `{}`: dort ist jeder
 * `[[PLATZHALTER]]` offen, weil niemand ihn ersetzt hat, und die Regel fällt
 * auf „die Zeile geht" zusammen. Das ist richtig und nicht nur bequem — in
 * einem eigenen Text ist ein `[[…]]` kein Feld, nach dem die Anwendung gefragt
 * hat; niemand weiß, was dort hingehörte, und ein Rest der Zeile behauptete,
 * es sei der ganze Satz. Damit trifft es auch den Fall, den vorher nichts
 * traf: ein **Feldwert**, in den jemand `[[FOO]]` getippt hat.
 *
 * ⚠️ **Es ist kein Ersatz für den Zustand.** `incomplete` bleibt, was es war
 * (`legalPageStatus`): die Seite ist nicht fertig, und die Verwaltung sagt es
 * unverändert. Hier wird nur entschieden, was ein Fremder davon zu sehen
 * bekommt.
 */
export function withoutOpenSlots(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  const isFilled = (key: string): boolean =>
    stripControlChars(values[key] ?? '').trim() !== '';

  const kept: string[] = [];
  for (const line of template.split('\n')) {
    const keys = slotKeysOf(line);
    const open = keys.filter((key) => !isFilled(key));
    if (open.length === 0) {
      kept.push(line);
      continue;
    }
    if (open.length === keys.length) {
      // Nichts Ausgefülltes auf dieser Zeile — sie ist Beschriftung ohne Wert.
      continue;
    }
    kept.push(withoutSlots(line, open));
  }
  return kept.join('\n');
}

/**
 * Die genannten Platzhalter aus einer Zeile heraus — und die Fuge, die sie
 * hinterlassen, geschlossen.
 *
 * `„[[PLZ]] [[ORT]]"` mit fehlender Postleitzahl wird `„Musterstadt"` und nicht
 * `„ Musterstadt"`: der doppelte Abstand und der führende Abstand sind sichtbar
 * (in einer Tabellenzelle sogar als Einrückung), und sie sind die Spur dessen,
 * was hier gerade **nicht** gezeigt werden soll. Nur Abstände innerhalb der
 * Zeile, kein Umbruch — die Zeile bleibt eine Zeile.
 */
function withoutSlots(line: string, keys: readonly string[]): string {
  return line
    .replace(SLOT_PATTERN, (match, key: string) =>
      keys.includes(key) ? '' : match,
    )
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/^[ \t]+|[ \t]+$/gu, '');
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * A token of the inline allow-list, in exactly the order in which the search
 * runs. Everything that does not stand here is text — and that is the promise.
 */
const INLINE_PATTERN = new RegExp(
  [
    // A gap, as {@link substituteSlots} has set it.
    `${GAP_OPEN}([^${GAP_CLOSE}]*)${GAP_CLOSE}`,
    // `[Beschriftung](Ziel)` — the target may not contain a bracket.
    //
    // The two sentinels are **excluded** here, and that is no
    // detail: if a gap stood in the target of a link or in an emphasis,
    // the surrounding alternative would win and would carry the marking as
    // visible control characters into the text. This way the gap alternative
    // wins at this place — the sentence becomes ugly, but it does not lie.
    '\\[([^\\]\\n\\u0011\\u0012]+)\\]\\(([^)\\s\\u0011\\u0012]+)\\)',
    // `**Betonung**`
    '\\*\\*([^*\\n\\u0011\\u0012]+)\\*\\*',
    // A bare address. Punctuation at the end belongs to the sentence, not to
    // the link — otherwise „siehe https://example.org." swallows the full stop.
    // And the sentinels are excluded here too, for the same reason as above:
    // a gap immediately after an address does not belong in its target.
    '(?:https?:\\/\\/|mailto:)[^\\s<>"\\u0011\\u0012]*[^\\s<>".,;:!?)\\]\\u0011\\u0012]',
  ].join('|'),
  'gu',
);

/**
 * The same rejection as {@link CONTROL_CHARS}, only without the two sentinels.
 *
 * At this point they already stand in the text — {@link substituteSlots} has
 * set them, **after** every foreign value has gone through the strict gate.
 * A second strict pass would take away exactly the marking for whose
 * sake it exists.
 */
// Composed from {@link GAP_OPEN} and {@link GAP_CLOSE} instead of written out
// literally: the two sentinels **are** control characters, and a literal
// with them inside would be a second place where they stand — exactly the
// duplication at which the marking and its exception drift apart.
const LENIENT_CONTROL_CHARS = new RegExp(
  `\\p{Cf}|(?![\\n${GAP_OPEN}${GAP_CLOSE}])\\p{Cc}`,
  'gu',
);

/** Splits a line into runs — the inline half of the allow-list. */
export function parseInline(line: string): readonly LegalInline[] {
  const runs: LegalInline[] = [];
  let cursor = 0;

  const pushText = (text: string): void => {
    if (text === '') {
      return;
    }
    const previous = runs[runs.length - 1];
    if (previous?.kind === 'text') {
      runs[runs.length - 1] = { kind: 'text', text: previous.text + text };
      return;
    }
    runs.push({ kind: 'text', text });
  };

  for (const match of line.matchAll(INLINE_PATTERN)) {
    const start = match.index;
    pushText(line.slice(cursor, start));
    cursor = start + match[0].length;

    const [, gapLabel, linkLabel, linkHref, strong] = match;
    if (gapLabel !== undefined) {
      runs.push({ kind: 'gap', label: gapLabel });
    } else if (linkLabel !== undefined && linkHref !== undefined) {
      const href = safeLegalHref(linkHref);
      if (href === null) {
        // Fail closed: an impermissible target becomes visible text and
        // never a link. The label stays put, so that the sentence can still
        // be read — and the target next to it, so that nobody believes
        // the application has swallowed something.
        pushText(`${linkLabel} (${linkHref})`);
      } else {
        runs.push({ kind: 'link', href, label: linkLabel });
      }
    } else if (strong !== undefined) {
      runs.push({ kind: 'strong', text: strong });
    } else {
      const href = safeLegalHref(match[0]);
      if (href === null) {
        pushText(match[0]);
      } else {
        runs.push({ kind: 'link', href, label: match[0] });
      }
    }
  }

  pushText(line.slice(cursor));
  return runs;
}

/** Cells of a table row — `| a | b |` without the outer bars. */
function tableCells(line: string): readonly string[] {
  return line
    .slice(1, line.endsWith('|') ? -1 : undefined)
    .split('|')
    .map((cell) => cell.trim());
}

/** Whether a line is the separator line of a table (`|---|---|`). */
function isTableRule(line: string): boolean {
  return /^\|(?:\s*:?-{1,}:?\s*\|)+$/u.test(line);
}

/**
 * Die **Kopfzeilen** aller Tabellen eines Textes — für `templateDefects`.
 *
 * Sie werden gebraucht, seit {@link withoutGapLines} Zeilen streichen kann: eine
 * Kopfzeile mit `[[PLATZHALTER]]` wäre die eine Zeile, deren Wegfall die
 * Tabelle zerlegt — die Trennzeile `|---|---|` bliebe ohne Kopf stehen und
 * würde als Absatz gelesen. Keine der ausgelieferten Vorlagen tut das (die
 * Platzhalter stehen in den Datenzeilen), und damit das so bleibt, ist es ein
 * benannter Vorlagenfehler und keine Gewohnheit.
 */
export function tableHeadLines(text: string): readonly string[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  return lines.filter(
    (line, index) =>
      line.trimEnd().startsWith('|') &&
      isTableRule((lines[index + 1] ?? '').trim()),
  );
}

/**
 * **The parser** — plain text in, blocks out, and nothing in between that
 * would be markup.
 *
 * Line by line and without state beyond the block: markup that
 * reaches across two blocks does not exist, so a value cannot swallow the
 * text behind it either — the same reason for which `stripMarkup` in
 * `html-text.ts` runs per section and not over the assembled string.
 */
export function parseLegalText(source: string): readonly LegalBlock[] {
  // **Not** {@link stripControlChars}: this text has already passed the
  // gate, and the two sentinels of a gap must survive it.
  // Everything else falls nonetheless, so that a caller who forgets the gate
  // finds no second way here.
  const lines = source
    .replace(LENIENT_CONTROL_CHARS, '')
    .replace(/\r\n?/gu, '\n')
    .split('\n');
  const blocks: LegalBlock[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = (lines[index] ?? '').trimEnd();

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    const heading = /^(#{2,3})\s+(.*)$/u.exec(line);
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: heading[1] === '##' ? 2 : 3,
        runs: parseInline((heading[2] ?? '').trim()),
      });
      index += 1;
      continue;
    }

    if (line.startsWith('- ')) {
      const items: (readonly LegalInline[])[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('- ')) {
        items.push(parseInline((lines[index] ?? '').slice(2).trim()));
        index += 1;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }

    if (line.startsWith('|') && isTableRule((lines[index + 1] ?? '').trim())) {
      const head = tableCells(line).map((cell) => parseInline(cell));
      index += 2;
      const rows: (readonly (readonly LegalInline[])[])[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? '').trimEnd().startsWith('|')
      ) {
        rows.push(
          tableCells((lines[index] ?? '').trimEnd()).map((cell) =>
            parseInline(cell),
          ),
        );
        index += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    // A paragraph reaches to the next blank line or to the next
    // line that starts something else. The individual lines are preserved:
    // a postal address is a paragraph with line breaks and not a list.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = (lines[index] ?? '').trimEnd();
      if (
        next.trim() === '' ||
        next.startsWith('- ') ||
        /^#{2,3}\s/u.test(next) ||
        next.startsWith('|')
      ) {
        break;
      }
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join('\n')) });
  }

  return blocks;
}

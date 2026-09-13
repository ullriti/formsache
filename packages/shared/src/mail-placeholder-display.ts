import { z } from 'zod';

import type { Question } from './form-schema.ts';
import {
  QUESTION_PLACEHOLDER_PREFIX,
  questionPlaceholderToken,
} from './mail.ts';

/**
 * The editor-facing half of a question placeholder — **id stored, caption
 * shown** .
 *
 * `{{frage:<id>}}` is what a notification's `subject`/`body` hold on the wire
 * and always has, and that does not change here: `NotificationEditor` still
 * saves exactly that. What changed is what an administrator *reads* while
 * writing the template — an id is not a caption, and an editor who has to
 * remember which UUID means „E-Mail-Adresse" is the half-built state this
 * module finishes.
 *
 * Two pure functions, deliberately decoupled from `scanPlaceholders` /
 * `placeholderPattern` in `mail.ts`: those describe the **stored** grammar,
 * whose inner character class (`[A-Za-z0-9_.:-]+`) fits a uuid and was never
 * meant to fit a German question caption — „Wie heißt dein Organisation?" has a space
 * and a question mark, neither of which that class allows. Reusing it here
 * would make `toDisplayForm` produce text `toStorageForm` cannot always parse
 * back. The grammar this module enforces instead is the one the
 * specification actually names: a caption may hold anything **except** `{`,
 * `}` or a line break — the three characters that would make `{{frage:…}}`
 * ambiguous to cut back apart. That is deliberately wider than `mail.ts`'s
 * class; see the module-level caveat below for what that gap still costs.
 *
 * ## The two traps this is built against
 *
 * 1. **Two questions, one caption.** If a caption is not unique across the
 *    form, showing it on two different placeholders is a lie one of them
 *    tells, and writing it back cannot tell which id it meant — exactly the
 *    failure that rejected the caption-only design in the first
 *    place. Such a caption is not eligible for the short form at all: its
 *    placeholder stays `{{frage:<id>}}`, in the editor and on the wire alike.
 * 2. **A caption that breaks the grammar.** `{`, `}` and a line break inside
 *    a caption make `{{frage:<caption>}}` impossible to delimit unambiguously
 *    — same rule, same outcome: no short form for that question.
 *
 * A caption is therefore usable for the short form exactly when it is
 * **unique among the questions passed in** and **contains none of those three
 * characters** — computed by {@link convertibleLabels}. Everything else about
 * this module follows from that one set.
 *
 * ## What is intentionally *not* handled
 *
 * A caption that used to be convertible and stops being so — renamed to
 * collide with another question, or edited to include a `{` — makes the
 * placeholders **already sitting in a draft that has not been saved yet**
 * fall back to whatever `toDisplayForm` was already showing; nothing here
 * reaches into an open editor to rewrite it. That is `NotificationEditor`'s
 * concern (it reconverts on load, not on every keystroke — see its module
 * comment), not this module's.
 *
 * ## The gap against `mail.ts`'s stored grammar, and why it stays unwidened
 *
 * A caption containing a character outside `[A-Za-z0-9_.:-]+` — a space, an
 * umlaut, „ or ? — produces a *display*-form token
 * (`{{frage:Wie heißt dein Organisation?}}`) that `scanPlaceholders` cannot match at
 * all, because its regular expression is narrower than the „no `{`, `}`, line
 * break" rule this module was told to enforce. That token round-trips
 * correctly through `toStorageForm` as long as it starts life as a value
 * `toDisplayForm` produced and names a real, convertible question — the
 * common case, and the one every fixture used to only exercise.
 *
 * Where it **fails to round-trip** — a caption that never matched a question
 * at all, typed by hand or left over after a rename/deletion — is exactly
 * the case `scanPlaceholders`/`unknownPlaceholders` also cannot see, for the
 * same reason: their pattern does not match a caption with a space either.
 * Widening `placeholderPattern` to match would be *a* fix, and is
 * deliberately not made here — it is `mail.ts`'s regex, used by rendering and
 * the publish lock well beyond this module, and widening what counts as
 * „placeholder-shaped" everywhere is a larger, separate decision than the one
 * this module owns. Instead {@link unresolvedQuestionCaptions} below reports
 * exactly this case on its own terms, so the caller — `draftProblems` in
 * `apps/web` — can refuse to save a draft that would otherwise carry an
 * un-flagged, un-resolvable caption straight into a sent mail.
 */

/** Characters that make `{{frage:<caption>}}` ambiguous to parse back apart. */
const UNSAFE_CAPTION_PATTERN = /[{}\r\n]/;

/** A fresh matcher for a question placeholder in **either** form — id or caption. */
function questionTokenPattern(): RegExp {
  // Mirrors `placeholderPattern()`'s tolerance for inner whitespace around the
  // token as a whole, but the captured content itself is „anything but the
  // three grammar-breaking characters" rather than `mail.ts`'s narrower class
  // — see the module caveat above for exactly what that trades away. A fresh
  // `RegExp` per call, not a module-scope constant, for the same reason
  // `placeholderPattern()` is a function: the `g` flag carries `lastIndex`
  // between calls, and this module has three callers of its own already.
  return new RegExp(
    `\\{\\{\\s*${QUESTION_PLACEHOLDER_PREFIX}([^{}\\r\\n]+)\\}\\}`,
    'g',
  );
}

/**
 * The captions eligible for the short form: unique among `questions` and free
 * of the three grammar-breaking characters (traps 1 and 2 above).
 */
function convertibleLabels(
  questions: readonly Question[],
): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const question of questions) {
    counts.set(question.label, (counts.get(question.label) ?? 0) + 1);
  }

  const convertible = new Set<string>();
  for (const [label, count] of counts) {
    if (count === 1 && label !== '' && !UNSAFE_CAPTION_PATTERN.test(label)) {
      convertible.add(label);
    }
  }
  return convertible;
}

/**
 * Whether `inner` is shaped like a question id rather than a typed caption.
 *
 * Question ids are `z.uuid()`-validated UUIDs by construction
 * (`form-schema.ts`) — nobody types one by hand. This is what tells an
 * already-resolved `{{frage:<id>}}` sitting in text (including one whose
 * question has since been deleted — a *different* gap, owned by the publish
 * lock at `findOrphanedPlaceholders`/C1a, not this module) apart from a
 * caption that never resolved to anything at all, which is what
 * {@link unresolvedQuestionCaptions} reports.
 */
function looksLikeQuestionId(inner: string): boolean {
  return z.uuid().safeParse(inner).success;
}

/**
 * Captions inside `{{frage:<caption>}}` that name no current, uniquely
 * captioned question of `questions` — precisely the fragments
 * {@link toStorageForm} leaves standing untouched (trap 3) because it has
 * nothing to turn them into.
 *
 * This is the gap the module caveat above names: such a fragment is not
 * recognised by `unknownPlaceholders`/`scanPlaceholders` either (their
 * pattern does not allow the space a German caption almost always has), so
 * without this function it can sit in a saved notification, unflagged,
 * until the moment a mail goes out carrying the raw `{{frage:…}}` text no
 * recipient can make sense of. Its one caller, `draftProblems` in
 * `apps/web`, turns that into a save-time refusal rather than a silent
 * round-trip failure.
 *
 * Deliberately blind to an id-shaped token (`looksLikeQuestionId`) — a
 * dangling reference to a *deleted* question is a real problem too, but it
 * already has an owner (the publish lock, C1a) that this project decided
 * should catch it at publish, not at every keystroke of every later edit;
 * conflating the two here would block a save that lock is explicitly built
 * to allow.
 */
export function unresolvedQuestionCaptions(
  text: string,
  questions: readonly Question[],
): string[] {
  const convertible = convertibleLabels(questions);
  const found = new Set<string>();

  for (const match of text.matchAll(questionTokenPattern())) {
    const inner = match[1];
    if (
      inner !== undefined &&
      !convertible.has(inner) &&
      !looksLikeQuestionId(inner)
    ) {
      found.add(inner);
    }
  }
  return [...found];
}

/**
 * `{{frage:<id>}}` → `{{frage:<caption>}}`, wherever the id names a question
 * with a convertible caption. Everything else — an unknown id, an ambiguous or
 * unsafe caption, a system placeholder, plain text — is returned unchanged.
 *
 * Applied **once**, when a stored notification is opened in the editor
 * (`NotificationEditor`) — not on every keystroke; see that module's comment
 * for why the field itself never re-runs this.
 */
export function toDisplayForm(
  text: string,
  questions: readonly Question[],
): string {
  const convertible = convertibleLabels(questions);
  const captionById = new Map(
    questions
      .filter((question) => convertible.has(question.label))
      .map((question) => [question.id, question.label] as const),
  );

  return text.replace(questionTokenPattern(), (raw, inner: string) => {
    const caption = captionById.get(inner);
    return caption === undefined ? raw : displayPlaceholderToken(caption);
  });
}

/**
 * `{{frage:<caption>}}` → `{{frage:<id>}}`, wherever the caption names exactly
 * one question with that convertible caption. A caption naming no current
 * question — deleted, renamed, or never real — is left **exactly as written**
 * (trap 3): it becomes an unknown placeholder to `unknownPlaceholders`, which
 * is the preview's visible warning rather than a silent drop.
 *
 * Applied **once**, when the editor saves (`NotificationEditor`/
 * `toWriteRequest`) and whenever the editor feeds a preview, which needs the
 * stored form to resolve anything (`NotificationPreview`).
 *
 * `toStorageForm(toDisplayForm(t, qs), qs) === t` for any `t` in which every
 * `{{frage:<id>}}` names a question in `qs` with a convertible caption — the
 * round trip this pair exists to guarantee (trap 4).
 */
export function toStorageForm(
  text: string,
  questions: readonly Question[],
): string {
  const convertible = convertibleLabels(questions);
  const idByLabel = new Map(
    questions
      .filter((question) => convertible.has(question.label))
      .map((question) => [question.label, question.id] as const),
  );

  return text.replace(questionTokenPattern(), (raw, inner: string) => {
    const id = idByLabel.get(inner);
    return id === undefined ? raw : questionPlaceholderToken(id);
  });
}

/** `{{frage:<caption>}}` — the display-form counterpart of `questionPlaceholderToken`. */
function displayPlaceholderToken(caption: string): string {
  return `{{${QUESTION_PLACEHOLDER_PREFIX}${caption}}}`;
}

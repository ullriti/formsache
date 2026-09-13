import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { questionTypeSchema } from './form-schema.ts';
import { NOTIFICATION_TEMPLATES_FLOOR } from './notification-templates.ts';

/**
 * **The structural guard — the one thing a
 * behavioural test cannot do here.**
 *
 * Both rules are about a fact that is written down *once*, and both are
 * invisible from the outside while the two copies happen to agree. One of them says it
 * in as many words: as long as `ADDRESS_QUESTION_TYPES` is exactly `['email']`,
 * one copy and two copies produce byte-identical behaviour, so every test in
 * this repository stays green if somebody puts the duplicate back. The same
 * holds for the delivered notification templates: a fallback constant sitting
 * beside the configurable document looks right until the day the superadmin
 * edits one of them.
 *
 * ## Why a test over the sources and not `no-restricted-syntax`
 *
 * A lint rule sees one file at a time. It can forbid a *declaration* (rule 1
 * below) and does that well — but it cannot say „dieser Satz steht schon in
 * einer anderen Datei" (rule 2), because the sentence it would have to compare
 * against would have to be written into `eslint.config.js`, which is precisely
 * the second copy the rule exists to forbid. A test can read the texts out of
 * the module that owns them and search for them, so the guard has no literal of
 * its own and cannot fall behind the templates it protects.
 *
 * ## What it forbids, exactly
 *
 * 1. **Defining** one of {@link GUARDED_IDENTIFIERS} outside
 *    `packages/shared/src`. Importing and using them stays free — that is the
 *    whole point of moving them here.
 * 2. Any distinctive **template text** turning up in a second file — every
 *    guarded field of every template, {@link GUARDED_FIELDS}.
 * 3. **Declaring** one of {@link FILE_SCOPED_IDENTIFIERS} anywhere but in the
 *    one file that owns it — the stricter form, for values that were duplicated
 *    *within* this package and so passed rule 1 unnoticed.
 * 4. A **full chain of `case '<fragetyp>':`** in a file that is not named in
 *    {@link QUESTION_SWITCH_OWNERS} — the *shape* rather than the name, because
 *    rules 1 and 3 both look for an identifier and a copy that was renamed on
 *    the way carries neither.
 *
 * All four rules look at the **whole repository** (see {@link SOURCE_ROOTS}), which
 * is the difference between a guard and a second piece of documentation: a list
 * of named roots catches a new file in a known place and misses a new place
 * entirely.
 *
 * *Reproductions (all three were run):* re-declaring `ADDRESS_QUESTION_TYPES`
 * in `apps/web/src/views/notifications/` fails rule 1; copying a template's
 * body into a second module fails rule 2; putting that copy in a **new
 * package** fails it too, which the earlier root list did not notice.
 */

/** Repo root — Vitest runs each workspace project from its own package root. */
const ROOT = resolve(process.cwd(), '..', '..');

/**
 * **The whole repository, minus what is not written by hand.**
 *
 * It used to be a list of named roots, and that was the one shape the rule
 * warns about: a maintained path list is a second piece of documentation, not a
 * guard. A new file under a known root was caught, but a whole new *place* —
 * `packages/<neu>/src`, `apps/<neu>/src`, `scripts/`, a root-level config —
 * would simply not be looked at, and the guard would stay green while the
 * duplicate sat there. A guard that fails *quietly* on the case it was built
 * for is worse than none.
 *
 * {@link SKIPPED_DIRECTORIES} is a maintained list too, and deliberately so:
 * the asymmetry is the whole point. Forgetting a *root* made the guard silently
 * green; forgetting a generated directory makes it slow or noisy, which is a
 * failure somebody notices and fixes. `docs/` needs no entry at all — prose
 * quoting a template is documentation, and `.md`/`.html` are not
 * {@link SOURCE_SUFFIXES}.
 */
const SOURCE_ROOTS = ['.'];

/**
 * Directories that hold no hand-written source, by name at any depth.
 *
 * `.git` for the obvious reason, and the rest because they are build output or
 * downloaded artefacts — `dist/` in particular holds compiled copies of the
 * very texts rule 2 searches for, and reporting those would make every run red
 * after a build. All of them appear in `.gitignore`; that file is not parsed
 * here, because a guard whose reach depends on a pattern language would need a
 * second guard for the parsing.
 */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.playwright',
  '.vite',
  '.venv',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'test-results',
  'playwright-report',
  'blob-report',
]);

/** The file that is allowed to hold all of this — the single source itself. */
const SINGLE_SOURCE = join('packages', 'shared', 'src');

const SOURCE_SUFFIXES = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.prisma'];

interface SourceFile {
  /** Repo-relative, with `/` separators whatever the platform uses. */
  readonly path: string;
  readonly text: string;
}

function collect(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // A root that does not exist in this checkout is not a failure of the
    // guard — but a *silently* skipped root would be, so the list is asserted
    // to be non-empty below.
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry.name) ? [] : collect(path);
    }
    return entry.isFile() &&
      SOURCE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
      ? [path]
      : [];
  });
}

const SOURCES: readonly SourceFile[] = SOURCE_ROOTS.flatMap((root) =>
  collect(join(ROOT, root)).map((path) => ({
    path: relative(ROOT, path).split(sep).join('/'),
    text: readFileSync(path, 'utf8'),
  })),
);

/**
 * The identifiers that may only be **declared** inside `packages/shared/src`.
 *
 * `NOTIFICATION_TEMPLATES` (without the suffix) is in here although nothing
 * declares it any more: it is the name the earlier constant had, and a
 * re-declaration under the old name is exactly how the second copy would come
 * back — quietly, and looking like the code that used to be right.
 *
 * The branding names are here for the same reason and
 * with a worse history: `hexColorSchema` and `HEX_COLOR`/`isBrandColor` stood
 * in two packages with **two different alphabets** — one accepted `#rgb` and
 * `#rrggbbaa`, the other was supposed to be the same rule. Two copies of a
 * security predicate are two places to narrow and one place to forget, and no
 * behavioural test can see the difference while they happen to agree.
 */
const GUARDED_IDENTIFIERS = [
  'ADDRESS_QUESTION_TYPES',
  'NOTIFICATION_TEMPLATES',
  'NOTIFICATION_TEMPLATES_FLOOR',
  'HEX_COLOR',
  'isBrandColor',
  'hexColorSchema',
  'TENANT_LOGO_REFS',
  'deliverableBranding',
  'USER_PASSWORD_MIN',
  'USER_PASSWORD_MAX',
];

/**
 * Identifiers whose single source is one **file**, not merely one package —
 * rule 3.
 *
 * Rule 1 asks „is this declared outside `packages/shared/src`?", and that is
 * blind to the way these three actually came back: `USER_PASSWORD_MIN = 12`,
 * `USER_PASSWORD_MAX = 1024` and the group ranks stood a second time in
 * `tenant-admin.ts` — *inside* the single-source package, a few files away from
 * the originals, where rule 1 looks straight past them. Each copy was invisible
 * from the outside in its own way:
 *
 * - `PASSWORD_MIN`: lowering the copy to `8` left the entire shared suite green,
 *   because each side derives its own test input from its own constant.
 * - `PASSWORD_HASH_INPUT_MAX`: two numbers here do not fail a request, they
 *   produce a password that can be set and not entered.
 * - `DEFAULT_GROUP_RANKS`: `editor: 61` instead of `60` left 22 test files green.
 *
 * So the guard names the owning file. Importing stays free — the entry is about
 * where the value is *written down*. Note this is strictly stronger than rule 1
 * for the names it covers, which is why they are not repeated in
 * {@link GUARDED_IDENTIFIERS}; the two `USER_PASSWORD_*` aliases are there
 * instead, because those are export names that must not turn back into numbers
 * anywhere else.
 */
const FILE_SCOPED_IDENTIFIERS: Readonly<Record<string, string>> = {
  PASSWORD_MIN: 'packages/shared/src/form-settings.ts',
  PASSWORD_MAX: 'packages/shared/src/form-settings.ts',
  PASSWORD_HASH_INPUT_MAX: 'packages/shared/src/auth.ts',
  /**
   * The base-address predicate. It stood in `env.ts` while
   * the address was an environment variable; now that it is read from two
   * columns and written by a route, a second copy would be the `hexColorSchema`
   * story again — two alphabets, and the narrower one is the one somebody
   * forgets.
   */
  normaliseBaseUrl: 'packages/shared/src/base-url.ts',
  ADMIN_GROUP_RANK: 'packages/shared/src/tenant-admin.ts',
  DEFAULT_GROUP_RANKS: 'packages/shared/src/tenant-admin.ts',
  /**
   * **The evaluation of the conditional display** (which
   * expressly demands: „eine Suche findet die Auswertung genau einmal").
   *
   * It is the case for which rule 1 would be too coarse and for which *no*
   * behavioural test suffices: a second evaluation in the client is a
   * function that behaves exactly like this one — until the day it
   * no longer does. Then a participant fills in a field the server
   * throws away, or does not see one the server demands; both
   * silently, and no check of either of the two sides sees it.
   *
   * `readingOf` stands here too, because a copy normally starts there: it
   * is the translation „Fragetyp → vergleichbarer Wert", that is, exactly the
   * piece that a view „quickly rebuilds" for its own display.
   *
   * **What this rule does not catch, and that is measured:** it catches the
   * copy *of the same name*, not the renamed one. `declarationPattern`
   * requires one of `const|let|var|function|class|enum|interface|type`
   * immediately before the name — the same function written as
   * `function isQuestionOnScreen`, as an object property
   * (`{ isQuestionOnScreen(…) {} }`) or as a class method,
   * all three at once in `apps/web/src/`, left all 24 cases green. The
   * rule is thus no guarantee but a brake against the one way
   * in which a copy comes about *by accident*: somebody writes it down under
   * the obvious name. The mechanisable rest stands as rule 4 below.
   */
  evaluateCondition: 'packages/shared/src/condition.ts',
  visibleQuestionIds: 'packages/shared/src/condition.ts',
  readingOf: 'packages/shared/src/condition.ts',
  /**
   * **„Die Quelle ist eine vorherige Frage"** — the same rule at two
   * points in time: the display evaluates it, the publish block
   * demands it. Exactly the kind of sentence one writes a second time when
   * building the block, because it fits into three lines there; two versions
   * of it mean that a form can be published whose condition the
   * evaluation subsequently does not resolve — and then a question is
   * silently shown that nobody wanted to show.
   */
  resolveConditionSource: 'packages/shared/src/condition.ts',
  /**
   * **The sentence of the refusal** (demanded verbatim:
   * „derselbe Text, den die 422 nennt").
   *
   * By now **three** surfaces say it to the same person about the same
   * draft: the 422 of `POST /forms/:id/publish`, the marker on the
   * question card (`condition-status.ts`) and the preview dialog. The dialog
   * is the place where the copy wants to come about — it has `defect` on the
   * wire and four `case` branches are quickly written there. Then the
   * preview explains the block differently from the refusal that enforces it,
   * and no test of either of the two sides sees it.
   *
   * As with the `evaluateCondition` entry above, the same holds here: what is
   * caught is the copy **of the same name** — a `switch (finding.defect)`
   * under a different name runs straight through this rule. The *renamed* one
   * is caught by the behavioural test „renders the finding in the words of the
   * refusal" in `apps/web/src/views/BuilderView.test.tsx`: it measures the
   * **rendered** sentence of the dialog against `unresolvableConditionText`
   * and goes red no matter what the second version is called.
   */
  unresolvableConditionText: 'packages/shared/src/condition.ts',
  UNRESOLVABLE_CONDITION_LEAD: 'packages/shared/src/condition.ts',
  /**
   * **The lead sentence of the placeholder block** , the twin
   * of the line above — and the proof that the concern there is not a
   * theoretical one: it *had* already been written twice. The 422
   * (`orphanedPlaceholderMessage`) ended after „austauschen oder entfernen.",
   * the preview dialog appended „– sonst ginge eine E-Mail ohne Empfänger oder
   * mit einer Lücke im Text hinaus." to it. Two versions of the same sentence
   * to the same person about the same draft, in lines that stand one below
   * the other in the dialog.
   *
   * Not in `condition.ts` but in `forms.ts`: the shape of the
   * placeholder finding stands there together with `PLACEHOLDER_PLACE_LABELS`,
   * with which it shares the same justification.
   */
  ORPHANED_PLACEHOLDER_LEAD: 'packages/shared/src/forms.ts',
  /**
   * **Escaping *and* wrapping, in this order** (which
   * demands it verbatim: „eine Funktion, die escapt *und* bricht, in dieser
   * Reihenfolge, an **einer** Stelle").
   *
   * The entry has a prehistory, and it is the reason for its
   * strictness: exactly this two-part step stood twice — once for an
   * inserted `{{frage:…}}` value, once in `{{antworten}}` — and the two
   * drifted apart. The table cell broke its lines, the inserted
   * value arrived as one continuous line. One mail, two renderings
   * of a value, and no test of either of the two sides saw it.
   *
   * By now **two** products hang on it — the notification and the
   * HTML export —, and the second is a security boundary: it is opened on
   * somebody else's computer and carries values that strangers submitted over
   * the public path. A copy would there not only be
   * a lost line break but the place at which somebody forgets the
   * escaping.
   *
   * As with the entries above: what is caught is the copy **of the same
   * name**. The renamed one is caught by `export-html.test.ts`, which loads
   * the generated file and measures it — there it does not matter what the
   * second version is called.
   */
  neutraliseHtml: 'packages/shared/src/html-text.ts',
  /**
   * **The alphabet of single-line foreign text** (ADR-0026) — bound for
   * the same reason as `neutraliseHtml` above, and with a
   * precedent: `hexColorSchema` once stood twice with two alphabets, and
   * the narrower version was the one somebody forgot.
   *
   * Here there would even be three places at which a copy wants to
   * come about — `userNameSchema`, the name of the organisation and the
   * caption of the SSO button —, and each of them is the condition for a
   * system mail of this installation carrying no line that somebody else
   * wrote. Two copies of a security predicate are not
   * defence in depth but two places to narrow and one to
   * forget.
   */
  SINGLE_LINE_TEXT: 'packages/shared/src/html-text.ts',
  isSingleLineText: 'packages/shared/src/html-text.ts',
  collapseWhitespace: 'packages/shared/src/html-text.ts',
  /**
   * **The one choice of columns** (which demands the entry
   * verbatim: „rot **nur, wenn `pickDefaultColumns` vorher in
   * `FILE_SCOPED_IDENTIFIERS` … eingetragen wurde**").
   *
   * By now table and export have **different defaults** —
   * three questions against all —, and that is exactly the situation in which
   * somebody writes a second function: `pickExportColumns` next to it is three
   * lines, and at first it does the same thing. Rule 1 would not see it (it
   * would stand in `packages/shared/src`), and **no behavioural test** would
   * see it as long as the two versions agree — until one of them skips the
   * retired column, counts the info-text question along or sorts the
   * timestamp in somewhere else. Then the file contains something other than
   * the screen, and that is the fault the function was split out
   * against in the first place.
   *
   * `DEFAULT_QUESTION_COLUMNS` stands here too, because the copy also
   * comes about the other way round: the constant is module-private, and `const
   * DEFAULT_QUESTION_COLUMNS = 3` in `ResponsesView.tsx` would be the number
   * in two places. That is why the default is an **argument** (`ColumnSurface`)
   * and not a number at the call site.
   *
   * As with the entries above: what is caught is the copy **of the same
   * name**. The renamed one is caught by the behavioural test „Tabelle und
   * Export an derselben Funktion" in `export-default-columns.test.ts`, which
   * takes both defaults from *this* export.
   */
  pickDefaultColumns: 'packages/shared/src/export-sheet.ts',
  DEFAULT_QUESTION_COLUMNS: 'packages/shared/src/export-sheet.ts',
};

/**
 * **The question-type switch** — rule 4, and the shape in which a copy
 * actually comes about.
 *
 * Rule 3 catches the name; it is blind to *renaming* (see there).
 * What a second evaluation does not get rid of, however, is its shape: whoever
 * writes „Fragetyp → anzeigbarer/vergleichbarer Wert" a second time
 * writes a **chain of `case '<fragetyp>':`** over the types of
 * {@link questionTypeSchema}. The name is freely chosen, the sixteen branches
 * are not.
 *
 * The threshold is measured, not estimated. Across the whole repository
 * the files with such a chain are distributed like this: nine carry 15 or
 * 16 branches (the full switches, named below), after that comes a long
 * gap — 5 (`public-forms.service.ts`, the four structured answer kinds
 * plus `event`) and 3 (`FieldInput.test.tsx`, the three choice kinds). Eight
 * lies in that gap: a partial switch over a few related types is
 * ordinary work and stays silent, a chain over half the type list is
 * a decision that somebody has to make.
 *
 * {@link QUESTION_SWITCH_OWNERS} is a maintained list too, and the asymmetry
 * is intended as with {@link SKIPPED_DIRECTORIES}: whoever forgets it
 * gets a **red** test with the file name in it, not a silently
 * green rule. An entry is not a formality but the answer to the
 * question of why this file has to know the types one by one.
 */
const QUESTION_SWITCH_OWNERS: Readonly<Record<string, string>> = {
  // The truth itself: answer schema per type, columns per type, reading per type.
  'packages/shared/src/response-validation.ts': 'answerSchemaFor',
  'packages/shared/src/answer-columns.ts': 'questionColumns',
  'packages/shared/src/condition.ts': 'readingOf',
  // The sample value per type. It does not *rebuild* a rule —
  // every candidate runs through `answerSchemaFor` —, but it has to know per
  // type what shape an answer even has, and that is a switch.
  'packages/shared/src/sample-answers.ts': 'candidatesFor',
  // The one place in the server that knows which type carries files.
  'apps/api/src/public/attachment-refs.ts': 'carriesAttachments',
  // The client: one control, one preview, one property sheet
  // and one default value per type. Those are renderings, not evaluations —
  // but this is exactly where a „quickly rebuilt" evaluation would land.
  'apps/web/src/fill/FieldInput.tsx': 'das Steuerelement je Typ',
  'apps/web/src/builder/QuestionPreview.tsx': 'die Bauflächen-Vorschau je Typ',
  'apps/web/src/builder/QuestionProperties.tsx':
    'das Eigenschaftenblatt je Typ',
  'apps/web/src/builder/question-defaults.ts': 'die neue Frage je Typ',
  'apps/web/src/views/notifications/sample-context.ts':
    'die Beispielantwort je Typ',
};

/** From how many branches a chain counts as a full switch — see above. */
const QUESTION_SWITCH_THRESHOLD = 8;

/**
 * How many question types this file lists one by one.
 *
 * The type list comes from {@link questionTypeSchema} and not from a
 * literal here — a list of its own would be the second spelling that this
 * file fights, and a seventeenth question type would not be covered by it.
 */
function questionCaseCount(text: string): number {
  return questionTypeSchema.options.filter((type) =>
    new RegExp(String.raw`case\s+'${type}'\s*:`).test(text),
  ).length;
}

/** `const x`, `let x`, `function x`, `type x`, `enum x`, `class x`, `interface x`. */
function declarationPattern(identifier: string): RegExp {
  return new RegExp(
    String.raw`\b(?:const|let|var|function|class|enum|interface|type)\s+${identifier}\b`,
  );
}

function isSingleSource(path: string): boolean {
  return path.startsWith(SINGLE_SOURCE.split(sep).join('/'));
}

/**
 * The fields of a template rule 2 covers.
 *
 * `name` is deliberately not among them. „Bestätigung an Teilnehmer" is also
 * the wording of an unrelated form setting („… senden") and stands in a dozen
 * fixtures; a guard firing on those would be reporting things that are not
 * copies, and a guard that cries wolf is switched off within a week. The three
 * below are the ones a copy would have to reproduce verbatim to be a copy.
 */
const GUARDED_FIELDS = ['description', 'subject', 'body'] as const;

/**
 * How long a piece of text has to be before it is searched for.
 *
 * Nine, the length of the shortest fragment any shipped template has — the
 * number exists only to keep pure scraps of markup out of the search, not to
 * leave a field unguarded, and the per-field test below is what enforces that
 * distinction. It has been checked once, by hand, that every fragment at this
 * length still resolves to the one owning file.
 *
 * Raising it is how the subject lines lost their protection before: at twenty
 * all three fell out, and only a count taken over the *whole* template hid it.
 *
 * **Nothing in this file may quote a template.** Rule 2 searches every file it
 * collects, including this one, so an illustrative example in a comment would
 * report itself — which is exactly the behaviour one wants, and exactly why the
 * comments here describe the texts instead of repeating them.
 */
const MIN_FRAGMENT_LENGTH = 9;

describe('the structural guard', () => {
  it('reads the sources it claims to read', () => {
    // Without this, a wrong `ROOT` would make every check below pass over an
    // empty list — the failure mode of a guard nobody would notice.
    expect(SOURCES.length).toBeGreaterThan(100);
    expect(
      SOURCES.filter((file) => file.path.startsWith('apps/api/src')).length,
    ).toBeGreaterThan(10);
    expect(
      SOURCES.filter((file) => file.path.startsWith('apps/web/src')).length,
    ).toBeGreaterThan(10);
  });

  describe('rule 1 — the identifier is declared in one package', () => {
    for (const identifier of GUARDED_IDENTIFIERS) {
      it(`declares ${identifier} only inside packages/shared/src`, () => {
        const pattern = declarationPattern(identifier);
        const offenders = SOURCES.filter(
          (file) => !isSingleSource(file.path) && pattern.test(file.text),
        ).map((file) => file.path);

        expect(
          offenders,
          `${identifier} is declared outside packages/shared/src — importing it is fine, ` +
            'declaring a second one is the duplication these rules forbid.',
        ).toEqual([]);
      });
    }
  });

  describe('rule 3 — the identifier is declared in one file', () => {
    for (const [identifier, owner] of Object.entries(FILE_SCOPED_IDENTIFIERS)) {
      it(`declares ${identifier} only in ${owner}`, () => {
        const pattern = declarationPattern(identifier);
        const holders = SOURCES.filter((file) => pattern.test(file.text)).map(
          (file) => file.path,
        );

        // `toEqual([owner])` rather than „no offenders": a guard that only
        // counts the wrong places stays green when the *right* place is renamed
        // away and every caller quietly grows its own copy instead.
        expect(
          holders,
          `${identifier} is declared in ${String(holders.length)} files. It is one ` +
            `value with one owner (${owner}); a second declaration — even inside ` +
            'packages/shared/src — is the duplication this rule exists for.',
        ).toEqual([owner]);
      });
    }
  });

  describe('rule 4 — the question-type switch exists where it was decided', () => {
    it('finds a full case chain only in the files that own one', () => {
      const found = SOURCES.filter(
        (file) => questionCaseCount(file.text) >= QUESTION_SWITCH_THRESHOLD,
      ).map((file) => file.path);

      const unexpected = found.filter(
        (path) => !(path in QUESTION_SWITCH_OWNERS),
      );
      expect(
        unexpected,
        'These files switch over most of the question types without being named ' +
          'in QUESTION_SWITCH_OWNERS. That shape is how a second evaluation of a ' +
          'Bedingung actually appears — rule 3 only catches it while it keeps the ' +
          'original name. If the file legitimately needs the types one by one, ' +
          'add it with the reason; if it is a second copy, import the original.',
      ).toEqual([]);

      // The other direction: an entry whose chain has disappeared is a
      // permission nobody needs any more — and the next copy
      // could land under exactly this path.
      expect(
        Object.keys(QUESTION_SWITCH_OWNERS).filter(
          (path) => !found.includes(path),
        ),
        'QUESTION_SWITCH_OWNERS names files that no longer carry a case chain.',
      ).toEqual([]);
    });

    it('would see a chain that rule 3 misses', () => {
      // The measured blind spot of rule 3, as an assertion: a
      // renamed copy carries the same branches. Built from the
      // type list, so that the case does not go stale on a literal.
      const renamedCopy = `function isQuestionOnScreen(q) { switch (q.type) { ${questionTypeSchema.options
        .map((type) => `case '${type}': return true;`)
        .join(' ')} } }`;

      expect(declarationPattern('readingOf').test(renamedCopy)).toBe(false);
      expect(questionCaseCount(renamedCopy)).toBeGreaterThanOrEqual(
        QUESTION_SWITCH_THRESHOLD,
      );
    });
  });

  describe('rule 2 — a template text exists once', () => {
    const fragmentsOf = (text: string): string[] =>
      text
        // Placeholders differ from installation to installation only in the
        // text around them, so the literal text between them is what a copy
        // would have to reproduce.
        .split(/\{\{[^{}]*\}\}/)
        .flatMap((part) => part.split('\n'))
        .map((part) => part.trim())
        .filter((part) => part.length >= MIN_FRAGMENT_LENGTH);

    /** Every field this rule covers, named — see {@link GUARDED_FIELDS}. */
    const fieldsOf = (
      template: (typeof NOTIFICATION_TEMPLATES_FLOOR)[number],
    ): readonly (readonly [(typeof GUARDED_FIELDS)[number], string])[] =>
      GUARDED_FIELDS.map((field) => [field, template[field]] as const);

    const fragmentsFor = (
      template: (typeof NOTIFICATION_TEMPLATES_FLOOR)[number],
    ): string[] => fieldsOf(template).flatMap(([, text]) => fragmentsOf(text));

    it('has something distinctive to search for, in every field of every template', () => {
      // The length filter is what makes rule 2 quiet; this is what keeps it
      // from becoming quiet altogether.
      //
      // **Asked per field, not per template** — that is the whole point.
      // Counted over all three fields together, one long body covered for two
      // fields that contributed nothing, and all three *subject* lines
      // contributed nothing: a subject is short by nature and falls apart at
      // its placeholders, leaving well under twenty characters. It is also the
      // line a recipient reads first; leaving it outside the guard while the
      // test said „distinctive" was the gap.
      for (const template of NOTIFICATION_TEMPLATES_FLOOR) {
        for (const [field, text] of fieldsOf(template)) {
          expect(
            fragmentsOf(text).length,
            `${template.id}.${field} has no fragment of ${String(MIN_FRAGMENT_LENGTH)} characters ` +
              'between its placeholders, so nothing about it is guarded. Either give it ' +
              'a sentence of its own or decide, in writing, that it may be copied.',
          ).toBeGreaterThan(0);
        }
      }
    });

    for (const template of NOTIFICATION_TEMPLATES_FLOOR) {
      it(`finds every text of „${template.name}" in one file only`, () => {
        for (const fragment of fragmentsFor(template)) {
          const holders = SOURCES.filter((file) =>
            file.text.includes(fragment),
          ).map((file) => file.path);

          expect(
            holders,
            `„${fragment}" stands in ${String(holders.length)} files — the delivered ` +
              'templates are a system setting and their text belongs in ' +
              'packages/shared/src/notification-templates.ts alone.',
          ).toEqual(['packages/shared/src/notification-templates.ts']);
        }
      });
    }
  });
});

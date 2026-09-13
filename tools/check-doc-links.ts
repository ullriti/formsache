/**
 * Dead-path guard for the knowledge documents (`docs/kb/`,
 * `docs/architecture/`).
 *
 * Every reference in the documentation is held against the file system: a
 * statement that points at a path which has moved documents something that is
 * no longer there.
 *
 * Three kinds of reference are held against the file system:
 *
 * 1. **Markdown links** `[text](target)` — resolved relative to the file they
 *    stand in, `#anchor` included.
 * 2. **Anchors** — against the headings of the target document, using GitHub's
 *    slug rules (lowercase, punctuation dropped, spaces to `-`, duplicates
 *    numbered), plus explicit `id=`/`name=` attributes.
 * 3. **Inline-code paths** `` `apps/api/src/thing.ts` `` — repository-relative,
 *    globs allowed. These carry the weight of evidence: a measure whose
 *    evidence path has moved documents a measure that is no longer there.
 *
 * Run standalone (`node tools/check-doc-links.ts`) or through
 * `scripts/check-ai-docs.sh`. Exit code 0 = clean, 1 = findings — each finding
 * is one line on stdout, in the `file:line — message` shape the shell wrapper
 * turns into a warning.
 */
import {
  existsSync,
  globSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The documents this guard is responsible for. */
const DOC_DIRS = ['docs/kb', 'docs/architecture'];

/**
 * Prefixes that make an inline-code span a repository path rather than prose.
 * A bare `README.md` in backticks is ambiguous — these prefixes are not.
 */
const REPO_PREFIXES = [
  'apps/',
  'packages/',
  'docs/',
  'scripts/',
  'tools/',
  'e2e/',
  '.github/',
];

/**
 * Paths that were **deliberately** removed or moved and are still named in the
 * documents that record *why* — a spec describing the state before a merge, an
 * ADR describing the entry point it retired. Rewriting those sentences would
 * erase the history the document exists for.
 *
 * The exception is guarded by itself: an entry whose path exists again is a
 * finding, so the list cannot quietly outlive its reason.
 */
const RETIRED_PATHS = new Map<string, string>([
  ['scripts/bootstrap.sh', 'the second entry point, folded into dev-setup.sh '],
  [
    'apps/api/test/auth/fake-idp.ts',
    'moved to packages/test-idp/src/fake-idp.ts',
  ],
  [
    'apps/web/src/views/notifications/address-questions.ts',
    'merged into packages/shared/src/address-questions.ts ',
  ],
]);

/**
 * Lower bounds. They exist against exactly one failure mode: a guard that
 * silently walks an **empty set** and reports success — the shape this project
 * has hit nine times (a wrong glob, a renamed folder, a filter that keeps
 * nothing). Each bound sits far below today's count, so ordinary editing never
 * trips it; only a collapse of the measured set does.
 *
 * **How far below is deliberately not written down here.** Each bound used to
 * carry a `// today: N` next to it, and every one of those numbers was wrong by
 * the time somebody read it — a review found them off by 3, 9, 1 and 18, and the
 * counts moved again while the finding was being fixed, because a single
 * documentation edit in another branch changes all four. A comment that cannot
 * survive one working day is not a record of the safety margin, it is a second
 * claim to keep in step.
 *
 * The guard prints the real counts on every run and is the only source worth
 * having, because it is measured rather than remembered:
 *
 *     node tools/check-doc-links.ts
 *     … documents · … links · … anchors · … inline-code paths — all resolve
 *
 * `scripts/tests/check-doc-links.test.sh` scenario 6 is what keeps the bounds honest:
 * it strips the documents down to two and requires this guard to go red.
 */
const MIN_DOCUMENTS = 20;
const MIN_LINKS = 90;
const MIN_ANCHORS = 8;
const MIN_CODE_PATHS = 180;

interface Finding {
  file: string;
  line: number;
  message: string;
}

const findings: Finding[] = [];
function report(file: string, line: number, message: string): void {
  findings.push({ file, line, message });
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

function listMarkdown(dir: string): string[] {
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(absolute, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    // `parentPath` is absolute; keep everything repository-relative so the
    // findings read like the paths a human types.
    out.push(relative(ROOT, join(entry.parentPath, entry.name)));
  }
  return out.sort();
}

/**
 * Strips fenced code blocks, keeping line numbers intact (fenced lines become
 * empty). A link inside a ``` block is an example, not a reference — checking
 * it would produce noise that trains readers to ignore this guard.
 */
function withoutFencedBlocks(source: string): string[] {
  const lines = source.split('\n');
  let fence: string | undefined;
  return lines.map((line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    const opener = match?.[1]?.[0];
    if (fence === undefined && opener !== undefined) {
      fence = opener;
      return '';
    }
    if (fence !== undefined) {
      const closing = opener === fence;
      if (closing) fence = undefined;
      return '';
    }
    return line;
  });
}

/* ------------------------------------------------------------------ */
/* Anchors                                                             */
/* ------------------------------------------------------------------ */

/**
 * GitHub's heading slug: drop markup, lowercase, drop everything that is not a
 * letter, digit, `_`, `-` or space, then spaces to `-`. Duplicates get `-1`,
 * `-2`, … in document order.
 */
function slug(headingText: string): string {
  return (
    headingText
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[*_~]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      // One dash per space, **not** per run: "Störfall 1 — der Mailserver"
      // loses the em dash and keeps both surrounding spaces, so the anchor is
      // `störfall-1--der-mailserver`. Collapsing here made every heading with a
      // dash look dead.
      .replace(/\s/g, '-')
  );
}

const anchorCache = new Map<string, Set<string>>();

function anchorsOf(absoluteFile: string): Set<string> {
  const cached = anchorCache.get(absoluteFile);
  if (cached) return cached;

  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let source: string;
  try {
    source = readFileSync(absoluteFile, 'utf8');
  } catch {
    anchorCache.set(absoluteFile, anchors);
    return anchors;
  }

  for (const line of withoutFencedBlocks(source)) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      const base = slug(heading[1]);
      if (base) {
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        anchors.add(count === 0 ? base : `${base}-${String(count)}`);
      }
    }
    // Explicit anchors, e.g. `<a id="x">` or `<a name="x">`.
    for (const explicit of line.matchAll(/<[^>]*\b(?:id|name)="([^"]+)"/g)) {
      const value = explicit[1];
      if (value !== undefined) anchors.add(value.toLowerCase());
    }
  }

  anchorCache.set(absoluteFile, anchors);
  return anchors;
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

let linksChecked = 0;
let anchorsChecked = 0;
let codePathsChecked = 0;

/** `path/to/file.md#anchor "optional title"` → its parts. */
function splitTarget(raw: string): {
  path: string;
  anchor: string | undefined;
} {
  const withoutTitle = raw.trim().replace(/\s+["'(].*$/, '');
  const hash = withoutTitle.indexOf('#');
  if (hash === -1) return { path: withoutTitle, anchor: undefined };
  return {
    path: withoutTitle.slice(0, hash),
    anchor: withoutTitle.slice(hash + 1) || undefined,
  };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function checkMarkdownLinks(file: string, lines: string[]): void {
  const absoluteDir = dirname(join(ROOT, file));

  /*
   * **Over the whole document, not line by line.** The link text may contain a
   * line break — in these documents it does so three times —, and a line-wise
   * search skips such links **silently**. Exactly the class of gap this guard
   * is built against (review finding of 2026-08-12).
   *
   * Inline code is blanked out per line beforehand (of equal length, so that
   * the offsets are right); the line number then comes out of the offset.
   */
  const prose = lines
    .map((line) =>
      line.replace(/`[^`]*`/g, (match) => ' '.repeat(match.length)),
    )
    .join('\n');

  const lineStarts: number[] = [0];
  for (let index = 0; index < prose.length; index += 1) {
    if (prose[index] === '\n') lineStarts.push(index + 1);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((lineStarts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  for (const link of prose.matchAll(
    /\[[^\]]*\]\(([^)\s]*(?:\s+"[^"]*")?)\)/g,
  )) {
    const raw = (link[1] ?? '').trim();
    if (!raw) continue;
    if (/^(?:https?:|mailto:|tel:|data:|#!)/i.test(raw)) continue;

    const { path, anchor } = splitTarget(raw);
    const lineNumber = lineOf(link.index);

    let targetFile: string | undefined;
    if (path === '') {
      targetFile = join(ROOT, file); // same-document anchor
    } else {
      if (path.startsWith('/')) {
        report(
          file,
          lineNumber,
          `absolute link target "${raw}" (use a relative path)`,
        );
        continue;
      }
      linksChecked += 1;
      const resolved = resolve(absoluteDir, decode(path));
      if (!existsSync(resolved)) {
        report(file, lineNumber, `dead link target: ${raw}`);
        continue;
      }
      targetFile = statSync(resolved).isDirectory() ? undefined : resolved;
    }

    if (anchor === undefined || targetFile === undefined) continue;
    if (!targetFile.endsWith('.md')) continue;

    anchorsChecked += 1;
    const available = anchorsOf(targetFile);
    const wanted = decode(anchor).toLowerCase();
    if (!available.has(wanted)) {
      report(
        file,
        lineNumber,
        `dead anchor: ${raw} (no heading "#${wanted}" there)`,
      );
    }
  }
}

/**
 * A path is a placeholder when it stands for a shape rather than a file —
 * `docs/architecture/NNNN-title.md`, `apps/<workspace>/…`. Checking those would make
 * the guard cry wolf at the very documents that explain the conventions.
 */
function isPlaceholder(path: string): boolean {
  return /NNNN|<[^>]+>|\{|\.\.\.|…/.test(path);
}

function existsInRepo(path: string): boolean {
  if (path.includes('*')) {
    // `globSync` with a pattern that has no match returns an empty list —
    // which is exactly the finding, not an error.
    return globSync(path, { cwd: ROOT }).length > 0;
  }
  return existsSync(join(ROOT, path));
}

function checkCodePaths(file: string, lines: string[]): void {
  lines.forEach((line, index) => {
    for (const span of line.matchAll(/`([^`\n]+)`/g)) {
      const candidate = (span[1] ?? '').trim();
      if (!REPO_PREFIXES.some((prefix) => candidate.startsWith(prefix)))
        continue;
      // Prose inside the span ("`apps/api` und `apps/web`") or a command line
      // ("`docs/x.md` lesen") — a path has no spaces.
      if (/\s/.test(candidate)) continue;
      if (isPlaceholder(candidate)) continue;

      /*
       * `apps/api/src/thing.ts:258` and `…:167,275` are this project's way of
       * citing (AGENTS.md refers to `file:line`). What is checked is the
       * **file**; the line number ages faster than a guard could follow it, and
       * would be the wrong occasion for a red gate.
       */
      const withoutLines = candidate.replace(/:\d+(?:[,-]\d+)*$/, '');
      const path = normalize(withoutLines.replace(/[.,;:)]+$/, ''));
      if (path.startsWith('..')) continue;
      if (RETIRED_PATHS.has(path)) continue;

      codePathsChecked += 1;
      if (!existsInRepo(path)) {
        report(file, index + 1, `path does not exist: ${candidate}`);
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const documents: string[] = [];
for (const dir of DOC_DIRS) {
  const found = listMarkdown(dir);
  if (found.length === 0) {
    // Not "nothing to do": one of the three folders this guard is responsible
    // for has vanished or been renamed, and silence would be the bug.
    report(
      dir,
      0,
      `no Markdown documents found under ${dir}/ — renamed or moved?`,
    );
  }
  documents.push(...found);
}

for (const file of documents) {
  const lines = withoutFencedBlocks(readFileSync(join(ROOT, file), 'utf8'));
  checkMarkdownLinks(file, lines);
  checkCodePaths(file, lines);
}

// The exception list guards itself: a retired path that exists again means the
// entry is stale and would from then on hide a real dead path behind it.
for (const [path, reason] of RETIRED_PATHS) {
  if (existsInRepo(path)) {
    report(
      'tools/check-doc-links.ts',
      0,
      `${path} exists again — drop it from RETIRED_PATHS ("${reason}")`,
    );
  }
}

/*
 * The self-check. Everything above can pass while measuring nothing: a moved
 * folder, a regex that stops matching, a filter that keeps zero spans. These
 * four bounds are the counter-proof — running over an empty set has to be
 * **red**, not quietly green.
 */
const bounds: [string, number, number][] = [
  ['documents', documents.length, MIN_DOCUMENTS],
  ['markdown links', linksChecked, MIN_LINKS],
  ['anchors', anchorsChecked, MIN_ANCHORS],
  ['inline-code paths', codePathsChecked, MIN_CODE_PATHS],
];
for (const [what, actual, minimum] of bounds) {
  if (actual < minimum) {
    report(
      'tools/check-doc-links.ts',
      0,
      `measured only ${String(actual)} ${what} (expected at least ${String(minimum)}) — ` +
        'the guard is running over an (almost) empty set and proves nothing',
    );
  }
}

if (findings.length === 0) {
  process.stdout.write(
    `${String(documents.length)} documents · ${String(linksChecked)} links · ` +
      `${String(anchorsChecked)} anchors · ${String(codePathsChecked)} inline-code paths — ` +
      'all resolve\n',
  );
  process.exit(0);
}

for (const finding of findings) {
  const where =
    finding.line > 0 ? `${finding.file}:${String(finding.line)}` : finding.file;
  process.stdout.write(`${where} — ${finding.message}\n`);
}
process.exit(1);

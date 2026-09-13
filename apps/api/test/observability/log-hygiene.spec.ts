import 'reflect-metadata';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { JsonLogger } from '../../src/observability/json-logger';
import {
  REQUEST_ID_HEADER,
  requestId,
} from '../../src/observability/request-id';

/**
 * **The logging carries no personal data** (ADR-0016).
 *
 * Formerly that was real twice: `MISTRAL_DEBUG` printed the API key in
 * plaintext, `ANTHROPIC_LOG=debug` the free text of the editor. **Both were
 * found by a review, not by a test.** Here they get one.
 *
 * ⚠️ **Two halves, and the second is the weaker one.** The first measures
 * *behaviour* (what the logger outputs, which ID the response carries). The
 * second reads **source text** and looks for call sites that would put a whole
 * payload value into a log line — it is 📋, not 🧪, and it does not replace a
 * review. It prevents the repetition of a known mistake, not its invention in a
 * new form.
 */

const API_SRC = join(__dirname, '..', '..', 'src');

/**
 * **And `packages/shared`** (a review finding).
 *
 * Until then the guard read only `apps/api/src`. The shared package runs in the
 * same process, logs through the same logger and carries the core logic about
 * responses, mail templates and AI payloads — that is, exactly the values at
 * stake here. A log line with a personal reference would have stood there
 * without anything going red.
 */
const SHARED_SRC = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'shared',
  'src',
);

/** The fields a line carries — named so that the test can check them. */
interface LogRow {
  readonly time?: unknown;
  readonly level?: unknown;
  readonly context?: unknown;
  readonly requestId?: unknown;
  readonly message?: unknown;
}

describe('Protokollzeilen', () => {
  describe('Form und Kennung', () => {
    it('schreibt eine JSON-Zeile je Meldung, mit Zeit, Stufe und Kontext', () => {
      const lines = captureStdout(() => {
        new JsonLogger().log('purge finished', 'RetentionPurgeService');
      });

      expect(lines).toHaveLength(1);
      const row = JSON.parse(lines[0] ?? '{}') as LogRow;
      expect(row.message).toBe('purge finished');
      expect(row.level).toBe('log');
      expect(row.context).toBe('RetentionPurgeService');
      expect(typeof row.time).toBe('string');
    });

    it('trägt die Anfrage-ID in jede Zeile, die aus dieser Anfrage entsteht', () => {
      const headers: Record<string, string> = {};
      const response = {
        setHeader: (name: string, value: string) => (headers[name] = value),
      };

      const lines = captureStdout(() => {
        requestId({}, response, () => {
          new JsonLogger().warn('rate limit hit', 'LoginRateLimit');
        });
      });

      const row = JSON.parse(lines[0] ?? '{}') as LogRow;
      // The actual purpose: the operator gets the ID in the response and finds
      // the lines with it — **without** the application logging any
      // content.
      expect(row.requestId).toBe(headers[REQUEST_ID_HEADER]);
      expect(typeof row.requestId).toBe('string');
    });

    it('vergibt je Anfrage eine eigene Kennung', () => {
      const seen: string[] = [];
      const collect = {
        setHeader: (_n: string, value: string) => seen.push(value),
      };
      requestId({}, collect, () => undefined);
      requestId({}, collect, () => undefined);

      expect(seen[0]).not.toBe(seen[1]);
    });

    it('übernimmt **keine** Kennung aus der Anfrage', () => {
      // An `X-Request-Id` from outside would afterwards stand in every line an
      // operator searches through later — a string chosen by a stranger in the
      // operator's log file.
      let written = '';
      requestId(
        { headers: { [REQUEST_ID_HEADER]: 'gewählt-von-aussen' } },
        { setHeader: (_n: string, value: string) => (written = value) },
        () => undefined,
      );

      expect(written).not.toBe('gewählt-von-aussen');
    });
  });

  /**
   * **A stack goes through the same seam as every other line**
   * (a review finding).
   *
   * `ConsoleLogger.error(message, stack)` additionally calls `printStackTrace`,
   * and the default writes **raw to stderr** — past the JSON formatting, without
   * a request ID, multi-line, with everything a third-party library has written
   * into its message.
   */
  describe('Stacks', () => {
    it('schreibt einen Stack als JSON-Zeile nach stdout, nicht roh nach stderr', () => {
      const stderr: string[] = [];
      const originalErr = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk: unknown): boolean => {
        stderr.push(String(chunk));
        return true;
      };

      let lines: string[];
      try {
        lines = captureStdout(() => {
          // All three arguments: Nest reads the **second** one as a stack only
          // when a third one follows as the context — with two of them the stack
          // is the context, and the case measures something else than it
          // claims.
          new JsonLogger().error(
            'purge failed',
            'Error: boom\n    at x.ts:1',
            'RetentionPurgeService',
          );
        });
      } finally {
        process.stderr.write = originalErr;
      }

      // Nothing past the formatting …
      expect(stderr.join('')).toBe('');
      // … and the stack is there, as a line of its own, machine-readable.
      const rows = lines.map((line) => JSON.parse(line) as LogRow);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.message).toBe('purge failed');
      expect(rows[0]?.context).toBe('RetentionPurgeService');
      expect(rows[1]?.context).toBe('stack');
      expect(String(rows[1]?.message)).toContain('at x.ts:1');
      expect(rows[1]?.level).toBe('error');
    });
  });

  describe('Was nie in einer Zeile steht', () => {
    const files = [...sourceFiles(API_SRC), ...sourceFiles(SHARED_SRC)];

    it('findet überhaupt Quelldateien — sonst prüft der Rest nichts', () => {
      expect(files.length).toBeGreaterThan(50);
    });

    /**
     * The ground under this guard: that the set contains *both* banks is the whole
     * fix — without this case a typo in the path would be a silent return to the
     * old state.
     */
    it('liest beide Ufer — apps/api und packages/shared', () => {
      expect(files.some((file) => file.startsWith(API_SRC))).toBe(true);
      expect(files.some((file) => file.startsWith(SHARED_SRC))).toBe(true);
      expect(sourceFiles(SHARED_SRC).length).toBeGreaterThan(20);
    });

    /**
     * Call sites that put a **whole** foreign value into a log line.
     *
     * What is looked for are the names under which user data travels in this
     * application — not the word „log": every log line contains that.
     *
     * ⚠️ **What is measured is code, not prose.** The first draft of this file
     * searched over the raw text and reported three hits — all of them in
     * **comments**: the warning about `ANTHROPIC_LOG=debug` stands in
     * `anthropic-form-generator.ts` and in the header of the `JsonLogger`
     * itself. A guard that takes the explanation of a mistake for the mistake
     * forces an exception list and is thereby finished. {@link stripComments}
     * therefore removes them beforehand.
     *
     * ⚠️ **And what is looked for is the *interpolation*, not the word.** The
     * second draft, too, still reported three hits, all three in the message
     * *text*: „ID token", „behind a draft token", „ai prompt purge: N prompt(s)
     * erased". A sentence that contains the word *token* betrays no token —
     * what betrays is `${…}` around such a value. Precisely that stands in the
     * patterns below, and that is why the three lines stay permissible, while
     * `${prompt}` would not be.
     */
    const FORBIDDEN: readonly { readonly what: string; readonly re: RegExp }[] =
      [
        {
          what: 'die Antwortwerte einer Einreichung',
          re: /logger\.\w+\([^)]*\$\{[^}]*\b(?:answers|payload|body|values)\b/,
        },
        {
          what: 'eine Empfängeradresse',
          re: /logger\.\w+\([^)]*\$\{[^}]*\b(?:recipient|toAddress|email)\b/i,
        },
        {
          what: 'ein Zugangswort oder ein Schlüssel',
          re: /logger\.\w+\([^)]*\$\{[^}]*\b(?:password|secret|apiKey|token)\b/i,
        },
        {
          what: 'der Freitext einer KI-Anfrage',
          re: /logger\.\w+\([^)]*\$\{[^}]*\bprompt\b/i,
        },
        {
          /**
           * **The message of an error instead of its class** (a review
           * finding).
           *
           * With Prisma `error.message` is the description of the constraint —
           * **including the values of the request**. In three of the four purge
           * runs exactly that stood there, and a purge run has in its hands the
           * rows it is meant to delete. What stays permitted is
           * `error.constructor.name`: the class says *what* went wrong without
           * saying *with what*.
           */
          what: 'die Meldung eines gefangenen Fehlers',
          re: /logger\.\w+\([^)]*\$\{[^}]*\berror\.message\b/,
        },
      ];

    /**
     * **The one justified exception** (a review finding).
     *
     * `MailConfigUnreadableError.message` is one of **two fixed German
     * sentences** — it is the same sentence the dispatch log displays, and
     * `MailSecretsService` guarantees that it carries no value. The rule „class
     * instead of message" protects against messages of *foreign* origin; here
     * the message is our own promise.
     *
     * The exception applies to the **file**, not to the pattern — a second
     * `error.message` line in the same file would therefore stay unchecked. That
     * is deliberately the smaller price: the alternative would be a pattern over
     * the class name, and that would be green for every class somebody later
     * calls that.
     */
    const JUSTIFIED: Readonly<Record<string, string>> = {
      'mail/mail-worker.service.ts':
        'MailConfigUnreadableError trägt einen von zwei festen Sätzen — ' +
        'denselben, den das Versandprotokoll zeigt.',
    };

    for (const { what, re } of FORBIDDEN) {
      it(`protokolliert nirgends ${what}`, () => {
        const hits = files
          .filter((file) => re.test(stripComments(readFileSync(file, 'utf8'))))
          .map((file) =>
            file.startsWith(SHARED_SRC)
              ? `packages/shared/${relative(SHARED_SRC, file)}`
              : relative(API_SRC, file),
          )
          .filter((file) => JUSTIFIED[file] === undefined);
        expect(hits).toStrictEqual([]);
      });
    }

    it('führt keine Ausnahme, die es nicht mehr braucht', () => {
      // An exception list that points at a place which no longer exists covers
      // at some point something other than what it says.
      for (const file of Object.keys(JUSTIFIED)) {
        const source = stripComments(readFileSync(join(API_SRC, file), 'utf8'));
        expect(
          FORBIDDEN.some(({ re }) => re.test(source)),
          `${file} braucht die Ausnahme nicht mehr`,
        ).toBe(true);
      }
    });

    it('schaltet keine Fremdbibliothek in einen Debug-Modus', () => {
      // The case that was real twice: `MISTRAL_DEBUG` printed the API key in
      // plaintext, `ANTHROPIC_LOG=debug` the free text.
      const hits = files
        .filter((file) =>
          /\b(?:MISTRAL_DEBUG|ANTHROPIC_LOG|DEBUG)\s*[:=]/.test(
            stripComments(readFileSync(file, 'utf8')),
          ),
        )
        .map((file) => relative(API_SRC, file));
      expect(hits).toStrictEqual([]);
    });
  });
});

/** Catches what is written to `stdout` and returns the lines. */
function captureStdout(work: () => void): string[] {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    written.push(String(chunk));
    return true;
  };
  try {
    work();
  } finally {
    process.stdout.write = original;
  }
  return written.join('').trimEnd().split('\n').filter(Boolean);
}

/**
 * Source text without comments.
 *
 * Deliberately coarse (no parser): a `//` or `/*` inside a string literal would
 * remove too much here. That is the right direction for a guard — it then
 * reports **less**, never more, and an overlooked find would show up in a
 * review, whereas a false alarm would fill the file with exceptions within a
 * week.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) found.push(full);
  }
  return found;
}

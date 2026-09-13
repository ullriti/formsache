import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  aiAvailable,
  buildAiFormRequest,
  describeAiConfigGap,
  resolveAiConfig,
  type ResolvedAiConfig,
} from '@formsache/shared';

import { AnthropicFormGenerator } from '../../src/ai/anthropic-form-generator';
import { MistralFormGenerator } from '../../src/ai/mistral-form-generator';
import { CONTRACT_ROWS, recordedTransport } from './recorded-answers';

/**
 * **The key stays in the backend** (ADR-0015 no. 5 and no. 10).
 *
 * Three separate promises, and they fail in three different ways:
 *
 * 1. **The `AI_` prefix does its job.** A machine with `ANTHROPIC_API_KEY` or
 *    `MISTRAL_API_KEY` set for something else must **not** have a configured
 *    AI — otherwise „ohne Schlüssel 404" is not testable there, which is the
 *    reason ADR-0015 no. 5 rejected the vendor-usual names.
 * 2. **The client is built with an explicit `apiKey`.** Both SDKs read their
 *    own variable out of the process environment when constructed without one
 *    (for Mistral this is not a documentation claim but a line of its
 *    `lib/security.ts`), so the measurement is at the outgoing header: our key
 *    goes out, the ambient one does not.
 * 3. **The key never travels back out.** Neither in an outcome (which is what
 *    a route will serialise), nor into a log, nor into the browser.
 */

const CANARY_AMBIENT_KEY = 'ZZKANARIE-AMBIENT-KEY';
const OUR_KEY = 'ZZKANARIE-CONFIGURED-KEY';

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

const REQUEST = buildAiFormRequest({
  prompt: 'Ein Formular für die Bestandsmeldung.',
  language: 'de',
});

const CONFIG: ResolvedAiConfig = {
  provider: 'anthropic',
  apiKey: OUR_KEY,
  region: 'eu',
  model: 'claude-opus-5',
  timeoutMs: 60_000,
};

/** The success row — the only one that gets far enough to send a header. */
function successRow() {
  const row = CONTRACT_ROWS[0];
  if (row === undefined) {
    throw new Error('contract table is empty');
  }
  return row;
}

describe('1 — a vendor-named key in the environment configures nothing', () => {
  // `ANTHROPIC_AUTH_TOKEN` joined this list from a review finding (// 2026-08-10): the adapter's own comment names three ambient surfaces the
  // SDK reads, and the list measured one of them. See „anthropic sends no
  // Authorization header at all" below for what the gap actually cost.
  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MISTRAL_API_KEY'])(
    '%s set, settings empty: the feature stays absent',
    (variable) => {
      process.env[variable] = CANARY_AMBIENT_KEY;

      // The resolution reads the settings row, not the
      // environment — the empty row is the empty object here. The canary in
      // the process environment is thereby **structurally** more ineffective
      // than before: there is no variable left through which it could get in.
      expect(resolveAiConfig({})).toBeNull();
      expect(aiAvailable({})).toBe(false);
    },
  );

  /**
   * **A provider alone does not fetch the key out of the environment** — and
   * that no longer takes the installation down either.
   *
   * There used to be a start-up abort here: `AI_PROVIDER` without
   * `AI_*_API_KEY` was a loud refusal. As a form field the same abort would be
   * the most expensive conceivable reaction — hence: the row is saved, the
   * feature stays **absent**, and the canary is not collected.
   */
  it('a provider alone does not resurrect it from the ambient key', () => {
    process.env.ANTHROPIC_API_KEY = CANARY_AMBIENT_KEY;
    expect(resolveAiConfig({ provider: 'anthropic' })).toBeNull();
    expect(aiAvailable({ provider: 'anthropic' })).toBe(false);
    expect(describeAiConfigGap({ provider: 'anthropic' })).toBe('apiKey');
  });
});

describe('2 — the outgoing request carries our key, never the ambient one', () => {
  it('anthropic sends x-api-key from the configuration', async () => {
    process.env.ANTHROPIC_API_KEY = CANARY_AMBIENT_KEY;
    const recorded = recordedTransport(successRow().anthropic);
    const headers: string[] = [];
    const generator = new AnthropicFormGenerator(CONFIG, async (request) => {
      headers.push(request.headers.get('x-api-key') ?? '');
      return recorded.transport(request);
    });

    await generator.generate(REQUEST, new AbortController().signal);

    expect(headers).toEqual([OUR_KEY]);
    expect(headers).not.toContain(CANARY_AMBIENT_KEY);
  });

  /**
   * **No `Authorization` header at all — not „the right one".**
   *
   * A review finding (security review, 2026-08-10). The adapter sets
   * `authToken: null`, and the comment there names the reason; it was not
   * measured. The counter-check: `authToken: null` removed,
   * `ANTHROPIC_AUTH_TOKEN` set in the process environment — and the transport
   * carried **both** out, `x-api-key` with our key *and*
   * `authorization: Bearer <foreign token>`. All five files of the AI suite
   * stayed green.
   *
   * The damage is limited (the token goes to the pinned host, not to third
   * parties) and the shape is exactly the one the `AI_` prefix of
   * ADR-0015 no. 5 argues against: a machine on which an Anthropic token is
   * set for something else — a developer's machine, a shared CI runner — sent
   * it along unasked on **every** form generation.
   *
   * What is measured is therefore the **absence** of the header, not its
   * content: `expect(header).toBe(OUR_KEY)` would stay green as long as
   * something else merely travels *along* too.
   */
  it('anthropic sends no Authorization header at all', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = CANARY_AMBIENT_KEY;
    const recorded = recordedTransport(successRow().anthropic);
    const sent: (string | null)[] = [];
    const generator = new AnthropicFormGenerator(CONFIG, async (request) => {
      sent.push(request.headers.get('authorization'));
      return recorded.transport(request);
    });

    await generator.generate(REQUEST, new AbortController().signal);

    expect(sent).toEqual([null]);
  });

  it('mistral sends Authorization from the configuration', async () => {
    process.env.MISTRAL_API_KEY = CANARY_AMBIENT_KEY;
    const recorded = recordedTransport(successRow().mistral);
    const headers: string[] = [];
    const generator = new MistralFormGenerator(
      { ...CONFIG, provider: 'mistral', model: 'mistral-recorded-0000' },
      async (request) => {
        headers.push(request.headers.get('authorization') ?? '');
        return recorded.transport(request);
      },
    );

    await generator.generate(REQUEST, new AbortController().signal);

    expect(headers).toEqual([`Bearer ${OUR_KEY}`]);
    expect(headers.join('')).not.toContain(CANARY_AMBIENT_KEY);
  });

  it('anthropic talks to the pinned host, whatever ANTHROPIC_BASE_URL says', async () => {
    // The same argument as the `AI_` prefix, one door further: the SDK reads
    // this variable, so an unpinned base address would let a variable outside
    // our env contract decide where the key travels.
    process.env.ANTHROPIC_BASE_URL = 'https://exfiltration.invalid';
    const recorded = recordedTransport(successRow().anthropic);
    const hosts: string[] = [];
    const sent: Headers[] = [];
    const generator = new AnthropicFormGenerator(CONFIG, async (request) => {
      hosts.push(new URL(request.url).host);
      sent.push(request.headers);
      return recorded.transport(request);
    });

    await generator.generate(REQUEST, new AbortController().signal);

    expect(hosts).toEqual(['api.anthropic.com']);

    // …and the machine this runs on is not part of what travels (ADR-0015
    // no. 13 Punkt 2). The SDK adds these three by default — host OS,
    // architecture and the exact Node version — and the adapter removes them.
    const [headers] = sent;
    expect(headers).toBeDefined();
    for (const telemetry of [
      'x-stainless-os',
      'x-stainless-arch',
      'x-stainless-runtime-version',
    ]) {
      expect(headers?.has(telemetry)).toBe(false);
    }
  });

  /**
   * **The same assurance for Mistral, and it was missing** — „das Env-Schema
   * kennt keine Basis-URL" is true and does not measure anything: a
   * `serverURL: 'https://exfiltration.invalid'` in the adapter kept the whole
   * suite green while key and free text went to a foreign host.
   *
   * The host is asserted as **`api.eu.mistral.ai`**, not merely as „a Mistral
   * host": the SDK offers `global`, `eu` and `us`, ADR-0015 no. 13 requires
   * EU hosting, and this line is what keeps that choice from being changed
   * back in passing.
   */
  it('mistral talks to the EU endpoint', async () => {
    const recorded = recordedTransport(successRow().mistral);
    const hosts: string[] = [];
    const generator = new MistralFormGenerator(
      { ...CONFIG, provider: 'mistral', model: 'mistral-recorded-0000' },
      async (request) => {
        hosts.push(new URL(request.url).host);
        return recorded.transport(request);
      },
    );

    await generator.generate(REQUEST, new AbortController().signal);

    expect(hosts).toEqual(['api.eu.mistral.ai']);
  });
});

describe('3 — the key never travels back out', () => {
  it.each(CONTRACT_ROWS.map((row, index) => ({ name: row.name, index })))(
    'no outcome carries it: $name',
    async ({ index }) => {
      const row = CONTRACT_ROWS[index];
      if (row === undefined) {
        throw new Error('missing row');
      }
      const recorded = recordedTransport(row.anthropic);
      const generator = new AnthropicFormGenerator(CONFIG, recorded.transport);
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 120);
      let outcome;
      try {
        outcome = await generator.generate(REQUEST, controller.signal);
      } finally {
        clearTimeout(timer);
      }

      // The outcome is what a route serialises, so „keine
      // Antwort der API trägt einen Schlüssel" is measured here, on the value
      // that becomes the body — not on a route that does not exist yet.
      expect(JSON.stringify(outcome)).not.toContain(OUR_KEY);
    },
  );

  /**
   * **Nor does the adapter instance itself carry it.**
   *
   * An adapter that kept its whole `ResolvedAiConfig` had the plaintext as an
   * own property, one `util.inspect` away — and `util.inspect` is what every
   * error reporter and every `console.error('…', generator)` reaches for.
   *
   * ⚠️ **What this does *not* claim:** both SDKs keep a copy of the key on
   * their own client object, and `inspect(generator, { depth: 2 })` still finds
   * it there. That copy is the SDK's; this line is about not adding a second
   * one of our own.
   */
  it.each([
    {
      name: 'anthropic',
      build: (): object =>
        new AnthropicFormGenerator(
          CONFIG,
          recordedTransport(successRow().anthropic).transport,
        ),
    },
    {
      name: 'mistral',
      build: (): object =>
        new MistralFormGenerator(
          { ...CONFIG, provider: 'mistral', model: 'mistral-recorded-0000' },
          recordedTransport(successRow().mistral).transport,
        ),
    },
  ])('no own property of the $name adapter is the key', ({ build }) => {
    const own = Object.entries(build()).filter(
      ([, value]) => value === OUR_KEY,
    );
    expect(own).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Structural: where the key may be named at all.
// ---------------------------------------------------------------------------

const ROOT = resolve(process.cwd(), '..', '..');
const SKIPPED = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '.playwright',
  'test-results',
  'playwright-report',
  'blob-report',
]);

function sources(directory: string, into: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED.has(entry.name)) {
        sources(join(directory, entry.name), into);
      }
      continue;
    }
    if (/\.(ts|tsx|js|mjs|cjs|html)$/.test(entry.name)) {
      into.push(join(directory, entry.name));
    }
  }
  return into;
}

const repoRelative = (file: string): string =>
  relative(ROOT, file).split(sep).join('/');

describe('structural — the key has three files and no more', () => {
  it('reads the whole repository rather than an empty set', () => {
    expect(sources(ROOT).length).toBeGreaterThan(100);
  });

  /**
   * **The frontend cannot carry a key value it never reads.**
   *
   * The mechanism, stated rather than assumed: the browser build inlines
   * `import.meta.env.VITE_*` and nothing else, and none of the seven AI
   * variables carries that prefix. So no key *value* can reach a bundle
   * unless `apps/web` reads one by name — which this test forbids.
   *
   * ⚠️ **The variable *names* do reach the bundle**, and that is worth knowing
   * rather than glossing over: `packages/shared/src/index.ts` re-exports
   * `apiEnvSchema`, the web app imports the same barrel, and the schema's keys
   * survive into the built asset. Measured on the real bundle of
   * `pnpm -r build`: `AI_ANTHROPIC_API_KEY` and `AI_MISTRAL_API_KEY` appear as
   * strings, and so do `SECRET_BOX_KEY` and `DATABASE_URL` — the latter two
   * since long before this package, so the shape is inherited, not introduced.
   * Names are not secrets (`.env.example` lists every one of them); a **value**
   * would be, and none is there.
   */
  it('apps/web names no AI key variable at all', () => {
    const offenders = sources(join(ROOT, 'apps', 'web'))
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return (
          text.includes('AI_ANTHROPIC_API_KEY') ||
          text.includes('AI_MISTRAL_API_KEY') ||
          text.includes('ANTHROPIC_API_KEY') ||
          text.includes('MISTRAL_API_KEY')
        );
      })
      .map(repoRelative)
      .sort();
    expect(offenders).toEqual([]);
  });

  /**
   * `apiKey` is read at exactly **four** places, and every additional one is
   * one more place at which a plaintext can be passed on — exactly that, where
   * a secret used to be handed on twice.
   *
   * ⚠️ **Two came along with the move into the system settings, and that is the price paid
   * for the move**, not a softened guard:
   *
   * | file | why it **has to** see the key |
   * |---|---|
   * | `packages/shared/src/ai-config.ts` | the one resolution — it decides „Schlüssel da oder nicht" and puts it into `ResolvedAiConfig` |
   * | `apps/api/src/system-settings/ai-settings.service.ts` | unseals the column; **the only place** at which the envelope turns into a plaintext |
   * | the two adapters | build the client with an explicit `apiKey` (ADR-0015 no. 5) |
   *
   * What the service does **not** do is hand it out: `available()` returns a
   * `boolean`, `readForAdmin()` an `apiKeySet`. From there the plaintext goes
   * only into the factory and from there into the adapter.
   *
   * Lengthening this list is a **deliberate act** and belongs in the same
   * change as the place that then reads the key.
   */
  it('only the resolution, the unsealing and the two adapters read the key', () => {
    const offenders = sources(ROOT)
      .filter((file) => /\.apiKey\b/.test(readFileSync(file, 'utf8')))
      .map(repoRelative)
      // **Tests do not count** — by file extension, not by path.
      // The first version excluded `apps/api/test/`; with that it overlooked
      // `apps/web/**/*.test.tsx`, which checks the display of the AI page
      // and names `apiKey` while doing so. A test is not a place at which a
      // plaintext is *passed on* — what this is about are the production
      // files.
      .filter(
        (file) =>
          !/(?:^|\/)test\//.test(file) && !/\.(test|spec)\.tsx?$/.test(file),
      )
      .sort();
    expect(offenders).toEqual([
      'apps/api/src/ai/anthropic-form-generator.ts',
      'apps/api/src/ai/mistral-form-generator.ts',
      'apps/api/src/system-settings/ai-settings.service.ts',
      'packages/shared/src/ai-config.ts',
    ]);
  });

  /**
   * **No file *we* wrote under `src/ai` logs.** Not „nichts loggt den
   * Schlüssel" — the absence of any logging in our own files, because that is
   * the property a reader can check at a glance and the one a future line of
   * ours cannot quietly violate (ADR-0015 no. 10: „nie protokolliert").
   *
   * ⚠️ **This says nothing about the path, only about these files.** It reads
   * source text, so a logger that lives in `node_modules` is invisible to it —
   * and both SDKs bring one that the *process environment* can switch on
   * (`MISTRAL_DEBUG`, `ANTHROPIC_LOG`), printing headers and body. That half of
   * the promise is measured behaviourally in `debug-logging.spec.ts`; reading
   * this test as „unter diesem Pfad wird nicht geloggt" is precisely the
   * mistake that let `MISTRAL_DEBUG` print the key in plaintext through a green
   * suite.
   *
   * The pattern looks for a logger that is **used** — a member access or a
   * call — rather than for the bare word, because a comment has to be able to
   * name the SDK logger it closes without tripping the guard that closes it. It
   * still matches prose that reads `logger.` or `console.`, and that direction
   * is the safe one: a false positive is a red test somebody reads, a false
   * negative is a key in a log file.
   */
  it('nothing we wrote in src/ai/*.ts logs anything', () => {
    const offenders = seamFiles()
      .filter((file) => LOGGER_IN_USE.test(readFileSync(file, 'utf8')))
      .map(repoRelative)
      .sort();
    expect(offenders).toEqual([]);
  });

  /**
   * **The counter-check to the narrowing** .
   *
   * A guard that stopped covering the files it exists for would go green by
   * looking at nothing, and narrowing a rule is exactly the move that produces
   * that shape. Two halves, and both are needed:
   *
   * 1. **the set still contains the files where the key is** — both adapters,
   *    the seam, the module that binds it and the prompt. Written as an
   *    equality against „every top-level file of `src/ai`", so a new file there
   *    is covered by existing and not by being remembered;
   * 2. **the pattern still catches a logging line** — asserted against a
   *    literal, because a regex that matched nothing would satisfy point 1 and
   *    still prove nothing.
   */
  it('still watches the adapters, and still recognises a log line', () => {
    const watched = seamFiles().map(repoRelative).sort();

    expect(watched).toContain('apps/api/src/ai/anthropic-form-generator.ts');
    expect(watched).toContain('apps/api/src/ai/mistral-form-generator.ts');
    expect(watched).toContain('apps/api/src/ai/ai-form-generator.ts');
    expect(watched).toContain('apps/api/src/ai/ai.module.ts');

    // The narrowing itself: `ai/purge/**` and `ai/usage/**` are out of the set.
    // In its wide form this rule kept the Prompt-Purge from
    // reporting its own failure, and a purge that cannot say „ich scheitere
    // seit vier Wochen" makes a deletion promise unobservable. Subdirectories
    // may log what is neither a secret nor a prompt.
    expect(watched).not.toContain(
      'apps/api/src/ai/purge/ai-prompt-purge.service.ts',
    );
    expect(watched).not.toContain('apps/api/src/ai/usage/ai-usage.service.ts');

    expect(LOGGER_IN_USE.test('this.logger.warn("hello");')).toBe(true);
    expect(LOGGER_IN_USE.test('console.log(config.apiKey);')).toBe(true);
    expect(LOGGER_IN_USE.test('new Logger(AiModule.name);')).toBe(true);
    expect(LOGGER_IN_USE.test('const loggerless = 1;')).toBe(false);
  });
});

/**
 * The files the logging ban covers: **`src/ai/*.ts`, the seam and the
 * adapters** — not the directory tree below it (2026-08-07).
 *
 * The wide form („unter `apps/api/src/ai` protokolliert nichts") protected at
 * the wrong place: the key lives in the adapters, and the two subdirectories
 * hold a purge and a counter that have every reason to report a count or a
 * failure kind. It is narrowed here rather than deleted, because the property
 * it does protect is real and cheap to keep.
 */
function seamFiles(): string[] {
  const directory = join(ROOT, 'apps', 'api', 'src', 'ai');
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(directory, entry.name));
}

/**
 * A logger that is **used** — a member access or a call — rather than the bare
 * word, so a comment can name the SDK logger it closes without tripping the
 * guard that closes it.
 */
const LOGGER_IN_USE = /\b(console|Logger|logger)\s*[.(]/;

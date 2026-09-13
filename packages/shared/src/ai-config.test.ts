import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  aiAvailable,
  aiAvailableForTenant,
  describeAiConfigGap,
  movedAiEnvVarsStillSet,
  movedAiEnvWarning,
  resolveAiConfig,
  type AiSettingsFields,
} from './ai-config.ts';
import { AI_MODEL_CHOICES, DEFAULT_AI_MODEL } from './ai-models.ts';
import { aiProviderSchema } from './ai.ts';

/**
 * **The resolution table of the AI configuration** (ADR-0015 no. 5 and no. 9
 * with the addendum of 2026-08-11).
 *
 * One place decides which provider runs and whether the feature
 * exists at all. The table below is the whole surface of this
 * decision; the guard at the end keeps it at *one* place.
 *
 * ⚠️ **The input has changed, the decision has not.** Where environment
 * variables stood here, there now stand columns of the
 * settings row — and the functions have stayed pure, which is the actual
 * gain: the move cost a new *caller*, no new resolution.
 */

const KEYED: AiSettingsFields = {
  provider: 'anthropic',
  apiKey: 'sk-test',
};

describe('resolveAiConfig', () => {
  it.each([
    { name: 'nichts gesetzt', settings: {} },
    {
      name: 'ein Schlüssel ohne Anbieter — der Schlüssel allein konfiguriert nichts',
      settings: { apiKey: 'sk-test' },
    },
    {
      name: 'der installationsweite Schalter',
      settings: { ...KEYED, enabled: false },
    },
    {
      name: 'ein Anbieter ohne Schlüssel (die Anzeige nennt die Lücke)',
      settings: { provider: 'anthropic' as const },
    },
    {
      name: 'ein leerer Schlüssel',
      settings: { provider: 'anthropic' as const, apiKey: '' },
    },
    {
      name: 'ein NULL-Schlüssel, wie die Spalte ihn ohne Eintrag liefert',
      settings: { provider: 'anthropic' as const, apiKey: null },
    },
    {
      name: 'ein unentsiegelbarer Schlüssel, den der Dienst als null hereinreicht',
      settings: { provider: 'anthropic' as const, apiKey: null, model: 'm' },
    },
  ])('ist null: $name', ({ settings }) => {
    expect(resolveAiConfig(settings)).toBeNull();
    expect(aiAvailable(settings)).toBe(false);
  });

  it('löst anthropic bis auf das gepinnte Vorgabemodell auf', () => {
    expect(resolveAiConfig(KEYED)).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-test',
      model: DEFAULT_AI_MODEL.anthropic,
      region: 'eu',
      timeoutMs: 60_000,
    });
    expect(aiAvailable(KEYED)).toBe(true);
  });

  it('lässt das gesetzte Modell den Vorgabewert überschreiben', () => {
    expect(
      resolveAiConfig({ ...KEYED, model: 'claude-something-else' })?.model,
    ).toBe('claude-something-else');
  });

  it('löst mistral nur mit ausdrücklichem Modell auf', () => {
    expect(
      resolveAiConfig({
        provider: 'mistral',
        apiKey: 'sk-test',
        model: 'mistral-pinned-0000',
        region: 'global',
      }),
    ).toEqual({
      provider: 'mistral',
      apiKey: 'sk-test',
      model: 'mistral-pinned-0000',
      region: 'global',
      timeoutMs: 60_000,
    });
  });

  /**
   * **`eu`, and not "the first region found"** .
   *
   * The default value of a missing row is the cautious answer, not
   * the first one in the list: a fresh installation would otherwise process
   * outside the EU, without anyone having set anything.
   */
  it.each([undefined, null])('nimmt eu, wenn die Region %p ist', (region) => {
    expect(resolveAiConfig({ ...KEYED, region })?.region).toBe('eu');
  });

  it('reicht unsere Frist durch, statt sie zu erfinden', () => {
    expect(resolveAiConfig(KEYED, 5_000)?.timeoutMs).toBe(5_000);
  });

  /**
   * **The default identifiers, written out** (ADR-0015 no. 5).
   *
   * The point of this assertion is that a *guessed* value stands out: whoever
   * changes an identifier has to change this line along with it and thereby say
   * where they have it from. Until 2026-08-12 `DEFAULT_AI_MODEL.mistral` stood
   * here as an express gap — the provider documentation answered from this
   * environment with HTTP 403, and an extrapolated `mistral-medium-2604` would
   * have been a promise about someone else's service that no test here
   * can keep.
   *
   * *(Remarkable in hindsight: `mistral-medium-2604` **does exist**, as the
   * measurement against `GET /v1/models` on the same day showed. The restraint
   * was right nonetheless — at the time of the decision it was a conjecture,
   * and a conjecture that happens to be right remains one.)*
   */
  it('nennt je Anbieter die entschiedene Vorgabekennung', () => {
    expect(DEFAULT_AI_MODEL.anthropic).toBe('claude-opus-5');
    expect(DEFAULT_AI_MODEL.mistral).toBe('mistral-large-latest');
  });
});

/**
 * **The curated selection list** (ADR-0015 no. 5, addendum of 2026-08-12).
 *
 * The model field was a free text; a typo therefore did not stand out on
 * saving, but as a 404 of the provider at the first form draft.
 * The list moves the error back to the place where it arises — and the
 * cases here record what it has to keep to for that.
 */
describe('AI_MODEL_CHOICES', () => {
  const providers = aiProviderSchema.options;

  /**
   * **All six identifiers, written out — and that is the whole point
   * of this case** (review follow-up, 2026-08-12).
   *
   * The first version checked properties *of the list* (`not.toContain(
   * 'latest')`, length > 0, no duplicates) and derived everything else from
   * `AI_MODEL_CHOICES` itself. Measured: two identifiers deliberately
   * garbled, **35 of 35 cases stayed green**. Four of the six identifiers were
   * unchecked, and the promise of the rebuild ("a typo is no longer
   * possible") was thereby wrong: the typo had migrated from the operator into
   * the list, where it would hit *all* installations instead of one.
   *
   * That is why the list stands here as a literal. Whoever changes an
   * identifier changes this line along with it — and says in the same commit
   * where they have it from.
   *
   * ⚠️ **All six are deliberately moving aliases** (settled on
   * 2026-08-12; reasoning and measured price stand in
   * `ai-models.ts`). An earlier guard "contains no `latest`" would therefore
   * today be not merely ineffective, but the wrong way round — it exists no
   * more. For Mistral the three are documented on 2026-08-12 against
   * `GET /v1/models`, for Anthropic against the model catalogue.
   *
   * *Counter-check:* change one character in one of the six identifiers → red.
   */
  it('bietet genau die belegten Kennungen an', () => {
    expect(
      Object.fromEntries(
        providers.map((provider) => [
          provider,
          AI_MODEL_CHOICES[provider].map((choice) => choice.id),
        ]),
      ),
    ).toStrictEqual({
      anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
      mistral: [
        'mistral-large-latest',
        'mistral-medium-latest',
        'mistral-small-latest',
      ],
    });
  });

  it('deckt jeden Anbieter ab, den das Schema kennt', () => {
    // Otherwise the selection would stand there empty for a new provider, and
    // the page would offer a field from which nothing can be chosen.
    expect(Object.keys(AI_MODEL_CHOICES).sort()).toStrictEqual(
      [...providers].sort(),
    );
  });

  /**
   * **The default value must stand in the list.**
   *
   * Without this binding the page would show under „Vorgabe" an identifier
   * that its own selection field cannot produce: whoever once chose something
   * else would get back to the default only via the empty option and would
   * never see *which* model they take with it.
   *
   * *Counter-check:* take `claude-opus-5` out of `AI_MODEL_CHOICES.anthropic` →
   * this case turns red.
   */
  it('führt den Vorgabewert jedes Anbieters als wählbaren Eintrag', () => {
    for (const provider of providers) {
      expect(AI_MODEL_CHOICES[provider].map((choice) => choice.id)).toContain(
        DEFAULT_AI_MODEL[provider],
      );
    }
  });

  /** Two entries with the same label would be indistinguishable in the `select`. */
  it('vergibt jede Beschriftung nur einmal', () => {
    for (const provider of providers) {
      const labels = AI_MODEL_CHOICES[provider].map((choice) => choice.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

/**
 * **The three layers are monotone** .
 *
 * The organisation switch can take away and give nothing. Both directions stand
 * here, because a test that checks only the allowed case proves nothing: that
 * `false` switches off would be true for an OR as well.
 */
describe('aiAvailableForTenant', () => {
  it.each([
    {
      name: 'System an, Organisation erbt',
      settings: KEYED,
      tenant: null,
      expected: true,
    },
    {
      name: 'System an, Organisation an',
      settings: KEYED,
      tenant: true,
      expected: true,
    },
    {
      name: 'System an, Organisation aus',
      settings: KEYED,
      tenant: false,
      expected: false,
    },
    {
      name: 'System aus, Organisation an — er kann sich nichts geben',
      settings: {},
      tenant: true,
      expected: false,
    },
    {
      name: 'System abgeschaltet, Organisation an — dasselbe',
      settings: { ...KEYED, enabled: false },
      tenant: true,
      expected: false,
    },
  ])('$name', ({ settings, tenant, expected }) => {
    expect(aiAvailableForTenant(settings, tenant)).toBe(expected);
  });
});

/**
 * **The half configuration shows itself instead of refusing the start**.
 *
 * Formerly it took the installation down. As a form field that would be the
 * most expensive conceivable reaction — hence a field name for the display.
 */
describe('describeAiConfigGap', () => {
  it('schweigt, solange kein Anbieter genannt ist', () => {
    expect(describeAiConfigGap({})).toBeNull();
    expect(describeAiConfigGap({ apiKey: 'sk' })).toBeNull();
  });

  it.each([
    { settings: { provider: 'anthropic' as const }, gap: 'apiKey' },
    { settings: { provider: 'mistral' as const }, gap: 'apiKey' },
  ])('nennt $gap', ({ settings, gap }) => {
    expect(describeAiConfigGap(settings)).toBe(gap);
  });

  /**
   * **A stored model is no gap, even when the list does not carry
   * it** (review follow-up, 2026-08-12).
   *
   * `'model'` no longer exists as an answer — since every provider has a
   * default value, the half configuration is always the one *without a key*.
   * The case here holds the boundary in the other direction: an old identifier
   * from the free-text era is a **complete** configuration, the feature
   * runs, and `gap` must not claim that something is missing here.
   */
  it('nennt keine Lücke bei einer Kennung außerhalb der Auswahlliste', () => {
    const settings = {
      provider: 'anthropic' as const,
      apiKey: 'sk',
      model: 'claude-opus-4-1-20250805',
    };
    expect(describeAiConfigGap(settings)).toBeNull();
    expect(resolveAiConfig(settings)?.model).toBe('claude-opus-4-1-20250805');
  });

  /**
   * The switched-off toggle does not make a half configuration right —
   * and whoever turns it back on shall not discover the gap in that moment.
   */
  it('meldet die Lücke auch bei abgeschalteter Funktion', () => {
    expect(describeAiConfigGap({ provider: 'anthropic', enabled: false })).toBe(
      'apiKey',
    );
  });
});

/**
 * **What has stayed behind in the environment gets named**  — without this message an installation would run with two sources
 * for the same value, of which one wins invisibly.
 */
describe('movedAiEnvVarsStillSet', () => {
  it('nennt genau die gesetzten der fünf', () => {
    expect(
      movedAiEnvVarsStillSet({
        AI_PROVIDER: 'anthropic',
        AI_MODEL: 'x',
        AI_REQUEST_TIMEOUT_MS: '60000',
      }),
    ).toEqual(['AI_PROVIDER', 'AI_MODEL']);
  });

  /**
   * An empty assignment does not count: older `.env` files carry
   * `AI_PROVIDER=` without a value, and a message about it would train people
   * to overlook messages.
   */
  it('zählt eine leere Zuweisung nicht', () => {
    expect(
      movedAiEnvVarsStillSet({ AI_PROVIDER: '', AI_MODEL: undefined }),
    ).toEqual([]);
  });

  it('sagt in der Meldung, wo der Wert jetzt steht', () => {
    const warning = movedAiEnvWarning(['AI_PROVIDER']);
    expect(warning).toContain('AI_PROVIDER');
    expect(warning).toContain('Systemeinstellungen');
  });
});

// ---------------------------------------------------------------------------
// The guard: one question, a closed set of askers.
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
    if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !/\.test\.ts$|\.spec\.ts$/.test(entry.name)
    ) {
      into.push(join(directory, entry.name));
    }
  }
  return into;
}

/**
 * **The closed set of consumers** (ADR-0015 no. 9).
 *
 * Formerly `aiAvailable` had **two** callers: the module binding from which the
 * route inherited its 404, and the feature switch of the session payload that
 * the menu reads. Both read the same pure function over the environment, and so
 * could not drift apart.
 *
 * **By now it is exactly one**, and that is the tighter promise: the
 * configuration stands in one row, and a second reader of this row would be
 * a second opinion about the configuration. Guard, menu switch and
 * adapter factory all ask `AiSettingsService`; a further caller here
 * turns this guard red.
 *
 * ⚠️ The guard counts **callers**, not mentions — the doc comments
 * of this repository quote the functions they talk about, and a
 * guard that counted prose would be red on the day it came into being and
 * switched off on the day after.
 *
 * ## The second caller, and why it has to be one (ADR-0028)
 *
 * `SystemLegalService.aiActive()` answers a **different question about
 * the same row**: not "may somebody use the AI?", but "does the
 * privacy policy of this installation describe an AI processing?". The
 * conditional section of the template is derived from it instead of asked,
 * because a checkbox that somebody set half a year ago produces
 * a false statement in both directions (see ADR-0028 no. 8).
 *
 * **It cannot ask `AiSettingsService`, and that is the reason.** That
 * service unseals the key; it gets dragged along by `SystemLegalService`
 * right onto the **public** path that delivers the legal
 * texts — and "the public path can decrypt nothing" is a
 * fact about the import graph (ADR-0014 „Der öffentliche Pfad",
 * `public-forms.module.ts`) that would fall for it. The call here therefore
 * stays the pure function over a projection that does not even fetch the
 * key (`findAiPresence`: `ai_api_key` stands in the **condition**).
 *
 * **What can separate the two is named:** a key that stands there,
 * but can no longer be unsealed, counts as present here and there
 * not. The policy then describes a feature that is absent — the
 * direction in which this error shall fall, and an operating fault that
 * stands out loudly anyway.
 */
const ALLOWED_CONSUMERS = [
  'apps/api/src/system-settings/ai-settings.service.ts',
  'apps/api/src/system-settings/system-legal.service.ts',
];

/**
 * The two forms of the availability question. Both count as a call —
 * see the reasoning at {@link callers}.
 */
const AVAILABILITY_ASKERS = ['aiAvailable', 'aiAvailableForTenant'];

describe('aiAvailable has a closed set of consumers', () => {
  /**
   * A *caller* is a file that both imports the symbol and applies it — not
   * merely one that mentions it. The distinction is load-bearing rather than
   * pedantic: this repository's doc comments quote the functions they talk
   * about, and a guard that counted prose would be red on the day it was
   * written and switched off on the day after.
   */
  const callers = (): string[] =>
    sources(ROOT)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        // **Both names, and that is the correction of a blunt version.**
        // The first draft searched only for `aiAvailable` — and
        // `AiSettingsService` calls `aiAvailableForTenant`, which in turn calls
        // `aiAvailable`. The guard thus found **zero** callers and would have
        // stayed green, no matter how many readers of the row somebody adds. A
        // guard that holds an empty set against an allow list measures nothing.
        return AVAILABILITY_ASKERS.some(
          (name) =>
            new RegExp(String.raw`import[^;]*\b${name}\b[^;]*from`, 's').test(
              text,
            ) && new RegExp(String.raw`\b${name}\s*\(`).test(text),
        );
      })
      .map((file) => relative(ROOT, file).split(sep).join('/'))
      .filter((file) => file !== 'packages/shared/src/ai-config.ts')
      .sort();

  it('reads the whole repository rather than an empty set', () => {
    expect(sources(ROOT).length).toBeGreaterThan(100);
  });

  it('is called from nowhere but the two named places', () => {
    expect(
      callers().filter((file) => !ALLOWED_CONSUMERS.includes(file)),
      'Ein zweiter Aufrufer von aiAvailable() ist eine zweite Meinung darüber, ' +
        'ob es die KI-Funktion gibt. Menü, Route und Erzeugung erben eine ' +
        'Antwort — siehe ADR-0015 Nr. 9 und seinen Nachtrag.',
    ).toEqual([]);
  });

  it('wird von den beiden benannten Lesern der Zeile aufgerufen', () => {
    // Both, expressly: a guard that names only the first would stay green
    // if the second quietly disappeared — and then the privacy policy would
    // carry an AI section that nobody resolves any more.
    expect(callers()).toContain(
      'apps/api/src/system-settings/ai-settings.service.ts',
    );
    expect(callers()).toContain(
      'apps/api/src/system-settings/system-legal.service.ts',
    );
  });
});

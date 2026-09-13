import type { AiProvider } from './ai.ts';
import { DEFAULT_AI_MODEL } from './ai-models.ts';
import { AI_REGION_DEFAULT, type AiRegion } from './ai-settings.ts';

/**
 * **Whether the AI feature exists at all, as a pure function of the
 * configuration** (ADR-0015 no. 5 and no. 9 with their 2026-08-11 addendum).
 *
 * Three functions live here and they answer three different questions:
 *
 * - {@link resolveAiConfig} — *which* provider, *which* key, *which* model,
 *   *which* region. It is the **one place the selection happens**; no second
 *   file switches over the provider.
 * - {@link aiAvailable} — *whether* the installation has the feature, defined
 *   as „resolveAiConfig liefert etwas". The two therefore cannot disagree.
 * - {@link aiAvailableForTenant} — whether **this organisation** has it, which is the
 *   first answer narrowed by the organisation's own switch.
 *
 * ## Where the values come from — this changed
 *
 * The input used to be the process environment (`AI_PROVIDER`, `AI_*_API_KEY`,
 * `AI_MODEL`, `AI_ENABLED`). Now it is the settings row, read and
 * unsealed by `AiConfigService` in `apps/api/src/ai/`. **These functions did
 * not learn to read a database** — they stayed pure, and that is what kept the
 * move to a single new caller instead of a new resolution: the shape of the
 * input changed, the decision did not.
 *
 * `timeoutMs` is handed in separately and still comes from the environment
 * (`AI_REQUEST_TIMEOUT_MS`), on purpose: it is a property of *this process*
 * — how long it is willing to wait — and not something an organisation overrides, which
 * is exactly the line the addendum draws for what may stay in the `.env`.
 */

/**
 * The settings fields the resolution reads. A structural subset, so the row
 * loaded from `system_setting` satisfies it without this file importing Prisma.
 *
 * Every field is `null`-able as well as optional, because the database says
 * „nicht eingerichtet" with NULL and a caller should not have to translate.
 */
export interface AiSettingsFields {
  /** The installation-wide switch. Absent counts as on — see the schema. */
  readonly enabled?: boolean | null | undefined;
  readonly provider?: AiProvider | null | undefined;
  /** **Already unsealed.** No function here ever sees a sealed envelope. */
  readonly apiKey?: string | null | undefined;
  readonly model?: string | null | undefined;
  /** Absent reads as {@link AI_REGION_DEFAULT} — `eu`, never „the first one". */
  readonly region?: AiRegion | null | undefined;
}

/** Everything an adapter needs, and nothing an adapter may decide itself. */
export interface ResolvedAiConfig {
  readonly provider: AiProvider;
  /**
   * The key, **explicitly**. It is never left to the SDK to find one
   * (ADR-0015 no. 5): both SDKs read `ANTHROPIC_API_KEY` / `MISTRAL_API_KEY`
   * out of the process environment when constructed without an argument, and
   * an installation that happens to have one of those set for something else
   * would then quietly have a configured AI — making „ohne Schlüssel 404"
   * untestable. Now the key does not live in the environment at all,
   * which makes that accident less likely and the explicit argument no less
   * necessary.
   */
  readonly apiKey: string;
  /** The pinned model identifier. Never a moving alias — see below. */
  readonly model: string;
  /** Where the provider is called (ADR-0015 no. 13). */
  readonly region: AiRegion;
  /** Our own deadline in milliseconds (ADR-0015 no. 6). */
  readonly timeoutMs: number;
}

/** Default of `AI_REQUEST_TIMEOUT_MS`, repeated by the schema (no. 6). */
export const DEFAULT_AI_TIMEOUT_MS = 60_000;

function blank(value: string | null | undefined): string | undefined {
  return value === undefined || value === null || value === ''
    ? undefined
    : value;
}

function modelOf(settings: AiSettingsFields, provider: AiProvider): string {
  return blank(settings.model) ?? DEFAULT_AI_MODEL[provider];
}

/**
 * Resolves the configuration, or `null` when the feature is not configured.
 *
 * `null` covers three different states on purpose — no provider, the
 * installation-wide off switch, and a provider whose key is missing. They are
 * three ways of saying „gibt es hier nicht", and the route answers **404** to
 * all of them (ADR-0015 no. 9). *(It was four until 2026-08-12: „ein Anbieter,
 * dessen Modell weder die Zeile noch die Vorgabe liefert" fell away when every
 * provider got a default.)*
 *
 * `enabled: false` is checked **first** and on its own: switching the feature
 * off has to work while a complete configuration sits in the row, because that
 * is the whole point of a switch.
 */
export function resolveAiConfig(
  settings: AiSettingsFields,
  timeoutMs: number = DEFAULT_AI_TIMEOUT_MS,
): ResolvedAiConfig | null {
  if (settings.enabled === false) {
    return null;
  }
  const provider = blank(settings.provider) as AiProvider | undefined;
  if (provider === undefined) {
    return null;
  }
  const apiKey = blank(settings.apiKey);
  if (apiKey === undefined) {
    return null;
  }
  return {
    provider,
    apiKey,
    model: modelOf(settings, provider),
    region: settings.region ?? AI_REGION_DEFAULT,
    timeoutMs,
  };
}

/**
 * **The availability question, asked in exactly one implementation**
 * (ADR-0015 no. 9).
 *
 * Its consumers are a **closed set** and the guard is `ai-config.test.ts`,
 * which reads the whole repository. That set is now *one* — the resolver
 * service `apps/api/src/ai/ai-config.service.ts` — and everything else asks
 * *it*: the route guard, the session payload's feature flag, the adapter
 * factory. Before the move there were two callers of a pure function over the
 * environment; now there is one caller of the pure function and one place that
 * reads the row, which is strictly the stronger shape — a second reader of the
 * row would be a second opinion about the configuration, and the test names it.
 */
export function aiAvailable(settings: AiSettingsFields): boolean {
  return resolveAiConfig(settings) !== null;
}

/**
 * **Whether *this organisation* has the feature — the three layers, evaluated**.
 *
 * `tenantEnabled` is the organisation's own switch: `null` means „erbt die
 * System-Vorgabe", so it falls through to whatever the installation says.
 *
 * The composition is deliberately an **and**, never an or: an organisation can take the
 * feature away from itself, and no value it can write gives it one the
 * installation does not have. That is the sentence the requirement measures by
 * calling the route directly rather than looking at what the page renders.
 *
 * ⚠️ **The quota is not part of this answer.** *„Darf dieser Organisation?"* is a
 * question about a budget that runs out mid-month, and it is answered per call
 * by `AiUsageService` with a **429**, not by making the whole feature vanish.
 * Folding it in here would turn „dein Kontingent ist aufgebraucht" into „diese
 * Funktion gibt es nicht", which is a different and much worse sentence.
 */
export function aiAvailableForTenant(
  settings: AiSettingsFields,
  tenantEnabled: boolean | null | undefined,
): boolean {
  return aiAvailable(settings) && (tenantEnabled ?? true);
}

/**
 * **Which field a half configuration is still missing** — for the settings
 * page, not for the start-up.
 *
 * Its predecessor `describeAiConfigProblem` used to make the *process refuse
 * to start*: setting `AI_PROVIDER` was the operator's statement „ich will diese
 * Funktion", and a missing key was a half wish that had to fail loudly
 * (ADR-0014 no. 2's shape).
 *
 * That reasoning does not survive the move, and pretending otherwise would have
 * been the expensive mistake: a form field is filled in **while the application
 * runs**, and a superadmin who picks a provider before pasting the key would
 * take the installation down for everybody — including the people whose
 * Jahrestagung registration has nothing to do with an AI. So the half
 * configuration now *shows* rather than *fails*: the row is written, the feature
 * stays absent (`resolveAiConfig` → `null`, route 404, no menu entry), and the
 * page names the gap.
 *
 * Returns the missing field or `null`. A field name rather than a sentence,
 * because the sentence belongs to the view and is German.
 *
 * ⚠️ **There used to be a second answer, `'model'`, and it is gone since
 * 2026-08-12** (Review-Nacharbeit). It meant „Anbieter gewählt, Schlüssel da,
 * aber keine Modellkennung" — a state only Mistral could reach while it had no
 * evidenced default. With {@link DEFAULT_AI_MODEL} total it cannot occur, and
 * keeping it „for a third adapter" was not caution but an unreachable branch
 * plus a test that reached it by casting a value the schema cannot produce. A
 * new provider now brings its default and its list, or it does not compile.
 *
 * It does **not** report a stored model that {@link AI_MODEL_CHOICES} no longer
 * carries — that configuration is complete and the feature works; it is the
 * settings page that says so, next to the field. Folding it in here would make
 * `gap` mean two different things, one of which is „die Funktion ist abwesend".
 */
export function describeAiConfigGap(
  settings: AiSettingsFields,
): 'apiKey' | null {
  const provider = blank(settings.provider) as AiProvider | undefined;
  if (provider === undefined) {
    return null;
  }
  return blank(settings.apiKey) === undefined ? 'apiKey' : null;
}

/**
 * **The five variables that moved, and the warning if one is still set**.
 *
 * An installation that keeps `AI_PROVIDER` in its `.env` after the upgrade has
 * **two** sources for the same state, and one of them wins invisibly — the
 * same failure already cleared up for SMTP. The application therefore never reads
 * them again *and* never stays silent about them: it says the name and where
 * the value lives now.
 *
 * The list is exported so the check and the `.env.example` drift test read the
 * same five names, rather than two hand-kept copies.
 */
export const MOVED_AI_ENV_VARS = [
  'AI_PROVIDER',
  'AI_ANTHROPIC_API_KEY',
  'AI_MISTRAL_API_KEY',
  'AI_MODEL',
  'AI_ENABLED',
] as const;

/**
 * Which of {@link MOVED_AI_ENV_VARS} the given environment still carries.
 *
 * Takes the **raw** environment rather than the parsed `ApiEnv`, because the
 * parsed one no longer has these keys at all — that is the point of the move.
 * A blank value counts as absent: `.env.example` ships `AI_PROVIDER=` empty in
 * older installations, and warning about an empty string would train operators
 * to ignore the warning.
 */
export function movedAiEnvVarsStillSet(
  raw: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  return MOVED_AI_ENV_VARS.filter((name) => blank(raw[name]) !== undefined);
}

/** The warning itself — one sentence, the names, and the new place. */
export function movedAiEnvWarning(names: readonly string[]): string {
  return (
    `Diese Umgebungsvariablen werden nicht mehr gelesen: ${names.join(', ')}. ` +
    'Die KI-Konfiguration steht in den Systemeinstellungen ' +
    '(Verwaltung → Systemeinstellungen → KI). Die Anwendung läuft normal ' +
    'weiter und benutzt die Werte aus der Umgebung nicht.'
  );
}

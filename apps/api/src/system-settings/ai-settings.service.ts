import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  AI_REGION_DEFAULT,
  aiProviderSchema,
  aiRegionSchema,
  aiAvailableForTenant,
  describeAiConfigGap,
  movedAiEnvVarsStillSet,
  movedAiEnvWarning,
  resolveAiConfig,
  type AiProvider,
  type AiRegion,
  type AiSettingsFields,
  type ApiEnv,
  type ResolvedAiConfig,
  type SystemAiSettings,
  type UpdateSystemAiSettingsRequest,
} from '@formsache/shared';

import { API_ENV } from '../config/env';
import {
  SecretBoxError,
  SecretBoxService,
} from '../common/secret-box/secret-box.service';
import { systemSecretContext } from '../common/secret-box/secret-context';
import {
  INITIAL_AI_REVISION,
  SystemSettingsRepository,
  type SystemAiRow,
} from './system-settings.repository';

/**
 * The context the provider key is sealed under — **built here once**, never at
 * a call site (`secret-context.ts`). Two segments, because `system_setting`
 * holds exactly one row and a holder id would be a constant pretending to be a
 * discriminator.
 */
const AI_KEY_CONTEXT = systemSecretContext('ai.api_key');

/**
 * What a broken seal reads as. Logged **once per process**, like the mail side
 * — an unreadable key means a `SECRET_BOX_KEY` rotation or a restore with the
 * wrong key, and the operator needs to see it, but not once
 * per request.
 */
const AI_KEY_UNREADABLE =
  'Der hinterlegte KI-Schlüssel lässt sich nicht entsiegeln (falscher oder ' +
  'rotierter SECRET_BOX_KEY). Die KI-Funktion bleibt abwesend, bis ein ' +
  'Schlüssel neu hinterlegt wird; die übrige Anwendung ist unberührt.';

/**
 * **The one place where the AI configuration is read** (ADR-0015
 * no. 9 with the addendum of 2026-08-11).
 *
 * It used to live in the environment, and "read" meant: a pure call of
 * `resolveAiConfig(env)` in two places. By now it lives in the row, and
 * thus two pure calls become a query — which may exist exactly **once**.
 * Hence this service: the route, the session's menu switch
 * and the adapter factory all ask *it*, and `resolveAiConfig` keeps exactly
 * one caller.
 *
 * ## What stays locked up here
 *
 * ⚠️ **The plaintext key leaves this service only in the direction of the adapter.**
 * {@link available} answers the availability question with a `boolean`,
 * {@link readForAdmin} with `apiKeySet` — neither of the two ever carries the value.
 * Only {@link resolve} hands it out, and its only caller is the
 * creation of the adapter. `test/ai/key-confinement.spec.ts` measures that.
 *
 * ## Why the service lives here and not in `ai/`
 *
 * `SystemSettingsModule` exports its **services**, never the repository —
 * "only one access path to `system_setting`" is thereby a property of the
 * module and not a rule somebody has to keep. A reader in `ai/` would need
 * either the repository (then that property would fall) or an own
 * `PrismaService` entry in the allowlist (then there would be a second
 * access path to the same row). So the reader lives where the row is
 * read, and `AiModule` imports it.
 */
@Injectable()
export class AiSettingsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiSettingsService.name);
  private unreadableReported = false;

  constructor(
    private readonly repository: SystemSettingsRepository,
    private readonly secrets: SecretBoxService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * **The environment does not stay silent when it still carries something** .
   *
   * An installation that leaves `AI_PROVIDER` standing in its `.env` after the
   * upgrade has **two** sources for the same state, and one of them
   * wins invisibly — the same mistake that was already avoided with SMTP.
   * The application never reads the five names again *and* does not stay silent about
   * them: it names them and says where the value now lives.
   *
   * What is read is the **raw** environment, not `ApiEnv` — in the parsed object
   * these keys no longer exist at all, and that is the point of the move.
   * The value itself is never logged: one of the five is an
   * API key.
   */
  onApplicationBootstrap(): void {
    const stillSet = movedAiEnvVarsStillSet(process.env);
    if (stillSet.length > 0) {
      this.logger.warn(movedAiEnvWarning(stillSet));
    }
  }

  /**
   * The resolution — provider, key, model, region and our timeout.
   *
   * `null` means "does not exist here", and that for all the states that
   * `resolveAiConfig` gathers up: no row, no provider, the
   * installation-wide switch off, no key, no model — **and** a
   * key that cannot be unsealed. The last case is the only one
   * worth a message, because it looks like an operating error and
   * is none.
   */
  async resolve(): Promise<ResolvedAiConfig | null> {
    return resolveAiConfig(
      await this.settingsFields(),
      this.env.AI_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * **The row as a field set — once, and that is the point.**
   *
   * Up to the review gate, {@link resolve} and {@link available} each built the
   * object themselves out of the same five columns. With that, „Menü und Route
   * können nicht auseinanderlaufen" (ADR-0015 no. 9) was again a question of
   * care: whoever adds a field and follows up in only one place gets
   * exactly that divergence back — and neither of the two tests would have
   * shown it, because both check the same configuration.
   *
   * The *rule* nevertheless stays in `@formsache/shared`: `resolveAiConfig` and
   * `aiAvailableForTenant` are pure and checked individually. Here stands only how
   * a row becomes their input.
   *
   * A missing row is an empty field set and not a special case: `enabled`
   * is missing (counts as on), provider is missing — so "does not exist here", exactly
   * like a row without a provider.
   */
  private async settingsFields(): Promise<AiSettingsFields> {
    const row = await this.repository.findAi();
    if (row === null) {
      return {};
    }
    return {
      enabled: row.aiEnabled,
      provider: parseProvider(row.aiProvider),
      apiKey: this.openKey(row.aiApiKey),
      model: row.aiModel,
      region: parseRegion(row.aiRegion),
    };
  }

  /**
   * Does **this organisation** have the feature? — the three layers, evaluated.
   *
   * `tenantEnabled` is the organisation's own switch; `null` means "inherits the
   * system default". The combination is an **and**: an organisation can take the
   * feature away from itself, but cannot give one the installation does not have.
   *
   * Deliberately returns a `boolean` and not the resolution — whoever only wants
   * to know *whether* gets no key put into their hand.
   *
   * ⚠️ **Via {@link resolve} and not via a second mapping of the row.**
   * The first draft built its own `AiSettingsFields` object here out of
   * the same five columns — and with that, „Menü und Route können nicht
   * auseinanderlaufen" was again a question of care: whoever adds a field
   * and follows up in only one of the two places gets exactly that divergence
   * back, against which ADR-0015 no. 9 is built. A review found it;
   * both cases checked the same configuration and would never have shown it.
   */
  async available(tenantEnabled: boolean | null = null): Promise<boolean> {
    return aiAvailableForTenant(await this.settingsFields(), tenantEnabled);
  }

  /**
   * What the superadmin page sees — **never the key**, only `apiKeySet`.
   *
   * `gap` says which field a half configuration still needs. It used to be
   * a startup abort; since the move it is a display, because a
   * form field is filled in during running operation and a superadmin who
   * sets the provider before the key would otherwise take the whole installation
   * down.
   */
  async readForAdmin(): Promise<{
    readonly settings: SystemAiSettings;
    readonly gap: 'apiKey' | 'model' | null;
    readonly revision: number;
  }> {
    const row = await this.repository.findAi();
    const settings = toDisplay(row);
    return {
      settings,
      gap: describeAiConfigGap({
        provider: settings.provider,
        // The display path does not know the value and does not need it: for the
        // question "is a key still missing?" it suffices **that** there is one.
        apiKey: settings.apiKeySet ? 'set' : null,
        model: settings.model,
      }),
      revision: row?.aiRevision ?? INITIAL_AI_REVISION,
    };
  }

  /**
   * Writes the configuration. `false` means 409 — somebody else was faster.
   *
   * The key has three states (`aiApiKeyWriteSchema`): absent → leave
   * standing, string → replace, `null` → remove. The first is the
   * reason why the page gets by without the stored value.
   */
  async write(request: UpdateSystemAiSettingsRequest): Promise<boolean> {
    const stored = await this.repository.findAi();
    const nextKey = this.nextKey(request.apiKey, stored?.aiApiKey ?? null);
    return this.repository.writeAi(request.lock, {
      aiEnabled: request.enabled,
      aiProvider: request.provider,
      aiModel: request.model,
      aiRegion: request.region,
      aiApiKey: nextKey,
    });
  }

  /** absent → keep · string → seal the new one · null → remove. */
  private nextKey(
    written: string | null | undefined,
    stored: string | null,
  ): string | null {
    if (written === undefined) {
      return stored;
    }
    if (written === null) {
      return null;
    }
    return this.secrets.seal(written, AI_KEY_CONTEXT);
  }

  /**
   * Unseals, or `null`.
   *
   * **Fail closed and loud enough to be found.** A key that
   * cannot be opened is not a half-usable state: the feature
   * is then absent (404), and the message says once per process what the
   * cause is. Without it the operator would only see that the AI is „plötzlich weg" —
   * the same silent exit that the requirement on the access word measures.
   */
  private openKey(sealed: string | null): string | null {
    if (sealed === null) {
      return null;
    }
    try {
      return this.secrets.open(sealed, AI_KEY_CONTEXT);
    } catch (error) {
      if (error instanceof SecretBoxError) {
        if (!this.unreadableReported) {
          this.unreadableReported = true;
          // Error class, never the message and never the value.
          this.logger.error(AI_KEY_UNREADABLE);
        }
        return null;
      }
      throw error;
    }
  }
}

/**
 * The provider from the column — `null` if something stands there that is no
 * provider.
 *
 * A text column can carry something the Zod schema does not know (a
 * hand-written migration, a restored backup of a newer version). That
 * is "not set up" and not a crash: `null` means that the feature
 * is absent, and the application keeps running.
 */
function parseProvider(value: string | null): AiProvider | null {
  if (value === null) {
    return null;
  }
  const parsed = aiProviderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The region from the column — **NULL and anything unknown read as `eu`**.
 *
 * The default value is not "empty" and not "the first region found": a
 * fresh installation would otherwise process outside the EU without anybody
 * having set anything.
 */
function parseRegion(value: string | null): AiRegion {
  if (value === null) {
    return AI_REGION_DEFAULT;
  }
  const parsed = aiRegionSchema.safeParse(value);
  return parsed.success ? parsed.data : AI_REGION_DEFAULT;
}

/** The row as a display document — without a row the default state applies. */
function toDisplay(row: SystemAiRow | null): SystemAiSettings {
  return {
    enabled: row?.aiEnabled ?? true,
    provider: parseProvider(row?.aiProvider ?? null),
    model: row?.aiModel ?? null,
    region: parseRegion(row?.aiRegion ?? null),
    apiKeySet: (row?.aiApiKey ?? null) !== null,
  };
}

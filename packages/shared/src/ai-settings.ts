import { z } from 'zod';

import { AI_MODEL_CHOICES } from './ai-models.ts';
import { aiProviderSchema, type AiProvider } from './ai.ts';

/**
 * **The AI configuration as a settings document** — the wire side of the move
 * ADR-0015's addendum of 2026-08-11 decided.
 *
 * Provider, key, model and off switch used to stand in the process
 * environment. They moved for the reason `SystemSetting.smtp` states in its own
 * comment — *„a value that is overridable per organisation does not belong in a file
 * that describes the process"* — and this file is the third application of that
 * pattern, after `SMTP_*` and `PUBLIC_BASE_URL`.
 *
 * **The split runs along one line: what is a secret, and what is not.** Only
 * the key is sealed. Provider, model, region and the switch lie open, and that
 * is not convenience — it is the lesson `reply_to` cost: a block is indivisible
 * because it carries a secret, so anything put inside it becomes unchangeable
 * without that secret. Nobody would be able to switch the region on an
 * installation that has no key yet.
 */

/**
 * **Where the provider is called** (ADR-0015 no. 13 and its 2026-08-11
 * addendum).
 *
 * A closed enumeration, never a URL. The pinned EU endpoint **is** the data
 * protection statement of ADR-0015 no. 13; a free text field would turn it into
 * a guess, and `z.string().url()` would have been the comfortable way to do
 * exactly that.
 *
 * The three members are the three servers the Mistral SDK offers
 * (`lib/config.ts`); Anthropic has one endpoint and ignores this field, which is
 * why it is a property of the installation rather than of the provider — an
 * operator switching providers does not lose their answer to the question.
 */
export const aiRegionSchema = z.enum(['eu', 'global', 'us']);
export type AiRegion = z.infer<typeof aiRegionSchema>;

/**
 * **`eu`, and deliberately not „die erste gefundene Region"** .
 *
 * A missing row must mean the careful answer, not the first one in the list: a
 * fresh installation would otherwise process outside the EU without anybody
 * having set anything. The default lives here rather than in the Zod schema of
 * the column so that *both* readers — the row that has no value and the client
 * that renders the field — reach for the same constant.
 */
export const AI_REGION_DEFAULT: AiRegion = 'eu';

/**
 * The AI block as the superadmin's page reads it — **never the key**.
 *
 * `apiKeySet` rather than the value, the same shape `oidcConfigSchema` uses for
 * its client secret: the page has to be able to say „ein Schlüssel ist
 * hinterlegt" without carrying one, and `strictObject` means a server that
 * started sending the key here would fail at load time on the client rather
 * than put a secret on screen.
 *
 * Unlike SMTP this block **can** be half-configured, and the display says so:
 * a provider without a key is a real state (somebody chose Anthropic and has not
 * pasted the key yet), and the feature is simply absent until both are there.
 */
export const systemAiSettingsSchema = z.strictObject({
  /**
   * The installation-wide switch — what used to be `AI_ENABLED`.
   *
   * `true` on a fresh installation, because „aus" is already expressed by
   * having no provider: a switch that defaulted to off would mean an operator
   * who pastes a key still gets a 404 and no hint why.
   */
  enabled: z.boolean(),
  /** `null` — „nicht eingerichtet", not a fault (ADR-0013 no. 5). */
  provider: aiProviderSchema.nullable(),
  /** The pinned model, or `null` for „der Vorgabewert des Anbieters". */
  model: z.string().nullable(),
  /** Never `null`: an unset row reads as {@link AI_REGION_DEFAULT}. */
  region: aiRegionSchema,
  /** Whether a key is stored. The key itself never leaves the server. */
  apiKeySet: z.boolean(),
});
export type SystemAiSettings = z.infer<typeof systemAiSettingsSchema>;

/**
 * The key on the way **in** — three states, exactly like
 * `oidcConfigWriteSchema.clientSecret`.
 *
 * absent → keep what is stored · a string → replace it · `null` → remove it.
 *
 * The three are distinguishable on the wire because the field is optional *and*
 * nullable, and they have to be: a page that always sent the field would need
 * the current key to render, which is the one thing it must never have.
 */
export const aiApiKeyWriteSchema = z.string().min(1).nullable().optional();

/**
 * A write of the installation's AI configuration.
 *
 * **A full replace of every open field, not a patch** — the same shape
 * `updateSystemMailSettingsRequestSchema` has: the page holds the whole
 * document, so it names every current value again. Only the key is exempt, for
 * the reason above.
 */
export const updateSystemAiSettingsRequestSchema = z
  .strictObject({
    enabled: z.boolean(),
    provider: aiProviderSchema.nullable(),
    /**
     * `null` means „nimm den Vorgabewert des Anbieters" — since 2026-08-12 both
     * providers have one (`DEFAULT_AI_MODEL`), so this is now the *normal* value
     * rather than the state „nicht konfiguriert".
     *
     * It stays a free `string` on the wire although the page offers a closed
     * dropdown (`AI_MODEL_CHOICES`). That is deliberate: a stored identifier that
     * the list no longer carries — an installation from the free-text era, or a
     * model the provider has since retired — must survive a save unchanged
     * instead of being rewritten to the default behind the operator's back.
     * Narrowing this to the list would make a provider's retirement schedule able
     * to invalidate a row that is sitting in the database.
     */
    model: z.string().min(1).nullable(),
    region: aiRegionSchema,
    apiKey: aiApiKeyWriteSchema,
    /**
     * The optimistic lock this superadmin started from — `ai_revision`, the
     * block's **own** counter.
     *
     * Not `updated_at` and not `mail_revision`: the first moves on any write to
     * the row and compares equal within a millisecond, the second belongs to a
     * different page. A counter cannot land in the same millisecond as another
     * counter; it is either the value a reader saw or it is not.
     */
    lock: z.number().int().positive(),
  })
  .superRefine((value, ctx) => {
    /**
     * **The model of a *different* provider is rejected** (review rework on the
     * select field, 2026-08-12).
     *
     * Without this rule the only promise of this rebuild would live in the
     * browser alone, and CONTRIBUTING.md says the opposite: *the server always
     * validates itself – the client validation is pure UX*. A PUT with
     * `{provider: 'mistral', model: 'claude-opus-5'}` would otherwise pass with
     * 200, `resolveAiConfig` would hand the Anthropic identifier to the Mistral
     * adapter, and the answer would land in `aiFailureKindSchema`'s catch-all
     * case `unavailable` — indistinguishable from a bad afternoon at the
     * provider. Exactly the mistake the selection list set out against.
     *
     * ⚠️ **What is checked is only the belonging to a *foreign* list, not the
     * membership in one's own.** That is the difference between a rule and a
     * straitjacket: a free-text legacy identifier and a model retired by the
     * provider stand in **no** list and therefore stay allowed — otherwise the
     * retirement schedule of a foreign service could invalidate a row that has
     * long been lying in the database.
     */
    if (value.provider === null || value.model === null) {
      return;
    }
    const foreign = (Object.keys(AI_MODEL_CHOICES) as AiProvider[]).find(
      (provider) =>
        provider !== value.provider &&
        AI_MODEL_CHOICES[provider].some((choice) => choice.id === value.model),
    );
    if (foreign !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: `Die Modellkennung gehört zu ${foreign}, nicht zum gewählten Anbieter.`,
      });
    }
  });
export type UpdateSystemAiSettingsRequest = z.infer<
  typeof updateSystemAiSettingsRequestSchema
>;

/**
 * **An organisation's own switch — the third of the three layers** .
 *
 * Three questions, three places, and they are **monotone**: every layer can
 * only take away.
 *
 * | Question | Where |
 * |---|---|
 * | *Can this installation do AI?* | `system_setting`: provider, key, model, region |
 * | *May this organisation?* | `tenant.ai_monthly_call_limit` — **only** superadmin  |
 * | *Does this organisation want to?* | this switch |
 *
 * `null` means „erbt die System-Vorgabe". It is a third state rather than a
 * boolean defaulting to the system value, because those two are only the same
 * until somebody changes the system: an organisation that copied `true` at the moment it
 * was written would keep it after the installation switched off, and „er kann
 * sich nichts geben, was er nicht hat" would be false the first time it
 * mattered.
 */
export const tenantAiSwitchSchema = z.strictObject({
  /** `null` — inherit. `false` — this organisation does not want it. */
  enabled: z.boolean().nullable(),
  /**
   * **Whether the installation has the feature at all** — a display, not a dial
   * (the organisation can change nothing about it).
   *
   * It stands here because otherwise the organisation's surface could not answer
   * the question at all: `aiFormsAvailable` of the session is already the **and**
   * from both layers, so `false` there means either „die Installation hat keine
   * KI" or „diese Organisation hat sich abgeschaltet" — and the page on which one
   * switches oneself back on is exactly the one that has to know the difference.
   * The superadmin route next to it (`GET /admin/system-settings/ai`) is locked
   * for an organisation admin, and it should stay that way: what travels here is
   * a `boolean`, no provider, no model, no region, no `apiKeySet`.
   *
   * If it is `false`, one's own switch is without consequence — the surface says
   * so instead of offering a choice that has no effect.
   */
  systemAvailable: z.boolean(),
});
export type TenantAiSwitch = z.infer<typeof tenantAiSwitchSchema>;

/** Reading foreign data as an organisation's switch — the one door. */
export function parseTenantAiSwitch(source: unknown): TenantAiSwitch {
  return tenantAiSwitchSchema.parse(source);
}

/**
 * A write of an organisation's own switch — **the one field that belongs to it**.
 *
 * `systemAvailable` is missing here on purpose and `strictObject` turns that
 * into a refusal instead of a silent adoption: what the installation can do is
 * not a statement of the caller.
 */
export const updateTenantAiSwitchRequestSchema = z.strictObject({
  enabled: z.boolean().nullable(),
});
export type UpdateTenantAiSwitchRequest = z.infer<
  typeof updateTenantAiSwitchRequestSchema
>;

/**
 * What the superadmin page loads.
 *
 * `strictObject` throughout: a server that did send the key along would fail on
 * loading in the client instead of bringing a secret onto the screen — the same
 * allow-list promise that `systemMailSettingsSchema` makes.
 */
export const systemAiSettingsResponseSchema = z.strictObject({
  values: systemAiSettingsSchema,
  /**
   * Which field a half configuration still needs — `null` if none.
   *
   * That used to be a **startup abort**. As a form field the same abort would be
   * the most expensive conceivable reaction, so it is a display: the row is
   * saved, the feature stays absent, and the page says what it is down to.
   *
   * Since 2026-08-12 there is only **one** value left: `'model'` fell away when
   * every provider got a default value (`describeAiConfigGap`). The enumeration
   * type nevertheless stays an enumeration — a second value is conceivable, and
   * `z.literal` would turn adding one into a schema change instead of an entry.
   */
  gap: z.enum(['apiKey']).nullable(),
  /** `ai_revision` — the block's own counter. */
  lock: z.number().int().positive(),
});
export type SystemAiSettingsResponse = z.infer<
  typeof systemAiSettingsResponseSchema
>;

/**
 * **The five preconditions to be settled before the first provider.**
 *
 * They stand here and not in the view, because two places need them: the form
 * field and the data protection documentation. Two transcripts would be two
 * lists that drift apart — and the one nobody reads would be the one in the
 * file.
 *
 * ⚠️ **Why they stand in the view at all.** Switching on was a *deployment*:
 * slow, deliberate, driven by somebody who knew what they were doing. In future
 * it is a form field — and this difference the application has to make up for
 * itself.
 */
export const AI_PRECONDITIONS: readonly string[] = [
  'Ein Auftragsverarbeitungsvertrag (Art. 28 DSGVO) mit dem Anbieter liegt vor.',
  'Die Frage der EU-Verarbeitung ist beantwortet: Mistral läuft über den ' +
    'gewählten Regional-Endpunkt, Anthropic nicht.',
  'Der Eintrag im Verarbeitungsverzeichnis ist geschrieben.',
  'Das Kontingent je Organisation ist gesetzt — es bestimmt die Rechnung.',
  'Die 30-Tage-Löschung des eingegebenen Freitexts ist benannt.',
];

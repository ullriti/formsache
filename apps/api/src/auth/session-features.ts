/**
 * **What optional features this installation has — the second and
 * last place that asks for them** (ADR-0015 no. 9).
 *
 * The answer comes from `AiSettingsService` — the **only**
 * reader of the settings row, the one `AiFeatureGuard` also draws its 404 from.
 * Menu and route therefore cannot drift apart: it is one resolution,
 * read twice, and „letting only the interface hide the switch" is
 * exactly the failure shape that this prevents.
 *
 * **It is not a permission.** It answers „gibt es die Funktion hier?", never
 * „darf diese Person sie benutzen?" — the second question belongs to the guard
 * chain and is asked on every request regardless of what any client believes
 * (the interface is convenience, enforcement happens server-side).
 *
 * A pure function over an **already answered** question, not over the
 * environment: the caller asks `AiSettingsService`, because since the move the
 * answer comes from a row and changes while the system runs. {@link
 * toSessionFeatures} is handed to `toSessionUser` as a mandatory argument, so
 * that the three places that build a session payload — sign-in, session fetch
 * and Organisation switch — cannot each decide for themselves whether to send
 * it along.
 */

/** The feature flags of one session payload — the API's view of them. */
export interface SessionFeatures {
  /**
   * AI form generation. `false` for every state that `resolveAiConfig`
   * sums up as „it does not exist here" — no row, no provider, no
   * key, no model, the installation-wide switch off — **and** for
   * an Organisation that has switched itself off.
   */
  readonly aiFormsAvailable: boolean;
}

/**
 * Wraps up the answer the caller already has.
 *
 * A `boolean` as the argument instead of a configuration: this file is **not**
 * meant to be able to answer the question a second time — it has no access
 * to the row, and that is precisely the intent.
 */
export function toSessionFeatures(aiFormsAvailable: boolean): SessionFeatures {
  return { aiFormsAvailable };
}

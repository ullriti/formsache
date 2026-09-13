import { z } from 'zod';

/**
 * **Which dated version sits behind a Mistral alias** — the one rule
 * `GET /v1/models` does not supply along with it (2026-08-12).
 *
 * Ever since the selection list stands on aliases (`ai-models.ts`), the
 * provider reports **the alias back** in the `model` field of its answer —
 * measured on 2026-08-12 against `api.eu.mistral.ai`. `ai_usage.model` would
 * thereby carry „mistral-large-latest" for all time, and the question „which
 * version ran in March?" would be unanswerable as soon as the provider moves
 * the alias on.
 *
 * ## Why that needs a *rule* and not just a field
 *
 * The model list names its `aliases` for every entry — **symmetrically**.
 * `mistral-large-latest` lists `mistral-large-2512`, and `mistral-large-2512`
 * lists `mistral-large-latest`. From the answer alone it is therefore not
 * possible to tell which of the two is the *pinned* version; the list only
 * says that they mean the same thing.
 *
 * The decision is therefore made on the **shape** of the id, and that one is
 * evidenced with this provider (measured list of 2026-08-12, 56 entries):
 *
 * | Form | moves? | Example |
 * |---|---|---|
 * | `name-latest` | yes, arbitrarily | `mistral-large-latest` |
 * | `name-major` / `name-major-minor` | yes | `mistral-medium-3`, `mistral-medium-3-5` |
 * | **`name-YYMM`** | **no** | `mistral-large-2512`, `mistral-medium-2604` |
 *
 * ⚠️ **`mistral-medium-3-5` looks like a pinned id and is none.** That is
 * exactly what stood in the code as „pinned" for half a day, copied from the
 * documentation instead of checked against the list. The measurement shows it
 * as an alias of the same thing as `mistral-medium-2604`. The rule below
 * therefore hangs on four digits and not on whether an id „looks technical".
 */

/**
 * Four digits at the end — `YYMM`, the only pinned form of this provider.
 *
 * Deliberately **not** „ends in digits": `mistral-medium-3` ended in those too
 * and moves on with every minor version.
 */
const PINNED_FORM = /-\d{4}$/u;

/**
 * The pinned version behind an id, or `null`.
 *
 * `null` is a full-fledged result and not a mishap: it means „the provider
 * does not let this be told from its list", and the row then simply carries
 * the alias only. The case arises when none of the ids that belong together is
 * dated — and, more importantly, when **several** of them are: then any choice
 * would be guessed, and a guessed cost attribution is worse than a missing
 * one.
 *
 * An already dated id resolves to itself. That is not special treatment but
 * falls out of the same rule: it is the only dated one in its group.
 */
export function pinnedMistralModel(
  id: string,
  aliases: readonly string[] = [],
): string | null {
  const dated = [id, ...aliases].filter((name) => PINNED_FORM.test(name));
  // `Set`, because the list may carry an id twice — it is the self-report of a
  // foreign service, not a normalised table.
  const unique = [...new Set(dated)];
  return unique.length === 1 ? (unique[0] ?? null) : null;
}

/**
 * One entry of the model list, **as much of it as is needed here**.
 *
 * Foreign data comes in as `unknown` and is parsed through a Zod schema — even
 * when the SDK offers a type. Here it does not even offer a usable one:
 * `ModelList.data` is a union of `BaseModelCard`, `FTModelCard` and an
 * explicit `Unknown`, on which `id` does not exist at all. An `as` over that
 * would be the claim that we know better than the SDK.
 *
 * `.loose()` instead of `strictObject`: the list carries a dozen fields that
 * are none of our business, and a new field of the provider must not make this
 * answer fail.
 */
const modelCardSchema = z.looseObject({
  id: z.string().min(1),
  aliases: z.array(z.string()).optional(),
});

/**
 * The pinned version for `wanted` out of a **raw** model list, or `null`.
 *
 * Takes `unknown` and not the SDK type, so that the whole path from the answer
 * to the decision is testable without the SDK — and so that an entry the
 * schema does not recognise is skipped instead of pulling everything down with
 * it.
 */
export function pinnedMistralModelInList(
  list: unknown,
  wanted: string,
): string | null {
  const parsed = z
    .looseObject({ data: z.array(z.unknown()).optional() })
    .safeParse(list);
  if (!parsed.success) {
    return null;
  }
  for (const entry of parsed.data.data ?? []) {
    const card = modelCardSchema.safeParse(entry);
    if (card.success && card.data.id === wanted) {
      return pinnedMistralModel(card.data.id, card.data.aliases ?? []);
    }
  }
  return null;
}

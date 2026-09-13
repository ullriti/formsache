import type { AiFailureKind } from '@formsache/shared';

/**
 * The sentence an editor reads when the model did not deliver — one per
 * named failure (ADR-0015 no. 2).
 *
 * **Six sentences rather than one „das hat nicht geklappt", because they ask
 * for different reactions.** „Nochmal drücken" is right after a timeout and
 * useless after a refusal; „kürzer beschreiben" is right after a truncated
 * answer and nonsense after a rate limit. A single wording would hide exactly
 * the difference the closed failure type was built to carry.
 *
 * A `Record` over the union rather than a `switch` with a default: a seventh
 * kind added to `aiFailureKindSchema` makes **this file** stop compiling, which
 * is the point — a default arm would swallow it and ship „unbekannter Fehler"
 * to somebody who is owed an answer. `ai-failure-message.test.ts` measures the
 * same property at runtime by walking `AI_FAILURE_KINDS`.
 *
 * Nothing here echoes the provider. The one foreign string that may reach the
 * screen is `detail` of the response — **our own** German sentence about
 * **our own** schema, composed in `ai-form-draft.ts` and bounded there — and it
 * is rendered as text beside these, never merged into them.
 */
const AI_FAILURE_MESSAGES: Readonly<Record<AiFailureKind, string>> = {
  timeout:
    'Der KI-Dienst hat nicht rechtzeitig geantwortet. Ein zweiter Versuch kann helfen.',
  rate_limited:
    'Der KI-Dienst nimmt gerade keine weiteren Anfragen an. Bitte in einer Minute erneut versuchen.',
  invalid_output:
    'Die Antwort des KI-Dienstes war kein gültiges Formular und wurde deshalb nicht übernommen.',
  truncated:
    'Die Antwort des KI-Dienstes brach mitten im Formular ab. Eine kürzere Beschreibung hilft meistens.',
  refused:
    'Der KI-Dienst hat die Anfrage abgelehnt. Bitte das Formular anders beschreiben.',
  unavailable:
    'Der KI-Dienst ist derzeit nicht erreichbar. Bitte später erneut versuchen.',
};

export function aiFailureMessage(kind: AiFailureKind): string {
  return AI_FAILURE_MESSAGES[kind];
}

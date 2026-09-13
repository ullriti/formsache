import type { Question, QuestionType } from './form-schema.ts';

/**
 * Which question types can supply an address.
 *
 * Exactly `email`, and the narrowness is the point: a `text` question can hold
 * an address, a phone number, a sentence or a joke, and a notification whose
 * destination is „whatever somebody typed into a free-text box" is a mail aimed
 * at nobody.
 *
 * **One list, on both sides of the wire.** It used to stand twice — enforcing
 * in `apps/api/src/notifications/notification-questions.ts` (the 422 on a
 * recipient naming any other question) and offering in
 * `apps/web/src/views/notifications/address-questions.ts` (which chips the
 * editor sees). The web copy's own comment already named the moment to lift
 * both here, and this project had already paid three times for exactly that shape of
 * duplication (`pickDefaultColumns`, die Platzhalter-Grammatik, eine
 * Vorschau-Höhe).
 *
 * **Deliberately *not* exhaustive over `QuestionType` — and that is the whole
 * difference to how new question types are handled elsewhere.** Elsewhere,
 * five places were closed where a forgotten type silently inherited the
 * behaviour of a single-line text field; this list is the counter-example
 * that must stay a *Positivliste*. Turned into a `Record<QuestionType,
 * boolean>`, a new type would have to be decided — and the cheap decision
 * („it holds text, so yes") would hand a notification a recipient nobody
 * vouched for. Seven types have since been added and **none** of them
 * belongs here; a type is added to this list only when it validates as an
 * address, which today only `email` does.
 *
 * **Why a behavioural test cannot hold this in place, and what does.** While
 * the list is exactly `['email']`, one copy and two copies are
 * indistinguishable from the outside: every test stays green if somebody
 * reintroduces the second one. The guarantee is therefore structural —
 * `single-source.test.ts` fails if this identifier is *defined* outside this
 * package. Importing it is what every other file is supposed to do.
 */
export const ADDRESS_QUESTION_TYPES: readonly QuestionType[] = ['email'];

/** Whether this question can be used as a recipient. */
export function isAddressQuestion(question: Question): boolean {
  return ADDRESS_QUESTION_TYPES.includes(question.type);
}

/** The questions of a form that may be chosen as a recipient, in order. */
export function addressQuestionsOf(questions: readonly Question[]): Question[] {
  return questions.filter(isAddressQuestion);
}

import { formatDeadline, type PublicAvailability } from '@formsache/shared';

/**
 * What a participant is told instead of a form they cannot hand in
 * (second half).
 *
 * The server already decided *whether* the form is open — `availability` is the
 * verdict of `availabilityOf()`, computed once, on the server, from the
 * effective settings. Nothing here re-judges it; this turns the
 * three closed states into two German sentences.
 *
 * **A pure function rather than a component**, so the wording can be asserted
 * without rendering a page, and so the branch in `PublicFormView` stays the two
 * lines it should be.
 *
 * **`open` yields `null`, and the caller must handle it.** Returning a
 * „Formular ist offen"-notice would invite a surface to render the notice *and*
 * the form.
 */
export interface UnavailableNotice {
  readonly headline: string;
  readonly detail: string;
}

export function unavailableNotice(
  availability: PublicAvailability,
): UnavailableNotice | null {
  switch (availability.state) {
    case 'open':
      return null;
    case 'not_yet_open':
      return {
        headline: 'Dieses Formular ist noch nicht geöffnet.',
        detail:
          availability.opensAt === null
            ? 'Bitte später erneut vorbeischauen.'
            : `Es öffnet am ${formatDeadline(availability.opensAt)}.`,
      };
    case 'closed':
      return {
        headline: 'Die Frist für dieses Formular ist abgelaufen.',
        detail:
          availability.closesAt === null
            ? 'Es können keine Antworten mehr abgegeben werden.'
            : // The instant, with its zone, because „abgelaufen" without a date
              // is the sentence a Mitglied writes back about.
              `Sie endete am ${formatDeadline(availability.closesAt)}.`,
      };
    case 'limit_reached':
      return {
        // **„Höchstzahl an Antworten", not „vollständig belegt"** (finding
        // 32, second part). The old sentence said two wrong things at once: it
        // called an arbitrary form a registration, and „belegt" describes the
        // places of an event — `limit_reached`, though, is the *answer limit*
        // of the form and has nothing to do with event places (those have a
        // refusal of their own, `event_full`).
        headline: 'Die Höchstzahl an Antworten ist erreicht.',
        // No number: how many answers a form has taken is configuration the
        // public payload deliberately does not carry.
        detail: 'Es werden keine weiteren Antworten mehr angenommen.',
      };
  }
}

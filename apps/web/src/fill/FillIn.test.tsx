import type { PublicForm, SubmitResponseResponse } from '@formsache/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/http';
import type { PublicSubmission } from '../api/public-form';
import { FillIn, type SubmitController } from './FillIn';
import { HONEYPOT_TEST_ID } from './HoneypotField';

/**
 * A required dropdown with „Sonstiges".
 *
 * The dropdown now has a free-text box; this file asserts what the *form* does
 * with it. Two promises: an empty box under a chosen „Sonstiges" is not an
 * answer and the view says so before the server does, and what is typed is what
 * gets submitted.
 *
 * The blank rule itself lives in `@formsache/shared` (`isBlankAnswer`) and is unit
 * tested there — the view only has to ask it. **Named because it matters for
 * reading the first test below**: it holds because of the shared rule, not
 * because of anything in this view. Take the free-text box out again and it
 * still passes; take `other: ''` out of `isBlankAnswer` and it fails, which is
 * the state that was measured (submission accepted, empty cell in the CSV).
 */

const ORG_QUESTION_ID = '019fe600-0000-7000-8000-0000000000c1';
const PAGE_ID = '019fe600-0000-7000-8000-0000000000a1';
const OTHER_LABEL =
  'Nicht Mitglied der Dachorganisation – Name der Organisation';
const FREE_TEXT_LABEL = `${OTHER_LABEL}: Freitext`;
const OTHER_TEXT = 'Schachverein Nord';
const SECOND_PAGE_ID = '019fe600-0000-7000-8000-0000000000a2';

function brandColor(digits: string): string {
  return `#${digits}`;
}

function form(): PublicForm {
  return {
    locked: false,
    title: 'Jahrestagung 2026',
    version: 1,
    tenant: {
      name: 'Dachorganisation',
      shortName: 'DACH',
      logoRef: null,
      branding: {
        accent: brandColor('cea967'),
        headerBg: brandColor('212226'),
        canvasBg: brandColor('e9e6df'),
        stripe: ['212226', '7c0800', 'cea967'].map(brandColor),
        wideLogo: true,
      },
    },
    display: {
      showProgress: true,
      showPageNumbers: true,
      showRequiredHint: true,
    },
    availability: { state: 'open', opensAt: null, closesAt: null },
    eventSeats: [],
    startToken: 's1.mfa1b2c3.RGllc0lzdEVpbmVTaWduYXR1cg',
    // The requirement — the wire field that decides whether this view offers
    // *Zwischenspeichern*. `false` here because this fill-in view has
    // not been built yet: this fixture describes the payload as it is rendered
    // today, and a `true` would claim a button nothing draws.
    canSaveDraft: false,
    // No time limit (finding 32) — the line above the fields is then silent,
    // and the cases in which it speaks stand in `deadline-notice.test.ts`.
    timeLimitMin: null,
    // No form-specific privacy notice (ADR-0028 no. 4). `null`
    // means „nichts hinterlegt", and the footer then shows nothing at this
    // place — the cases stand in `PublicLegalFooter.test.tsx`.
    privacyNotice: null,
    definition: {
      pages: [
        {
          id: PAGE_ID,
          title: 'Mitgliedschaft',
          description: null,
          questions: [
            {
              id: ORG_QUESTION_ID,
              label: 'Organisation',
              hint: null,
              required: true,
              width: 'full',
              type: 'select',
              options: [
                { value: 'nord', label: 'Nord' },
                { value: 'sued', label: 'Süd' },
              ],
              allowOther: true,
              otherLabel: OTHER_LABEL,
            },
          ],
        },
      ],
    },
  };
}

/**
 * The same form over two pages, with nothing required — for the one honeypot
 * case that needs a „Weiter" between the decoy being filled and the button
 * being pressed.
 */
function twoPageForm(): PublicForm {
  const base = form();
  return {
    ...base,
    definition: {
      pages: [
        {
          id: PAGE_ID,
          title: 'Person',
          description: null,
          questions: [
            {
              id: SECOND_PAGE_ID,
              label: 'Vorname',
              hint: null,
              required: false,
              width: 'full',
              type: 'text',
              minLength: null,
              maxLength: null,
              pattern: null,
            },
          ],
        },
        {
          id: SECOND_PAGE_ID,
          title: 'Anmerkungen',
          description: null,
          questions: [],
        },
      ],
    },
  };
}

function controller(mutate: SubmitController['mutate']): SubmitController {
  return { isPending: false, isError: false, error: undefined, mutate };
}

function submitSpy() {
  const submissions: PublicSubmission[] = [];
  const mutate: SubmitController['mutate'] = (given, options) => {
    submissions.push(given);
    options.onSuccess({
      confirmationTitle: 'Vielen Dank!',
      confirmationMessage: 'Gespeichert.',
      redirect: null,
      editUrl: null,
    } satisfies SubmitResponseResponse);
  };
  return { submissions, spy: vi.fn(mutate) };
}

function chooseOther(): void {
  const option = screen
    .getAllByRole('option')
    .find((entry) => entry.textContent === OTHER_LABEL);
  if (!(option instanceof HTMLOptionElement)) {
    throw new Error('Der „Sonstiges"-Eintrag fehlt im Dropdown.');
  }
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: option.value },
  });
}

describe('FillIn – required dropdown with „Sonstiges"', () => {
  it('refuses to submit while the free-text box is empty, and says why', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={form()} submit={controller(spy)} />);

    chooseOther();
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(spy).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toBe('Pflichtfeld.');
  });

  it('submits the typed Organisation as the free text of the answer', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={form()} submit={controller(spy)} />);

    chooseOther();
    fireEvent.change(screen.getByLabelText(FREE_TEXT_LABEL), {
      target: { value: OTHER_TEXT },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(submissions.map((given) => given.answers)).toEqual([
      { [ORG_QUESTION_ID]: { values: [], other: OTHER_TEXT } },
    ]);
  });

  it('submits the picked option and no leftover text after a switch back', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={form()} submit={controller(spy)} />);

    chooseOther();
    fireEvent.change(screen.getByLabelText(FREE_TEXT_LABEL), {
      target: { value: OTHER_TEXT },
    });
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'sued' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(submissions.map((given) => given.answers)).toEqual([
      { [ORG_QUESTION_ID]: { values: ['sued'], other: null } },
    ]);
  });
});

/**
 * The requirement — the decoy travels, and it travels **beside** the answers.
 *
 * The field itself is tested in `HoneypotField.test.tsx`; what is only visible
 * here is the wiring, and the wiring is where this measure silently switches
 * itself off: a field that is rendered and then dropped on the way to the
 * server looks exactly like a field that works.
 */
describe('FillIn – der Honeypot', () => {
  function fillTheTenant(): void {
    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'sued' },
    });
  }

  it('sends the field empty for an ordinary participant', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={form()} submit={controller(spy)} />);

    fillTheTenant();
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    // Empty rather than absent: a request whose *shape* depends on what the
    // participant did is a request a bot can be told apart from.
    expect(submissions.map((given) => given.honeypot)).toEqual(['']);
  });

  it('sends what was written into it, without touching the answers', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={form()} submit={controller(spy)} />);

    fillTheTenant();
    fireEvent.change(screen.getByTestId(HONEYPOT_TEST_ID), {
      target: { value: 'https://spam.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(submissions).toEqual([
      {
        answers: { [ORG_QUESTION_ID]: { values: ['sued'], other: null } },
        honeypot: 'https://spam.example',
      },
    ]);
  });

  /**
   * The one that would otherwise be found by a participant rather than by a
   * test: an automated filler writes into every field it finds and then walks
   * through the pages. A decoy that lived inside the current page would be
   * remounted — and empty — by the time the button is pressed.
   */
  it('keeps the value across a page change', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={twoPageForm()} submit={controller(spy)} />);

    fireEvent.change(screen.getByTestId(HONEYPOT_TEST_ID), {
      target: { value: 'bot' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(submissions.map((given) => given.honeypot)).toEqual(['bot']);
  });

  /**
   * The decoy is not an answer, and this is the assertion that says so where a
   * reader will look for it. Its value has no question behind it, so a copy of
   * it inside `answers` would be stored in the response JSONB as a column
   * nobody asked for — see `submitResponseRequestSchema`.
   */
  it('never appears among the answers', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={form()} submit={controller(spy)} />);

    fillTheTenant();
    fireEvent.change(screen.getByTestId(HONEYPOT_TEST_ID), {
      target: { value: 'bot' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    const [given] = submissions;
    expect(Object.keys(given?.answers ?? {})).toEqual([ORG_QUESTION_ID]);
  });
});

/**
 * A review finding: a partially filled Pflicht-Adresse used to show a
 * single bare „Pflichtfeld." under all four boxes, naming none of them —
 * `addressAnswerSchema` (`response-validation.ts`) raises one issue per empty
 * Teilfeld, and the client kept only the first.
 */
describe('FillIn – teilbefüllte Pflicht-Adresse', () => {
  const ADDRESS_ID = '019fe600-0000-7000-8000-0000000000a3';

  function addressForm(): PublicForm {
    const base = form();
    return {
      ...base,
      definition: {
        pages: [
          {
            id: PAGE_ID,
            title: 'Anschrift',
            description: null,
            questions: [
              {
                id: ADDRESS_ID,
                label: 'Anschrift',
                hint: null,
                required: true,
                width: 'full',
                type: 'address',
              },
            ],
          },
        ],
      },
    };
  }

  it('names every missing Teilfeld instead of a single bare „Pflichtfeld."', () => {
    render(<FillIn form={addressForm()} submit={controller(vi.fn())} />);

    // Only Straße is filled — PLZ and Ort stay empty, Land is never Pflicht.
    fireEvent.change(screen.getByLabelText('Straße & Hausnummer'), {
      target: { value: 'Musterstraße 12' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    const message = screen.getByRole('alert').textContent;
    expect(message).toContain('PLZ: Pflichtfeld.');
    expect(message).toContain('Ort: Pflichtfeld.');
    expect(message).not.toContain('Straße');
    expect(message).not.toContain('Land');
  });
});

/* --- A full Veranstaltung while filling in --------------------- */

const EVENT_ID = '019fe600-0000-7000-8000-0000000000e1';

/**
 * The seat states a refusal actually happens against.
 *
 * **Not `full: true` for the Veranstaltung the server refuses on.** The server
 * turns a submission down as soon as `belegt + gewünscht > Grenze`
 * (`PublicFormsService`), so the ordinary refusal is a hall with two seats left
 * and an organisation asking for five — and „ausgebucht" beside a green „2 frei" is the
 * contradiction finding 2 is about. The old fixture combined `full: true` with
 * „this is the refused position", a pair that also made the box `disabled`: the
 * mark was asserted on a field nobody could touch, and clearing it had to be
 * demonstrated on a *different* Veranstaltung because this one was frozen.
 */
function openSeats(): PublicForm['eventSeats'] {
  return [
    { questionId: EVENT_ID, eventKey: 'stadtfest', full: false, remaining: 2 },
    {
      questionId: EVENT_ID,
      eventKey: 'sommerfest',
      full: false,
      remaining: 7,
    },
  ];
}

/** Two pages; the Veranstaltungsfrage is on the **second** one. */
function eventForm(seats: PublicForm['eventSeats'] = openSeats()): PublicForm {
  const base = form();
  return {
    ...base,
    eventSeats: seats,
    definition: {
      pages: [
        {
          id: PAGE_ID,
          title: 'Person',
          description: null,
          questions: [
            {
              id: SECOND_PAGE_ID,
              label: 'Vorname',
              hint: null,
              required: false,
              width: 'full',
              type: 'text',
              minLength: null,
              maxLength: null,
              pattern: null,
            },
          ],
        },
        {
          id: SECOND_PAGE_ID,
          title: 'Veranstaltungsanmeldung',
          description: null,
          questions: [
            {
              id: EVENT_ID,
              label: 'Veranstaltungen',
              hint: null,
              required: false,
              width: 'full',
              type: 'event',
              events: [
                {
                  key: 'sommerfest',
                  label: 'Sommerfest',
                  when: 'Fr, 19:00',
                  capacity: 120,
                  showRemaining: true,
                },
                {
                  key: 'stadtfest',
                  label: 'Stadtfest',
                  when: 'Sa, 20:00',
                  capacity: 80,
                  // On, so a payload carrying `remaining` for this entry is one
                  // the server would really send: the figure travels only where
                  // the editor allowed it. Which figures may
                  // be withheld is asserted in `FieldInput.test.tsx`.
                  showRemaining: true,
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** A controller whose `mutate` always fails with the given error. */
function refusing(error: unknown): SubmitController {
  return {
    isPending: false,
    isError: true,
    error,
    mutate: (_given, options) => {
      options.onError(error);
    },
  };
}

/**
 * **The full Veranstaltung, when it only becomes full on submission** .
 *
 * The seat states of the payload are rendered by `FieldInput` and asserted
 * there. What only this component can be asked is the other half: what happens
 * to the *page* when the server refuses one position — which is a question
 * about paging, about the banner and about where the mark goes, and every one
 * of those used to be answered by „bitte die Seite neu laden", which throws
 * away everything typed.
 */
describe('FillIn – eine volle Veranstaltung', () => {
  const refusal = new ApiError(409, 'Ausgebucht.', undefined, {
    message: 'Diese Veranstaltung ist ausgebucht.',
    reason: 'event_full',
    position: { questionId: EVENT_ID, eventKey: 'stadtfest' },
  });

  it('renders the payload’s seat state on the field', () => {
    render(
      <FillIn
        form={eventForm([
          { questionId: EVENT_ID, eventKey: 'stadtfest', full: true },
          {
            questionId: EVENT_ID,
            eventKey: 'sommerfest',
            full: false,
            remaining: 7,
          },
        ])}
        submit={controller(vi.fn())}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));

    expect(screen.getByText('Ausgebucht')).toBeDefined();
    expect(screen.getByText('7 frei')).toBeDefined();
  });

  /**
   * The participant is standing on the **last** page when the server answers,
   * and the question may be three pages back. Marking a field nobody can see
   * is a message that exists and is useless.
   */
  it('takes the participant to the page the refused Veranstaltung is on', () => {
    render(<FillIn form={eventForm()} submit={refusing(refusal)} />);

    // Page one, where the Veranstaltung is not.
    expect(screen.queryByText('Stadtfest')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(screen.getByText('Stadtfest')).toBeDefined();
  });

  it('names the Veranstaltung and marks its box, not the whole question', () => {
    render(<FillIn form={eventForm()} submit={refusing(refusal)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    // The caption comes from the definition in front of the participant — the
    // wire carries the **key**, and the server’s own sentence names nothing.
    expect(
      screen.getAllByRole('alert').map((entry) => entry.textContent),
    ).toContain(
      '„Stadtfest“: nicht mehr genügend Plätze frei. Bitte die Anzahl verringern; die übrigen Eingaben bleiben erhalten.',
    );
    expect(
      screen
        .getByLabelText('Stadtfest: Anzahl Personen')
        .getAttribute('aria-invalid'),
    ).toBe('true');
    expect(
      screen
        .getByLabelText('Sommerfest: Anzahl Personen')
        .getAttribute('aria-invalid'),
    ).toBe('false');
  });

  /**
   * The generic 409 banner says „bitte die Seite neu laden; dort steht, woran
   * es liegt". Both halves are wrong here: reloading throws away every answer,
   * and the reloaded page says nothing — the form is open, one Veranstaltung is
   * not.
   */
  it('does not tell the participant to reload the page', () => {
    render(<FillIn form={eventForm()} submit={refusing(refusal)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    const banners = screen
      .getAllByRole('alert')
      .map((entry) => entry.textContent)
      .join(' ');
    expect(banners).not.toContain('neu laden');
    expect(banners).toContain('nicht mehr genügend Plätze frei');
  });

  /**
   * **What the message has to say — and what the tile beside it says.**
   *
   * The realistic state after a refusal, and the one nothing used to cover: the
   * payload still reports free seats, because there *are* free seats — just not
   * five of them. „Ist inzwischen ausgebucht" over a tile reading „2 frei" is
   * two statements about the same Veranstaltung on the same screen, one of them
   * false, and neither of them says the only thing that helps.
   */
  it('says the seats are not enough rather than calling the Veranstaltung full', () => {
    render(<FillIn form={eventForm()} submit={refusing(refusal)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.change(screen.getByLabelText('Stadtfest: Anzahl Personen'), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    const said = screen
      .getAllByRole('alert')
      .map((entry) => entry.textContent)
      .join(' ');
    // The one thing a participant can act on.
    expect(said).toContain('verringern');
    // …and never the claim the badge contradicts.
    expect(said.toLowerCase()).not.toContain('ausgebucht');
    expect(screen.getByText('2 frei')).toBeDefined();
    // The box keeps what was typed — it is the number that has to come down.
    expect(
      screen.getByLabelText<HTMLInputElement>('Stadtfest: Anzahl Personen')
        .value,
    ).toBe('5');
  });

  /**
   * The mark goes with the first keystroke in the question it sits in — and the
   * box touched here is deliberately a **different** Veranstaltung than the
   * refused one: „diese Frage wird gerade korrigiert" is the rule, not „genau
   * dieser Kasten".
   */
  it('clears the mark as soon as the number is changed', () => {
    render(<FillIn form={eventForm()} submit={refusing(refusal)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    fireEvent.change(screen.getByLabelText('Sommerfest: Anzahl Personen'), {
      target: { value: '2' },
    });
    expect(
      screen
        .getByLabelText('Stadtfest: Anzahl Personen')
        .getAttribute('aria-invalid'),
    ).toBe('false');
  });
});

/* --- Conditional display in the fill-in view -------------------- */

const CONDITION_SOURCE_ID = '019fe600-0000-7000-8000-0000000000d1';
const CONDITION_DEPENDENT_ID = '019fe600-0000-7000-8000-0000000000d2';

/**
 * One radio source and one Pflichtfrage that only shows once „Ja" is picked —
 * the same shape that example (§ handoff „Bedingte Anzeige") uses, kept
 * to a single page so `validatePage` is the only thing under test.
 */
function conditionalForm(): PublicForm {
  const base = form();
  return {
    ...base,
    definition: {
      pages: [
        {
          id: PAGE_ID,
          title: 'Anreise',
          description: null,
          questions: [
            {
              id: CONDITION_SOURCE_ID,
              label: 'Reist du mit dem Auto an?',
              hint: null,
              required: false,
              width: 'full',
              type: 'radio',
              options: [
                { value: 'ja', label: 'Ja' },
                { value: 'nein', label: 'Nein' },
              ],
              allowOther: false,
              otherLabel: null,
            },
            {
              id: CONDITION_DEPENDENT_ID,
              label: 'Kennzeichen',
              hint: null,
              required: true,
              width: 'full',
              type: 'text',
              minLength: null,
              maxLength: null,
              pattern: null,
              visibleIf: {
                questionId: CONDITION_SOURCE_ID,
                operator: 'equals',
                value: 'ja',
              },
            },
          ],
        },
      ],
    },
  };
}

/**
 * `visibleQuestionIds` in render **and** `validatePage` — the fall the
 * task names in as many words: without the second half, a hidden Pflichtfrage
 * blocks „Absenden" even though the server would have let the same submission
 * through.
 */
describe('FillIn – bedingte Anzeige', () => {
  it('hides the dependent question while its condition does not hold, and does not block Absenden on its Pflicht', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={conditionalForm()} submit={controller(spy)} />);

    expect(screen.queryByLabelText(/^Kennzeichen/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(spy).toHaveBeenCalledTimes(1);
    // Untouched, not merely blank: the source radio was never clicked, so
    // `answers` carries no key for it at all — and the server drops one for
    // the still-hidden Kennzeichen just the same.
    expect(submissions.map((given) => given.answers)).toEqual([{}]);
  });

  it('shows the dependent question once the source answer satisfies the condition, and enforces its Pflicht', () => {
    const { submissions, spy } = submitSpy();
    render(<FillIn form={conditionalForm()} submit={controller(spy)} />);

    fireEvent.click(screen.getByLabelText('Ja'));
    expect(screen.getByLabelText(/^Kennzeichen/)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Pflichtfeld.');

    fireEvent.change(screen.getByLabelText(/^Kennzeichen/), {
      target: { value: 'Dachorganisation-42' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));

    expect(submissions.map((given) => given.answers)).toEqual([
      {
        [CONDITION_SOURCE_ID]: { values: ['ja'], other: null },
        [CONDITION_DEPENDENT_ID]: 'Dachorganisation-42',
      },
    ]);
  });

  it('hides the question again when the source answer changes back, without blocking the submit', () => {
    const { spy } = submitSpy();
    render(<FillIn form={conditionalForm()} submit={controller(spy)} />);

    fireEvent.click(screen.getByLabelText('Ja'));
    fireEvent.change(screen.getByLabelText(/^Kennzeichen/), {
      target: { value: 'Dachorganisation-42' },
    });
    fireEvent.click(screen.getByLabelText('Nein'));

    expect(screen.queryByLabelText(/^Kennzeichen/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Absenden' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/**
 * Finding 32 — the deadline stands above the form as soon as the server names one.
 *
 * The wording and the clock are checked next door (`deadline-notice.test.ts`,
 * `FormDeadline.test.tsx`); what is visible **only here** is the wiring,
 * and that is exactly what was missing: `FillIn` read `availability` in not a single
 * place, although all three public payloads carry the verdict.
 */
describe('FillIn – die Frist', () => {
  it('says nothing above a form the server gave no deadline for', () => {
    const { spy } = submitSpy();
    render(<FillIn form={form()} submit={controller(spy)} />);

    expect(screen.queryByTestId('public-deadline')).toBeNull();
  });

  it('names the deadline the server sent for an open form', () => {
    const { spy } = submitSpy();
    render(
      <FillIn
        form={{
          ...form(),
          availability: {
            state: 'open',
            opensAt: null,
            closesAt: '2026-12-15T17:00:00.000Z',
          },
        }}
        submit={controller(spy)}
      />,
    );

    expect(screen.getByTestId('public-deadline').textContent).toBe(
      'Dieses Formular kann noch bis 15.12.2026, 18:00 Uhr MEZ ausgefüllt und abgesendet werden.',
    );
  });

  /**
   * **Above the fields, not below them.** „Wogegen arbeite ich" is the
   * piece of information needed before the typing; behind thirty fields it would be
   * present and unread — the state the finding describes.
   */
  it('puts the deadline above the first field', () => {
    const { spy } = submitSpy();
    render(
      <FillIn
        form={{
          ...form(),
          availability: {
            state: 'open',
            opensAt: null,
            closesAt: '2026-12-15T17:00:00.000Z',
          },
        }}
        submit={controller(spy)}
      />,
    );

    const line = screen.getByTestId('public-deadline');
    const firstField = screen.getAllByTestId('public-row')[0];
    expect(firstField).toBeDefined();
    // `compareDocumentPosition` answers as a bit mask; `FOLLOWING` means „das
    // Feld steht *hinter* der Zeile" — that is, the line above it.
    expect(
      line.compareDocumentPosition(firstField as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /**
   * **The second half of the finding: the time limit.** Here too only the
   * wiring is new — `FillIn` passed `timeLimitMin` on nowhere,
   * because the number did not stand on the public wire in the first place. A
   * form without a deadline is the case that proves it: before, nothing stood
   * above it, and the participant learned their minutes at the 409.
   */
  it('names the time limit the server sent, even without a deadline', () => {
    const { spy } = submitSpy();
    render(
      <FillIn
        form={{ ...form(), timeLimitMin: 30 }}
        submit={controller(spy)}
      />,
    );

    expect(screen.getByTestId('public-deadline').textContent).toBe(
      'Für das Ausfüllen stehen ab dem Öffnen dieser Seite 30 Minuten zur Verfügung.',
    );
  });

  /**
   * Both limits in **one** line: it is a single piece of information — „wie lange
   * habe ich" —, and two paragraphs stacked would be the same
   * interruption twice above the fields.
   */
  it('puts deadline and time limit in the same line', () => {
    const { spy } = submitSpy();
    render(
      <FillIn
        form={{
          ...form(),
          availability: {
            state: 'open',
            opensAt: null,
            closesAt: '2026-12-15T17:00:00.000Z',
          },
          timeLimitMin: 30,
        }}
        submit={controller(spy)}
      />,
    );

    expect(screen.getAllByTestId('public-deadline')).toHaveLength(1);
    expect(screen.getByTestId('public-deadline').textContent).toBe(
      'Dieses Formular kann noch bis 15.12.2026, 18:00 Uhr MEZ ausgefüllt und abgesendet werden. ' +
        'Für das Ausfüllen stehen ab dem Öffnen dieser Seite 30 Minuten zur Verfügung.',
    );
  });

  /**
   * Finding 32, second part — the refusal on account of a full Veranstaltung names
   * the **Antwort**, not „die Anmeldung": the subject is the submission, and
   * the twin sentence for the remaining 409s has always said „Antwort".
   */
  it('calls a refused submission an answer, not a registration', () => {
    const refused = new ApiError(409, 'Ausgebucht.', undefined, {
      message: 'Diese Veranstaltung ist ausgebucht.',
      reason: 'event_full',
    });

    render(
      <FillIn
        form={form()}
        submit={{
          isPending: false,
          isError: true,
          error: refused,
          mutate: vi.fn(),
        }}
      />,
    );

    const banner = screen
      .getAllByRole('alert')
      .map((node) => node.textContent)
      .join(' ');
    expect(banner).toContain('Diese Antwort wurde nicht angenommen');
    expect(banner).not.toMatch(/Anmeld/i);
  });
});

import { describe, expect, it } from 'vitest';

import {
  availabilityOf,
  availabilityStateSchema,
  publicAvailability,
} from './form-availability.ts';
import {
  PASSWORD_MAX,
  REDACTED_PASSWORD,
  REDIRECT_DELAY_MAX,
  SYSTEM_FORM_SETTINGS,
  type FormSettings,
} from './form-settings.ts';
import {
  accessRequestSchema,
  confirmationOf,
  lockedPublicFormSchema,
  parseAccessGrant,
  parsePublicFormResponse,
  parseSubmitResponse,
  publicAvailabilitySchema,
  publicFormSchema,
  readSubmissionRefusal,
  submissionRefusalReasonSchema,
  submitResponseRequestSchema,
} from './public-form.ts';

/**
 * The wire contract of the public fill-in endpoints.
 *
 * **This file exists because of a defect that was reported.** The server
 * has sent `display` and `availability` since then; the schema here did not carry
 * them, Zod dropped what it did not know, and every *Darstellung* setting an
 * editor made travelled across the wire and was thrown away in the browser. The
 * settings were saved correctly the whole time — they simply never arrived.
 */

const QUESTION = '019ff200-0000-7000-8000-000000000001';
const PAGE = '019ff200-0000-7000-8000-0000000000a1';

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    title: 'Jahrestagung 2026',
    version: 3,
    tenant: {
      name: 'Dachorganisation',
      shortName: 'DACH',
      logoRef: null,
      branding: {
        accent: '#cea967',
        headerBg: '#212226',
        canvasBg: '#e9e6df',
        stripe: ['#212226', '#7c0800', '#cea967'],
        wideLogo: true,
      },
    },
    definition: {
      pages: [
        {
          id: PAGE,
          title: 'Person',
          questions: [
            {
              id: QUESTION,
              type: 'text',
              label: 'Name',
              hint: null,
              required: true,
              width: 'full',
              minLength: null,
              maxLength: null,
              pattern: null,
            },
          ],
        },
      ],
    },
    display: {
      showProgress: false,
      showPageNumbers: true,
      showRequiredHint: false,
    },
    availability: {
      state: 'closed',
      opensAt: null,
      closesAt: '2026-08-15T21:59:00.000Z',
    },
    // „ausgebucht" for every bounded Veranstaltung, and the
    // figure only where the editor switched it on. Present even when the
    // form has none, so its presence cannot say that it has.
    eventSeats: [],
    // Opaque here on purpose; the server owns its inside.
    startToken: 's1.mfa1b2c3.Zm9vYmFyc2lnbmF0dXJl',
    // The discriminator. `false` is „you are past the gate, or
    // there was none"; the locked branch has its own payload below.
    locked: false,
    // „bietet diese Ansicht Zwischenspeichern an". A verdict
    // about the view, not a copy of the setting: the same payload reads `false`
    // on the edit route of a submitted answer.
    canSaveDraft: true,
    // The minutes per fill-in (finding 32) — `null` means „kein Zeitlimit",
    // and the server never sends the stored number of a switched-off one.
    timeLimitMin: 30,
    // The privacy notice of this form (ADR-0028 no. 4) — `null` means
    // "nothing stored", and the view then shows nothing at this place.
    privacyNotice: null,
    ...overrides,
  };
}

describe('publicFormSchema', () => {
  it('carries the display flags through the parse instead of dropping them', () => {
    const parsed = publicFormSchema.parse(payload());

    expect(parsed.display).toStrictEqual({
      showProgress: false,
      showPageNumbers: true,
      showRequiredHint: false,
    });
  });

  it('carries the availability verdict through the parse', () => {
    expect(publicFormSchema.parse(payload()).availability).toStrictEqual({
      state: 'closed',
      opensAt: null,
      closesAt: '2026-08-15T21:59:00.000Z',
    });
  });

  /**
   * The other direction, and the one that keeps the two sides honest: a server
   * that stopped sending the flags used to be invisible here — the client would
   * simply have rendered whatever its own defaults were. It is a refusal now.
   */
  it.each(['display', 'availability', 'startToken', 'eventSeats'])(
    'refuses a payload without %s',
    (key) => {
      // Rebuilt without the key rather than deleted out of the object: same
      // result, and it expresses „an older server answered" without reaching
      // for a dynamic `delete`.
      const without = Object.fromEntries(
        Object.entries(payload() as Record<string, unknown>).filter(
          ([name]) => name !== key,
        ),
      );

      expect(() => publicFormSchema.parse(without)).toThrow();
    },
  );

  it('refuses a display section missing one of the three flags', () => {
    expect(() =>
      publicFormSchema.parse(
        payload({ display: { showProgress: true, showPageNumbers: true } }),
      ),
    ).toThrow();
  });

  /**
   * The wire half: the figure is an **absent key** where the
   * switch is off, so the entry has to parse without it — and a `remaining`
   * that arrived as something other than a whole number must not reach a badge.
   */
  it('accepts a seat state without the figure and refuses a broken one', () => {
    const parsed = publicFormSchema.parse(
      payload({
        eventSeats: [
          { questionId: QUESTION, eventKey: 'stadtfest', full: true },
          {
            questionId: QUESTION,
            eventKey: 'sommerfest',
            full: false,
            remaining: 7,
          },
        ],
      }),
    );
    expect(parsed.eventSeats[0]).not.toHaveProperty('remaining');
    expect(parsed.eventSeats[1]?.remaining).toBe(7);

    expect(() =>
      publicFormSchema.parse(
        payload({
          eventSeats: [
            { questionId: QUESTION, eventKey: 'stadtfest', full: 'ja' },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      publicFormSchema.parse(
        payload({
          eventSeats: [
            {
              questionId: QUESTION,
              eventKey: 'stadtfest',
              full: false,
              remaining: -1,
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it('refuses a verdict state this version does not know', () => {
    expect(() =>
      publicFormSchema.parse(
        payload({
          availability: { state: 'vielleicht', opensAt: null, closesAt: null },
        }),
      ),
    ).toThrow();
  });
});

/**
 * The schema and the projection `publicAvailability()` performs have to agree.
 *
 * `satisfies z.ZodType<PublicAvailability>` in the source catches a *type*
 * mismatch; this catches the other half — that the three key names the schema
 * accepts are the three the projection actually produces.
 */
describe('publicAvailabilitySchema mirrors publicAvailability()', () => {
  it('accepts the verdict a server produces, key for key', () => {
    const verdict = publicAvailability(
      availabilityOf({
        settings: {
          ...SYSTEM_FORM_SETTINGS,
          openEnabled: true,
          closeAt: '2026-08-15T21:59:00.000Z',
        },
        now: new Date('2026-09-01T00:00:00.000Z'),
        responseCount: null,
      }),
    );

    expect(Object.keys(verdict).sort()).toStrictEqual([
      'closesAt',
      'opensAt',
      'state',
    ]);
    expect(publicAvailabilitySchema.parse(verdict)).toStrictEqual(verdict);
  });
});

describe('confirmationOf', () => {
  const settings = (patch: Partial<FormSettings>): FormSettings => ({
    ...SYSTEM_FORM_SETTINGS,
    ...patch,
  });

  const EDIT_URL = 'https://formulare.example.org/a/QUJDREVGR0hJSktMTU5PUA';

  it('answers with the configured texts rather than the built-in constants', () => {
    expect(
      confirmationOf(
        settings({
          confirmTitle: 'Danke, Mitglied',
          confirmMsg: 'Die Anmeldung ist eingegangen.',
        }),
        null,
      ),
    ).toStrictEqual({
      confirmationTitle: 'Danke, Mitglied',
      confirmationMessage: 'Die Anmeldung ist eingegangen.',
      redirect: null,
      editUrl: null,
    });
  });

  it('carries the redirect when one is configured', () => {
    expect(
      confirmationOf(
        settings({
          redirectEnabled: true,
          redirectUrl: 'https://beispielverein.de/',
          redirectDelay: 8,
        }),
        null,
      ).redirect,
    ).toStrictEqual({
      url: 'https://beispielverein.de/',
      delaySec: 8,
    });
  });

  /** The delivery gate, seen from the one function that assembles the answer. */
  it('carries no redirect for a target a browser must not be sent to', () => {
    expect(
      confirmationOf(
        settings({
          redirectEnabled: true,
          redirectUrl: 'javascript:alert(1)',
        }),
        null,
      ).redirect,
    ).toBeNull();
  });

  /**
   * **The setting is applied here, in the one place the
   * confirmation is assembled.**
   *
   * A caller that hands over a link for a form with editing switched off still
   * gets `null`, so the switch cannot be forgotten at a call site. It is not
   * the enforcement (the edit route re-reads the setting on every access); it
   * is what keeps the *offer* honest.
   */
  it('withholds the edit link when „Bearbeiten nach Absenden" is off', () => {
    expect(
      confirmationOf(settings({ allowEdit: false }), EDIT_URL).editUrl,
    ).toBeNull();
  });

  it('carries the edit link when the setting allows it', () => {
    expect(
      confirmationOf(settings({ allowEdit: true }), EDIT_URL).editUrl,
    ).toBe(EDIT_URL);
  });

  /**
   * „Erlaubt" alone is not a link. A caller that has none — there is no such
   * caller today, and there will be one the moment somebody assembles a
   * confirmation without a stored answer — must not turn the flag into a
   * promise.
   */
  it('stays null when the setting allows editing but no link was given', () => {
    expect(
      confirmationOf(settings({ allowEdit: true }), null).editUrl,
    ).toBeNull();
  });
});

/**
 * The client's own reading of the answer.
 *
 * The third gate, and the only one on the browser's side of the wire: the
 * client cannot know which version of the server answered it, and the redirect
 * is the one member of the payload it *acts on* rather than displays.
 */
describe('parseSubmitResponse', () => {
  it('keeps a target it may follow', () => {
    expect(
      parseSubmitResponse({
        confirmationTitle: 'Vielen Dank!',
        confirmationMessage: 'Gespeichert.',
        redirect: { url: 'https://beispielverein.de/', delaySec: 5 },
      }).redirect,
    ).toStrictEqual({
      url: 'https://beispielverein.de/',
      delaySec: 5,
    });
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
  ])('drops a %s target without losing the confirmation', (url) => {
    const parsed = parseSubmitResponse({
      confirmationTitle: 'Vielen Dank!',
      confirmationMessage: 'Gespeichert.',
      redirect: { url, delaySec: 0 },
    });

    expect(parsed.redirect).toBeNull();
    // The answer is stored at this point. Losing the receipt over a target the
    // browser will not follow would be the more expensive failure.
    expect(parsed.confirmationTitle).toBe('Vielen Dank!');
    expect(parsed.confirmationMessage).toBe('Gespeichert.');
  });

  /**
   * **The delay is bounded on the wire, with the same constant the settings
   * are bounded with.**
   *
   * `REDIRECT_DELAY_MAX` held only when a settings *document* was saved, and a
   * bound checked at one end of a wire is not a bound: `delaySec: 86_400`
   * parsed cleanly and the confirmation page counted down for a day, receipt on
   * screen, participant waiting for a redirect nobody configured. Dropping the
   * redirect rather than the answer, as for a target that cannot be followed —
   * the response is stored at this point.
   */
  it.each([
    ['the maximum itself', REDIRECT_DELAY_MAX, true],
    ['one second past it', REDIRECT_DELAY_MAX + 1, false],
    ['a whole day', 86_400, false],
  ])('handles a delay of %s', (_name, delaySec, kept) => {
    const parsed = parseSubmitResponse({
      confirmationTitle: 'Vielen Dank!',
      confirmationMessage: 'Gespeichert.',
      redirect: { url: 'https://beispielverein.de/', delaySec },
    });

    expect(parsed.redirect).toStrictEqual(
      kept ? { url: 'https://beispielverein.de/', delaySec } : null,
    );
    expect(parsed.confirmationTitle).toBe('Vielen Dank!');
  });

  it('tolerates an answer from a server that predates the redirect', () => {
    expect(
      parseSubmitResponse({
        confirmationTitle: 'Vielen Dank!',
        confirmationMessage: 'Gespeichert.',
      }).redirect,
    ).toBeNull();
  });

  it('still refuses an answer without the confirmation texts', () => {
    // `.catch` covers the redirect and only the redirect: a tolerant parse of
    // the whole object would turn a broken server answer into a blank page
    // that says nothing about whether anything was stored.
    expect(() => parseSubmitResponse({ redirect: null })).toThrow();
  });
});

describe('the schema is the whole contract', () => {
  /**
   * Guard against the failure mode this file was written for, stated the other
   * way round: whatever the server sends, the client sees exactly the members
   * named here — so a member added on the server without being added here goes
   * nowhere, silently, again.
   */
  it('carries exactly the twelve documented members', () => {
    expect(Object.keys(publicFormSchema.shape).sort()).toStrictEqual([
      'availability', // See the note at the fixture above.
      'canSaveDraft',
      'definition',
      'display',
      'eventSeats',
      'locked',
      // The privacy notice of this form (ADR-0028 no. 4) — the one value of
      // this payload that was written expressly in order to be read by the
      // participating person.
      'privacyNotice',
      'startToken',
      'tenant',
      'timeLimitMin',
      'title',
      'version',
    ]);
  });
});

/**
 * The time limit on the wire (finding 32).
 *
 * It is the field that shifted the line of this contract — "public is what
 * binds the person filling in, not what the form wards off" —, and what is
 * checked here is the form in which that holds: mandatory, `null` as *the*
 * spelling for "no limit", and bounded on both sides.
 */
describe('the time limit on the wire', () => {
  it('carries the minutes through the parse', () => {
    expect(publicFormSchema.parse(payload()).timeLimitMin).toBe(30);
  });

  it('reads „kein Zeitlimit" as null', () => {
    expect(
      publicFormSchema.parse(payload({ timeLimitMin: null })).timeLimitMin,
    ).toBeNull();
  });

  /**
   * **Mandatory, not optional** — the same decision as with `formSlug` and
   * `token` further below. A key whose absence is permitted is a key a server
   * stops sending one day without anybody noticing: the line above the form
   * would then be silent, and the participant would stand before the 409 again
   * that this finding abolishes.
   */
  it('refuses a payload without the member at all', () => {
    const without = Object.fromEntries(
      Object.entries(payload() as Record<string, unknown>).filter(
        ([name]) => name !== 'timeLimitMin',
      ),
    );

    expect(() => publicFormSchema.parse(without)).toThrow();
  });

  /**
   * `0` is no second spelling for "no limit", and a negative number is nothing
   * at all: a sentinel would be a number that stops meaning what it says — the
   * same refusal `form-settings.ts` pronounces for the stored setting.
   */
  it.each([0, -5, 1.5])('refuses %s as a minute count', (value) => {
    expect(() =>
      publicFormSchema.parse(payload({ timeLimitMin: value })),
    ).toThrow();
  });

  /**
   * Bounded with **the same** constant as the setting. The client does not
   * know which server version answered — the reason
   * `publicRedirectSchema.delaySec` carries its bound twice.
   */
  it('refuses a limit longer than the settings allow', () => {
    expect(
      publicFormSchema.parse(payload({ timeLimitMin: 24 * 60 })).timeLimitMin,
    ).toBe(24 * 60);
    expect(() =>
      publicFormSchema.parse(payload({ timeLimitMin: 24 * 60 + 1 })),
    ).toThrow();
  });

  /**
   * **The locked payload does not carry it.** Whoever does not have the access
   * word fills nothing in, so no number of minutes binds them either — and a
   * locked form that grows is one into which somebody puts the questions back
   * at some point.
   */
  it('is absent from the locked branch', () => {
    expect(Object.keys(lockedPublicFormSchema.shape)).not.toContain(
      'timeLimitMin',
    );
  });
});

/**
 * The token on the wire.
 *
 * Nothing here asserts a *shape*; that is the server's (`start-token.service.ts`
 * and its integration tests). What the contract owes is that the member is
 * mandatory on the way in and optional on the way back, and that the difference
 * is deliberate rather than an oversight.
 */
describe('the start token on the wire', () => {
  it('accepts a submission without a token — the time limit decides, not the schema', () => {
    expect(
      submitResponseRequestSchema.parse({ answers: { [QUESTION]: 'Anton' } })
        .startToken,
    ).toBeUndefined();
  });

  it('carries a token back when one was sent', () => {
    expect(
      submitResponseRequestSchema.parse({
        answers: {},
        startToken: 's1.mfa1b2c3.Zm9vYmFy',
      }).startToken,
    ).toBe('s1.mfa1b2c3.Zm9vYmFy');
  });

  it('refuses an empty token rather than treating it as absent', () => {
    // „kein Token" and „ein leeres Token" are different statements, and only
    // one of them is what a browser sends by accident.
    expect(() =>
      submitResponseRequestSchema.parse({ answers: {}, startToken: '' }),
    ).toThrow();
  });

  it('refuses a token far longer than one this server mints', () => {
    expect(() =>
      submitResponseRequestSchema.parse({
        answers: {},
        startToken: 'x'.repeat(1_000),
      }),
    ).toThrow();
  });
});

/**
 * The decoy field on the wire.
 *
 * Three promises, and all three are about what this field must **not** do. It
 * must not refuse a submission, whatever arrives in it. It must not travel
 * inside `answers`, where it would be stored as a value nobody asked a question
 * for. And it must not quietly become a fourth member of the request that
 * nobody decided on — the allow list, stated for the way in.
 *
 * The *rule* („was heißt ausgefüllt?") is not here: it is the server's, in
 * `apps/api/src/public/honeypot.ts`, and it is unit tested there.
 */
describe('the honeypot on the wire', () => {
  it('accepts a submission without the field at all', () => {
    expect(
      submitResponseRequestSchema.parse({ answers: { [QUESTION]: 'Anton' } })
        .honeypot,
    ).toBeUndefined();
  });

  it('carries the offered value through untouched', () => {
    expect(
      submitResponseRequestSchema.parse({ answers: {}, honeypot: 'gefüllt' })
        .honeypot,
    ).toBe('gefüllt');
    // The empty string is what the shipped client sends for every ordinary
    // submission — it has to survive the parse as itself.
    expect(
      submitResponseRequestSchema.parse({ answers: {}, honeypot: '' }).honeypot,
    ).toBe('');
  });

  /**
   * The one that matters. A refusal here would lose a registration over a field
   * that exists only to be ignored — and it would hand a bot a way to be told
   * apart from a browser.
   */
  it.each([
    ['null', null],
    ['a number', 123],
    ['an object', { a: 1 }],
    ['an array', ['a']],
    ['a boolean', true],
  ])(
    'reads %s as „nicht angeboten" instead of refusing the submission',
    (_name, honeypot) => {
      const parsed = submitResponseRequestSchema.parse({
        answers: { [QUESTION]: 'Anton' },
        honeypot,
      });
      expect(parsed.honeypot).toBeNull();
      // …and the answers arrive intact, which is the whole point of the field
      // not being allowed to fail.
      expect(parsed.answers).toStrictEqual({ [QUESTION]: 'Anton' });
    },
  );

  it('accepts a value far longer than anything a bot would need', () => {
    // Deliberately unbounded: a `max()` would turn „viel Text" into „nicht
    // ausgefüllt" and reward sending more. The 100 KiB body limit is the bound.
    const long = 'x'.repeat(10_000);
    expect(
      submitResponseRequestSchema.parse({ answers: {}, honeypot: long })
        .honeypot,
    ).toBe(long);
  });

  it('never becomes an answer — the field sits beside `answers`', () => {
    const parsed = submitResponseRequestSchema.parse({
      answers: { [QUESTION]: 'Anton' },
      honeypot: 'https://spam.example',
    });
    expect(Object.keys(parsed.answers)).toStrictEqual([QUESTION]);
  });

  it('carries exactly the four documented members on the way in', () => {
    // The allow list, stated for the request: a member added here
    // without a reason written next to it fails this line first. `draftToken`
    // is the fourth — the draft a submission comes out of.
    expect(Object.keys(submitResponseRequestSchema.shape).sort()).toStrictEqual(
      ['answers', 'draftToken', 'honeypot', 'startToken'],
    );
  });
});

/**
 * The refusal body.
 *
 * The reasons are read by the client and written by the API; a private list on
 * either side is how „geschlossen" comes to mean two things.
 */
describe('submissionRefusalSchema', () => {
  it('names the twelve reasons a submission, an edit or a draft is refused for', () => {
    expect([...submissionRefusalReasonSchema.options].sort()).toStrictEqual([
      // The two of the attachments (ADR-0014 no. 13).
      // `attachment_limit` is the two per-answer numbers of no. 6 — ten files
      // and 25 MiB — which cannot be judged before an answer exists;
      // `attachment_unavailable` is the **one** answer for all five conditions
      // of the claim (expired, already claimed, another organisation's, another form's,
      // a logo), because telling them apart would be five oracles about rows
      // the caller may not know exist.
      'attachment_limit',
      'attachment_unavailable',
      'closed',
      // A review finding: the second submission of the same draft token. The
      // draft itself is the idempotency key — „erzeugt **eine** Antwort" is a
      // promise about the address, not about the click.
      'draft_already_submitted',
      // A further review finding: the quantity limit of the drafts per form,
      // beside the rate limit, which only limited the speed.
      'draft_limit',
      // The only one that belongs to the edit route alone.
      // Listed here rather than in an enum of its own so that the two routes
      // cannot grow two different sentences for the same 409.
      'editing_disabled',
      // The one reason that is about a **position** rather
      // than about the form: one Veranstaltung is full, the rest of the
      // registration is still acceptable, and `position` says which.
      'event_full',
      'limit_reached',
      'not_yet_open',
      'password_required',
      // The counterpart of `editing_disabled` for
      // *Zwischenspeichern*: read on every access, on the save and on the
      // resume alike.
      'saving_disabled',
      'time_limit',
    ]);
  });

  /**
   * Three of the four are the non-open availability states, word for word.
   * Derived from `availabilityStateSchema` in the assertion rather than typed
   * out again, so a state renamed on the read path fails here instead of
   * quietly leaving the enforcement calling it something else.
   */
  it('spells the three window reasons the way the verdict does', () => {
    const nonOpen = availabilityStateSchema.options.filter(
      (state) => state !== 'open',
    );

    for (const state of nonOpen) {
      expect(submissionRefusalReasonSchema.options).toContain(state);
    }
    expect(nonOpen).toHaveLength(3);
  });

  it('reads a refusal a participant was answered with', () => {
    expect(
      readSubmissionRefusal({
        message: 'Die Frist für dieses Formular ist abgelaufen.',
        reason: 'closed',
      }),
    ).toStrictEqual({
      message: 'Die Frist für dieses Formular ist abgelaufen.',
      reason: 'closed',
    });
  });

  it.each([
    ['a proxy error page', '<html>502</html>'],
    ['a reason this version does not know', { message: 'x', reason: 'mond' }],
    ['a body without a reason', { message: 'x' }],
  ])('answers undefined for %s rather than throwing', (_name, body) => {
    expect(readSubmissionRefusal(body)).toBeUndefined();
  });
});

/**
 * The locked branch, the gate request and the proof.
 *
 * The enforcement is the server's (`apps/api/test/public/password-gate.spec.ts`).
 * What the contract owes is narrower and is exactly what a client acts on: that
 * the two branches are told apart by one field, that the locked one carries no
 * questions, and that the word is bounded the way the editor's field is.
 */
describe('the password gate on the wire', () => {
  const locked = {
    locked: true,
    title: 'Jahrestagung 2026',
    tenant: {
      name: 'Dachorganisation',
      shortName: 'DACH',
      logoRef: null,
      branding: {
        accent: '#cea967',
        headerBg: '#212226',
        canvasBg: '#e9e6df',
        stripe: ['#212226', '#7c0800', '#cea967'],
        wideLogo: true,
      },
    },
  };

  it('carries exactly title, Organisation and the flag when the form is locked', () => {
    expect(Object.keys(lockedPublicFormSchema.shape).sort()).toStrictEqual([
      'locked',
      'tenant',
      'title',
    ]);
  });

  it('parses a locked answer into the locked branch', () => {
    const parsed = parsePublicFormResponse(locked);

    expect(parsed.locked).toBe(true);
    // The compiler is the real assertion here — `definition` does not exist on
    // this branch — so the run-time one only has to show the object is clean.
    expect(parsed).not.toHaveProperty('definition');
    expect(parsed).not.toHaveProperty('startToken');
  });

  it('parses an open answer into the open branch', () => {
    const parsed = parsePublicFormResponse(payload());

    expect(parsed.locked).toBe(false);
    // Narrowed through the discriminator, which is the point of the union:
    // the questions are only reachable on the branch that has them.
    expect(parsed.locked ? [] : parsed.definition.pages).toHaveLength(1);
  });

  /**
   * **A locked payload that smuggled a definition along loses it here.**
   *
   * The client-side half of bullet 1, and it is not redundant with the server
   * test: the schema is what the view actually receives, so „the questions are
   * not on this page" holds even against a *future* server that started
   * attaching them for convenience. Nothing downstream can render what the
   * parse dropped.
   *
   * Stripped rather than refused, deliberately: these schemas are `z.object`
   * throughout (see `publicFormSchema` above), so a payload from a newer server
   * keeps working instead of blanking the page — and for this one member the
   * difference does not matter, because dropped and refused are both „not
   * rendered".
   */
  it('drops questions smuggled into a locked payload', () => {
    const parsed = parsePublicFormResponse({
      ...locked,
      definition: { pages: [] },
    });

    expect(parsed.locked).toBe(true);
    expect(parsed).not.toHaveProperty('definition');
  });

  it('refuses an answer without the discriminator', () => {
    // Rebuilt without the flag rather than destructured out of it: the same
    // result, and it says „an older server answered" without an unused
    // binding.
    const withoutFlag = { title: locked.title, tenant: locked.tenant };

    expect(() => parsePublicFormResponse(withoutFlag)).toThrow();
  });

  it('takes an access word in the body and bounds it like the editor field', () => {
    expect(accessRequestSchema.parse({ password: 'Jahrestagung2026' })).toEqual(
      {
        password: 'Jahrestagung2026',
      },
    );
    // An empty offer is not a guess, it is a client that sent the field anyway.
    expect(() => accessRequestSchema.parse({ password: '' })).toThrow();
    expect(() =>
      accessRequestSchema.parse({ password: 'x'.repeat(PASSWORD_MAX + 1) }),
    ).toThrow();
    // The bound is the editor's own, not a second number that could disagree.
    expect(() =>
      accessRequestSchema.parse({ password: 'x'.repeat(PASSWORD_MAX) }),
    ).not.toThrow();
  });

  /**
   * **Control characters are refused, and the reason is a corrected claim.**
   *
   * Two constants stand in for „there is no word here" ({@link
   * REDACTED_PASSWORD}, which lives in this package since the browser has to
   * recognise it, and the API's `DUMMY_WORD`) and both carry a NUL byte, on the
   * argument that nobody can type one. Nobody has to: JSON carries U+0000
   * perfectly well, and this schema bounded the offer by *length* only. Neither
   * constant ever opened a form — the gate refuses whenever no word is
   * configured, whatever the comparison said — but the sentence „unguessable by
   * construction" was not true until this line existed.
   *
   * Printable characters outside ASCII stay allowed: an organisation may well pick a word
   * with an umlaut, and `\p{Cc}` says *control*, not *non-ASCII*.
   */
  it.each([
    ['a NUL byte', '\u0000no-access-word-configured'],
    // The constant itself, no longer a copy of it: it has stood in this
    // package since the move, and a second spelling here would be exactly the
    // version that would stay behind at the next change of the value.
    ['the redaction marker', REDACTED_PASSWORD],
    ['a NUL byte inside a plausible word', 'Jahrestagung\u00002026'],
    ['a newline', 'Jahrestagung\n2026'],
    ['a C1 control character', 'Jahrestagung\u00852026'],
  ])('refuses %s in the offered word', (_name, password) => {
    expect(() => accessRequestSchema.parse({ password })).toThrow();
  });

  it.each([
    ['an umlaut', 'Jahrestagung2026ä'],
    ['a space', 'Jahrestagung 2026'],
    ['punctuation', 'Jahrestagung-2026!'],
  ])('still accepts %s', (_name, password) => {
    expect(accessRequestSchema.parse({ password }).password).toBe(password);
  });

  it('reads the proof out of a passed gate', () => {
    expect(parseAccessGrant({ accessToken: 'p1.mfa1b2c3.Zm9vYmFy' })).toEqual({
      accessToken: 'p1.mfa1b2c3.Zm9vYmFy',
    });
    expect(() => parseAccessGrant({ accessToken: '' })).toThrow();
    expect(() =>
      parseAccessGrant({ accessToken: 'x'.repeat(1_000) }),
    ).toThrow();
  });
});

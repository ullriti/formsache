import { expect, type Page } from '@playwright/test';

/**
 * What the mechanical auditor visits.
 *
 * Every entry names the **route kind** it covers. That makes the list
 * countable against `routerRouteKinds()` from `router-kinds.ts`, and exactly
 * that count is what ensures: a new address
 * in the router without an entry here turns `a11y-view-list.spec.ts` red,
 * instead of quietly letting the axe run cover one view less.
 *
 * **Why a table nonetheless and not "one URL automatically per kind".** From
 * the kind alone no visitable address follows: `builder` needs a form id,
 * `public-form` a published address, `response-edit` the token of a submitted
 * answer. What stands here by hand is therefore *how you get there* — not
 * *that the view exists*. The latter comes from the router, and only the
 * latter gets forgotten.
 */

/** The preparations a view needs in order to be looked at. */
export interface A11yFixture {
  /** Form with one question, saved and published. */
  readonly formId: string;
  /** `/f/<Adresse>` of the same form. */
  readonly publicPath: string;
  /** `/a/<Merkzeichen>` of a submitted answer to it. */
  readonly editPath: string;
  /** `/e/<Merkzeichen>` of a cached draft of it. */
  readonly draftPath: string;
}

/** Who may see the view — decides the browser context. */
export type A11yAudience =
  /** Behind the sign-in, in the shell — the shared session from `auth.setup`. */
  | 'signed-in'
  /** Reachable without signing in, in its own session-less context. */
  | 'public';

export interface A11yView {
  /**
   * The route kind from `parseRoute`, or `null` for a view that has no
   * address of its own.
   *
   * `null` is expressly allowed and expressly rare: the sign-in mask is not a
   * route but what `App.tsx` shows *instead of* every route, as long as
   * `GET /api/auth/me` knows nobody. It stands here nonetheless, because it
   * is a view a human gets to see — and because it is the first one.
   */
  readonly kind: string | null;
  /** Appears like this in the test name and in the report. */
  readonly name: string;
  readonly audience: A11yAudience;
  /** Navigates to the view and waits until it really stands there. */
  readonly open: (page: Page, fixture: A11yFixture) => Promise<void>;
}

/**
 * Waits until a view is finished — not until it has started.
 *
 * Without this step axe reliably measures the loading state: a page that only
 * shows „Wird geladen…" has hardly any controls and therefore hardly any
 * violations. That would again be "the auditor ran over nothing", only one
 * level deeper.
 *
 * Waiting is on **state**, never on time (`AGENTS.md`, test rules): the
 * heading of the view is visible, and none of the loading indicators is there
 * any more. Every view of this application carries an `<h1>` — the preview
 * inherits it from the embedded fill-in form.
 */
async function settled(page: Page, heading?: string | RegExp): Promise<void> {
  // `.first()` in the nameless case: what is sought here is *readiness*, not
  // "exactly one `<h1>`". Without it Playwright's strict mode would break in
  // every view with two headings — with a message about the locator that says
  // nothing about accessibility. How many `<h1>` a page should have is a
  // question of its own (axe asks it under `best-practice`, see `scan.ts`),
  // and it does not belong in the loading state.
  await expect(
    heading === undefined
      ? page.getByRole('heading', { level: 1 }).first()
      : page.getByRole('heading', { level: 1, name: heading }),
  ).toBeVisible();

  // The three loading texts of the application. `toHaveCount(0)` waits until
  // they are gone, instead of looking once whether they were gone already.
  //
  // ⚠️ **The `\s*` before the ellipsis is not a cosmetic flaw, but the lesson
  // from a finding.** `SystemAiSettingsTab` wrote
  // „Wird geladen …" with a space; an exact regex did not match that, and the
  // axe run over the AI tab measured exactly the loading placeholder that this
  // block is meant to exclude — and reported it as clean, because a paragraph
  // with four words has no violations. The spelling has been unified; the
  // `\s*` makes sure that the next typo does not tear the same gap.
  // (Playwright normalises whitespace in text matching only down to *one*
  // space, so it does not throw it away.)
  await expect(
    page.getByText(
      /^(Wird geladen|Anmeldestatus wird geprüft|Einrichtungsstatus wird geprüft)\s*…$/u,
    ),
  ).toHaveCount(0);
}

/**
 * Waits for **one particular** tab of the system administration.
 *
 * ⚠️ **Why this must not be `settled(page, 'Systemverwaltung')`.** The
 * `<h1>` „Systemverwaltung" belongs to the frame (`SystemAdminView`) and
 * stands above all **six** tabs (*Rechtstexte* since ADR-0028). Six entries
 * that only wait for it are six entries making the same assertion: if
 * `/admin/system/ai` accidentally led to the first tab, the axe run would
 * pass green and would have scanned the organisation list five times. The
 * coverage the list claims would be invented.
 *
 * Two markers, because they prove two different things:
 *
 *   1. `aria-current="page"` on **this** tab button — that is what
 *      `parseRoute` made of the address. Exactly the mapping that can go wrong
 *      above, and it hangs on the route alone.
 *   2. The `<h2>` of the body — that under the tab bar really the content of
 *      this tab stands and not that of another.
 *
 * Only then `settled()`: that the view is finished is a question of its own.
 */
async function settledSystemTab(
  page: Page,
  tab: string,
  heading: string,
): Promise<void> {
  await expect(
    page
      .getByRole('navigation', { name: 'Systemverwaltung' })
      .getByRole('button', { name: tab, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', { level: 2, name: heading }),
  ).toBeVisible();
  await settled(page, 'Systemverwaltung');
}

/**
 * The same for a tab of the **organisation** administration.
 *
 * Word-for-word the same reasoning as at `settledSystemTab()` next door, only
 * one level deeper: the `<h1>` „Organisations-Verwaltung" belongs to the frame
 * (`TenantAdminView`) and stands above all **six** tabs (*Rechtstexte* since
 * ADR-0028). Whoever waits only for it is satisfied even
 * when the address has landed on the wrong tab — and the axe run would have
 * scanned the same thing twice and reported it "clean".
 *
 * ⚠️ The four older tenant entries below still wait for the shared `<h1>`
 * alone. That is a pre-existing weakness and no statement about this tab;
 * pulling them along here would be a change to four cases that the same
 * follow-up work could not carry out (no Playwright at hand).
 */
async function settledTenantTab(
  page: Page,
  tab: string,
  heading: string,
): Promise<void> {
  await expect(
    page
      .getByRole('navigation', { name: 'Organisations-Verwaltung' })
      .getByRole('button', { name: tab, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('heading', { level: 2, name: heading }),
  ).toBeVisible();
  await settled(page, 'Organisations-Verwaltung');
}

/**
 * The views, in the order in which a human encounters them.
 *
 * Order is documentation here, not sequence: every entry navigates to its
 * address itself, so that a single case also runs on its own
 * (`--grep`), instead of depending on its predecessor.
 */
export const A11Y_VIEWS: readonly A11yView[] = [
  {
    kind: null,
    name: 'Anmeldung',
    audience: 'public',
    open: async (page) => {
      await page.goto('/');
      await settled(page, 'Formsache');
    },
  },
  {
    /*
      **Neues Passwort vergeben** — the page behind the reset link.

      Session-less, and that is no negligence: whoever resets their password
      is precisely *not* signed in. The token is freely invented,
      and that is enough for the axe run — `PasswordResetView` renders the form
      for every token and answers the question "do I know this?" only on
      submitting (deliberately: telling "expired" apart from "already used"
      would be information about someone else's account). What is scanned is
      therefore exactly the state a human with a real link has in front of them.
    */
    kind: 'password-reset',
    name: 'Neues Passwort vergeben',
    audience: 'public',
    open: async (page) => {
      await page.goto('/password/ein-erfundenes-merkzeichen');
      await settled(page, 'Neues Passwort vergeben');
    },
  },
  {
    /*
      **Willkommen bei Formsache** — the same page behind the *invitation* link
      (ADR-0024).

      Two entries for one component, and that is the point: what differs is
      **the wording alone** (`WORDING` in
      `PasswordResetView.tsx`) — „Neues Passwort vergeben" is, for someone
      who never had one, the wrong sentence. The kind is decided by the
      address, not by the server; an entry here is therefore the only place
      at which the second wording gets scanned at all.

      The token is freely invented as above: the page shows its form
      for every one and answers "do I know this?" only on submitting.
    */
    kind: 'account-invitation',
    name: 'Einladung — Passwort vergeben',
    audience: 'public',
    open: async (page) => {
      await page.goto('/invitation/ein-erfundenes-merkzeichen');
      await settled(page, 'Willkommen bei Formsache');
    },
  },
  {
    /*
      **The dashboard needs more than `settled`**, and the reason is measured.

      `settled` waits for the `<h1>` and for the three loading texts to be
      gone. This view, however, hangs on **four independent queries**: the
      form list, and in `TenantOpenItems` one each for mail server, groups
      and legal texts. Each lands for itself, and the list repaints on each
      one. Between the second and the fourth stands a view that
      *looks* complete and is not.

      *Measured on 2026-08-18:* the AAA count in `mobile-targets.spec.ts`
      found **five** instead of ten controls under load — „Zum Mailversand"
      was there, „Zu den Rechtstexten" was not yet, and the four card buttons
      were missing entirely. In the database there stood 111 forms
      at that moment and `legal_pages IS NULL` for every organisation; so
      nothing was missing, it had only not arrived yet. Repeated on its own
      the same case ran green — exactly the sort of failure that `retries: 2`
      in CI covers up instead of fixing.

      `networkidle` is rightly frowned upon for general use, but here it is
      exactly the question: **have the queries landed?** Waiting for
      individual controls would be the worse choice — it would have to
      presuppose a data state (cards present, items open), and the
      view is visited by two different sessions with different
      organisations.
    */
    kind: 'dashboard',
    name: 'Dashboard',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/');
      await settled(page);
      await page.waitForLoadState('networkidle');
    },
  },
  {
    /*
      **Mein Profil** — name, e-mail address, password and one's own
      sessions (findings 8, 12 and 17). The view is new, and without this
      entry the axe run would cover four form cards less, without
      reporting it.
    */
    kind: 'profile',
    name: 'Mein Profil',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/profile');
      await settled(page, 'Mein Profil');
    },
  },
  {
    kind: 'builder',
    name: 'Formular-Builder',
    audience: 'signed-in',
    open: async (page, fixture) => {
      await page.goto(`/forms/${fixture.formId}`);
      await settled(page);
    },
  },
  {
    kind: 'responses',
    name: 'Antworten-Tabelle',
    audience: 'signed-in',
    open: async (page, fixture) => {
      await page.goto(`/forms/${fixture.formId}/responses`);
      await settled(page, 'Antworten');
    },
  },
  {
    kind: 'preview',
    name: 'Testmodus',
    audience: 'signed-in',
    open: async (page, fixture) => {
      await page.goto(`/forms/${fixture.formId}/preview`);
      // The test-mode bar appears only with the loaded revision; the
      // `<h1>` below it comes from the embedded fill-in form.
      await expect(page.getByTestId('test-mode-bar')).toBeVisible();
      await settled(page);
    },
  },
  {
    kind: 'form-settings',
    name: 'Formular-Einstellungen',
    audience: 'signed-in',
    open: async (page, fixture) => {
      await page.goto(`/forms/${fixture.formId}/settings`);
      await settled(page, 'Formular-Einstellungen');
    },
  },
  {
    kind: 'notifications',
    name: 'Benachrichtigungen',
    audience: 'signed-in',
    open: async (page, fixture) => {
      await page.goto(`/forms/${fixture.formId}/notifications`);
      await settled(page);
    },
  },
  {
    kind: 'form-members',
    name: 'Nutzerrechte je Formular',
    audience: 'signed-in',
    open: async (page, fixture) => {
      await page.goto(`/forms/${fixture.formId}/members`);
      await settled(page, 'Nutzerrechte');
    },
  },
  {
    kind: 'mail-log',
    name: 'Versandprotokoll',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/mail-log');
      await settled(page, 'E-Mail-Versandprotokoll');
    },
  },
  {
    kind: 'tenant-appearance',
    name: 'Organisations-Verwaltung · Erscheinungsbild',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/appearance');
      await settled(page, 'Organisations-Verwaltung');
    },
  },
  {
    kind: 'tenant-form-defaults',
    name: 'Organisations-Verwaltung · Formular-Standards',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/form-defaults');
      await settled(page, 'Formular-Standards');
    },
  },
  {
    kind: 'tenant-members',
    name: 'Organisations-Verwaltung · Nutzerrechte',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/members');
      await settled(page, 'Organisations-Verwaltung');
    },
  },
  {
    kind: 'tenant-mail',
    name: 'Organisations-Verwaltung · Mailversand',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/mail');
      await settled(page, 'Organisations-Verwaltung');
    },
  },
  {
    /*
      **Organisations-Verwaltung · KI** — the fifth tab (ADR-0025).

      For one commit it did not stand here, and that was no silent loss,
      but a red run: `a11y-view-list.spec.ts` measures this list against
      `routerRouteKinds()`, and `tenant-ai` was missing from it. Exactly the
      effect for which the count was built.

      Two markers instead of the shared `<h1>`, for the reason that stands at
      `settledTenantTab()`.
    */
    kind: 'tenant-ai',
    name: 'Organisations-Verwaltung · KI',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/ai');
      await settledTenantTab(page, 'KI', 'KI-Formularerstellung');
    },
  },
  {
    /*
      **Organisations-Verwaltung · Rechtstexte** — the sixth tab (ADR-0028).

      Two cards, *Anbieterangaben* and *Datenschutzhinweise*, and both are
      the same editor (`views/legal/LegalPageEditor.tsx`). The marker is the
      heading of the **first** card and not the tab label: that one
      already stands in the tab bar, and `settledTenantTab` checks it there
      anyway — what it cannot say is whether under the bar really
      this tab stands.

      ⚠️ Before loading, the tab shows „Rechtstexte werden geladen…". This
      sentence does **not** stand in the loading-text list of `settled()`, and
      that is without consequence here, because the `<h2>` of the card appears
      only with the loaded document — waiting for it means waiting for the
      document.
    */
    kind: 'tenant-legal-settings',
    name: 'Organisations-Verwaltung · Rechtstexte',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/legal');
      await settledTenantTab(page, 'Rechtstexte', 'Anbieterangaben');
    },
  },
  {
    /*
      **Organisations-Verwaltung · Vorlagen** — the seventh tab (ADR-0032,
      moved here in full from the system administration's former
      `system-templates` entry, which stood next to `system-legal-settings`
      above).

      The marker is the first template card: the heading „Vorlagen"
      stands only in the tab bar, and waiting for it would mean waiting for
      the frame instead of for the content.
    */
    kind: 'tenant-templates',
    name: 'Organisations-Verwaltung · Vorlagen',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/templates');
      await settledTenantTab(page, 'Vorlagen', 'Bestätigung an Teilnehmer');
    },
  },
  {
    /*
      **The setup assistant of an organisation** (ADR-0025) — not a
      tab, a flow above them, and therefore an address of its own.

      What is scanned is **step 1** (Erscheinungsbild): the assistant keeps its
      progress in `useState`, so that is the state everyone
      arrives in who calls the address. The further seven steps show
      the same cards as the tabs of the organisation administration, which
      already stand here individually — what the frame adds (step list,
      progress text, the three buttons) is the same in every step
      and thus measured along here.

      The marker is the first card of the step and **not** the `<h2>`
      „Erscheinungsbild": that one is carried by the frame from the step list
      and stands there even while the document is still loading.
    */
    kind: 'tenant-setup',
    name: 'Organisation einrichten (Assistent)',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/setup');
      await expect(
        page.getByRole('heading', { level: 2, name: 'Logo & Name' }),
      ).toBeVisible();
      await settled(page, 'Organisation einrichten');
    },
  },
  {
    kind: 'trash',
    name: 'Papierkorb',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/trash');
      await settled(page, 'Papierkorb');
    },
  },
  {
    /*
      **The tabs of the system administration** (finding 16). Until then there stood
      here five entries for three separate areas — the superadmin overview,
      the „Betrieb" and the „Systemeinstellungen" with their bare address and
      two sub-paths. The five kinds (`superadmin`, `ops`, `system-settings`,
      `system-mail-settings`, `system-ai-settings`) no longer exist; what
      `parseRoute` produces today are the entries below — *Rechtstexte* since
      ADR-0028, *Superadmins* since ADR-0029. *Vorlagen* stood among them from
      ADR-0022 until ADR-0032 moved notification templates from the
      installation to every organisation; its entry moved with it, to
      `tenant-templates` further up.

      **Every tab is an entry of its own and not a click sequence through the
      tab bar.** What axe measures here is the state in which a human arrives
      with a bookmark — and that is the address, not the way there.
      An entry that starts at `tenants` and clicks its way through to `ai`
      would additionally depend on the tab bar, which it does not check at all.

      ⚠️ **This list is measured against `routerRouteKinds()`**
      (`a11y-view-list.spec.ts`): a new route without an entry here turns the
      comparison red. That is how *Vorlagen* came here.

      The `<h1>` „Systemverwaltung" is common to all of them — the frame
      renders it once (`SystemAdminView`). **Nobody here therefore waits for
      it alone**; every entry additionally demands its own marker,
      and why, stands at `settledSystemTab()`.
    */
    kind: 'system-tenants',
    name: 'Systemverwaltung · Organisationen',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/system');
      await settledSystemTab(
        page,
        'Organisationen',
        'Organisationen dieser Installation',
      );
    },
  },
  {
    kind: 'system-monitoring',
    name: 'Systemverwaltung · Überwachung',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/system/monitoring');
      await settledSystemTab(page, 'Überwachung', 'Überwachung');
    },
  },
  {
    kind: 'system-mail',
    name: 'Systemverwaltung · Mailserver',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/system/mail');
      await settledSystemTab(page, 'Mailserver', 'Mailserver');
    },
  },
  {
    kind: 'system-ai',
    name: 'Systemverwaltung · KI',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/system/ai');
      await settledSystemTab(page, 'KI', 'KI-Anbieter');
    },
  },
  {
    /*
      **Systemverwaltung · Rechtstexte** — the sixth tab (ADR-0028).

      Two cards: *Impressum* and *Datenschutzerklärung*. The marker is the
      first of them, for the reason that stands at `settledSystemTab()`.
    */
    kind: 'system-legal-settings',
    name: 'Systemverwaltung · Rechtstexte',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/system/legal');
      await settledSystemTab(page, 'Rechtstexte', 'Impressum');
    },
  },
  {
    /*
      **Superadmins** (ADR-0029) — the way to the second superadministrator.

      The tab carries two cards: the list of appointments and the form
      with which a further one is added. Waiting is for the **second**, because
      the list stands there even while the query is still running — the form
      is drawn only by the loaded branch.

      The tab carries **no** `role="switch"`; `SWITCHES_PER_VIEW` in
      `mobile-switches.spec.ts` therefore needs no entry. Looked up,
      not assumed: the rows carry buttons („Ernennung … zurücknehmen"),
      the form a text field.
    */
    kind: 'system-superadmins',
    name: 'Systemverwaltung · Superadmins',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/admin/system/superadmins');
      await settledSystemTab(
        page,
        'Superadmins',
        'Person zur Systemverwaltung hinzufügen',
      );
    },
  },
  {
    kind: 'not-found',
    name: 'Seite nicht gefunden',
    audience: 'signed-in',
    open: async (page) => {
      await page.goto('/diese-adresse-gibt-es-nicht');
      await settled(page, 'Diese Seite gibt es nicht.');
    },
  },
  {
    kind: 'public-form',
    name: 'Öffentliches Ausfüllen',
    audience: 'public',
    open: async (page, fixture) => {
      await page.goto(fixture.publicPath);
      await settled(page);
    },
  },
  {
    /*
      **Impressum of the installation** — without signing in (ADR-0028).

      `audience: 'public'`, and that is no formality here, but the
      assurance itself: § 18 Abs. 1 MStV demands „ständig verfügbar",
      Art. 13 Abs. 1 DSGVO „zum Zeitpunkt der Erhebung" — a sign-in mask in
      front of an Impressum would be no Impressum. The entry therefore runs in
      the session-less context of `a11y.spec.ts` and `mobile-reachable.spec.ts`,
      and an `App.tsx` that pushed this address back behind the session check
      would end up in the sign-in mask here and thus red.

      **One kind, one entry.** `system-legal` covers two addresses
      (`/imprint`, `/privacy`); what is scanned is the first. The two
      are the same component with a different template behind them
      (`views/legal/LegalPageView.tsx`), so a second entry measures the same
      blueprint once more. That the other address *exists* and what it says in
      the empty state is checked by `public-form-settings.spec.ts`.
    */
    kind: 'system-legal',
    name: 'Impressum (ohne Anmeldung)',
    audience: 'public',
    open: async (page) => {
      await page.goto('/imprint');
      await settled(page, 'Impressum');
    },
  },
  {
    /*
      **Anbieterangaben of an organisation** — `/o/<kurzname>/imprint`.

      The short name is **not** written down here, but walked to: from
      the footer of the test form, via the link that a participating
      person would click too. Two reasons, and the second is the
      more important one:

      1. A literal like `/o/DACH/imprint` would be a second truth about the
         seed — it would drift apart at the next `prisma/seed.ts`, and the
         case would report „Seite nicht gefunden" instead of "the seed is
         named differently".
      2. The way *is* the assurance: the footer carries the link to the
         Anbieterangaben of the organisation whose form is currently open.
         If it is missing, this entry does not even arrive — and that is
         exactly the defect that `docs/legal/README.md` 5.4 calls „unsichtbar".
    */
    kind: 'tenant-legal',
    name: 'Anbieterangaben der Organisation (ohne Anmeldung)',
    audience: 'public',
    open: async (page, fixture) => {
      await page.goto(fixture.publicPath);
      await page
        .getByRole('link', { name: 'Anbieterangaben', exact: true })
        .click();
      await settled(page, 'Anbieterangaben');
    },
  },
  {
    /*
      **Lizenzen und Urheberrecht** — the one legal-text page without a
      document behind it (`views/legal/LicencesView.tsx`).

      It is the only entry of this list whose content comes from two
      `?raw` imports (the MIT licence at the root and the ParaType Free
      Font License next to the font files). For the axe run that means: two
      `<pre>` blocks with much text and long lines, so exactly the shape
      at which a contrast or overflow error is noticed first.
    */
    kind: 'licences',
    name: 'Lizenzen und Urheberrecht (ohne Anmeldung)',
    audience: 'public',
    open: async (page) => {
      await page.goto('/licences');
      await settled(page, 'Lizenzen und Urheberrecht');
    },
  },
  {
    kind: 'response-edit',
    name: 'Antwort bearbeiten',
    audience: 'public',
    open: async (page, fixture) => {
      await page.goto(fixture.editPath);
      /*
        **Do not wait for „Antwort bearbeiten" as `<h1>`** — this
        heading belongs to the *error branch* (expired or unknown
        token). In the loaded state the `<h1>` is the **form title**,
        because the view is the fill-in form; measured on 2026-08-10 on a
        real edit address.

        That is exactly the reason why a marker of the view stands here and
        not the generic `<h1>`: `response-edit-note` exists only on the
        loaded page, `settled()` alone would be satisfied on the error page
        too — and axe would then run over a handful of text and report
        "clean".
      */
      await expect(page.getByTestId('response-edit')).toBeVisible();
      await expect(page.getByTestId('response-edit-note')).toContainText(
        'bereits abgesendete Antwort',
      );
      await settled(page);
    },
  },
  {
    kind: 'response-draft',
    name: 'Entwurf fortsetzen',
    audience: 'public',
    open: async (page, fixture) => {
      await page.goto(fixture.draftPath);
      // The same as at „Antwort bearbeiten" next door, and here there are even
      // **two** headings that are not meant: „Entwurf fortsetzen"
      // (error branch) and „Entwurf verworfen" (after submitting). In the
      // loaded state the `<h1>` is the form title.
      await expect(page.getByTestId('response-draft')).toBeVisible();
      await expect(page.getByTestId('response-draft-note')).toContainText(
        'zwischengespeicherter Entwurf',
      );
      await settled(page);
    },
  },
];

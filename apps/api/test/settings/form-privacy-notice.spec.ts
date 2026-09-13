import { randomBytes, randomUUID } from 'node:crypto';

import {
  EMPTY_LEGAL_DOCUMENT,
  type LegalBlock,
  type LegalDocument,
  type LegalInline,
} from '@formsache/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FORM_NOT_FOUND_MESSAGE } from '../../src/forms/forms.service';
import { MISSING_PERMISSION_MESSAGE } from '../../src/tenancy/group-permission.guard';
import {
  acquireTestDatabase,
  type TestDatabase,
} from '../database/test-database';
import {
  apiPath,
  createTestApp,
  type TestApp,
} from '../support/create-test-app';
import {
  createRestrictedMember,
  createTenant,
  createUser,
  type TenantFixture,
} from '../support/fixtures';
import { authedMutation, cookieHeader, openSession } from '../support/http';
import { NO_SECTIONS } from '../support/settings-sections';

/**
 * **The privacy notice per form** (ADR-0028 no. 4,
 * `docs/legal/README.md` 5.2) — the five promises that only an
 * integration test can keep.
 *
 * 1. **The permission is `can_manage_form_settings` and not `can_build`**
 *    (ADR-0021 separated the two deliberately), checked via the case that
 *    **must fail**. ⚠️ The trap sits in the fixture: the person who is
 *    refused holds *every other* permission — one holding none would only
 *    prove that some guard fires (`AGENTS.md`).
 * 2. **Tenant isolation** — a form of another organisation is not
 *    reachable through this route, and the answer is the same 404 as for
 *    an invented ID.
 * 3. **The public path** — the notice reaches the fill-out page, and a
 *    form without a notice returns `null` instead of a substitute text.
 * 4. **The XSS channel, closed** (ADR-0028 section 7) — measured against
 *    what the server actually **delivers**: blocks with text runs, no
 *    markup, and a `javascript:` target becomes visible text instead of a
 *    link.
 * 5. **The two copy paths, decided in opposite directions** — when
 *    duplicating, the notice travels along, into the template drawer it
 *    does not. Both stand that way in the ADR, and both are the point with
 *    the data protection consequence: a purpose statement copied along then
 *    stands under a different collection.
 *
 * Plus the legacy case: a form that was created before this column
 * behaves exactly as before — no backfill, no invented purpose.
 *
 * **Negative check, measured while writing.** Take
 * `@RequirePermission('canManageFormSettings')` off the `PUT` route and the
 * permission pair goes red and nothing else. Replace, in
 * `privacyNoticeOf` (`public-forms.service.ts`), the block output with the
 * raw text and the XSS probe goes red. The reproduction of the two copy paths
 * stands at their cases, because each of them demands a different handle.
 */

const PASSWORD = 'test-password';
const PAGE = '019ff300-0000-7000-8000-0000000000a0';
const NAME = '019ff300-0000-7000-8000-000000000001';

function definition() {
  return {
    pages: [
      {
        id: PAGE,
        title: 'Anmeldung',
        questions: [
          {
            id: NAME,
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
  };
}

/** Every text of a block tree, flat — for the „is that in there?" probes. */
function textOf(blocks: readonly LegalBlock[]): string {
  const runs = (list: readonly LegalInline[]): string =>
    list
      .map((run) =>
        run.kind === 'gap'
          ? `[LÜCKE ${run.label}]`
          : run.kind === 'link'
            ? `${run.label} → ${run.href}`
            : run.text,
      )
      .join('');
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
          return runs(block.runs);
        case 'list':
          return block.items.map(runs).join('\n');
        case 'table':
          return [block.head, ...block.rows]
            .map((row) => row.map(runs).join(' | '))
            .join('\n');
      }
    })
    .join('\n');
}

/** A filled-in notice, the way the template provides for it. */
function filledNotice(): LegalDocument {
  return {
    ...EMPTY_LEGAL_DOCUMENT,
    fills: {
      ZWECK: 'Anmeldung zur Jahrestagung 2026 und deren Durchführung',
      RECHTSGRUNDLAGE: 'Art. 6 Abs. 1 lit. b DSGVO',
      AUFBEWAHRUNG: 'Bis zum 31.12.2026, danach Löschung',
    },
  };
}

/**
 * ⚠️ **Ohne `status` und ohne `missing`** — Review-Runde 5 Nr. 1: was eine
 * ausfüllende Person nicht sehen soll, bekommt sie auch nicht
 * (`publicFormPrivacyNoticeSchema`).
 */
interface PublicNotice {
  readonly title: string;
  readonly blocks: readonly LegalBlock[];
}

describe('der Datenschutzhinweis eines Formulars', () => {
  let testApp: TestApp;
  let alpha: TenantFixture;
  let beta: TenantFixture;
  /** Holds `can_manage_form_settings` (and everything else). */
  let alphaAdmin: string;
  /** Holds **everything but** `can_manage_form_settings` — `can_build` too. */
  let withoutFormSettings: string;
  let betaAdmin: string;
  let database: TestDatabase | undefined;

  const app = (): TestApp => testApp;

  beforeAll(async () => {
    database = await acquireTestDatabase();
    testApp = await createTestApp({ databaseUrl: database.url });

    alpha = await createTenant(testApp.prisma, 'FPNA');
    beta = await createTenant(testApp.prisma, 'FPNB');

    const alphaUser = await createUser(testApp.prisma, {
      email: 'privacy-alpha@example.org',
      password: PASSWORD,
      tenants: [alpha],
    });
    alphaAdmin = await openSession(testApp, alphaUser.id, alpha.id);

    const betaUser = await createUser(testApp.prisma, {
      email: 'privacy-beta@example.org',
      password: PASSWORD,
      tenants: [beta],
    });
    betaAdmin = await openSession(testApp, betaUser.id, beta.id);

    /*
      ⚠️ **The trap sits in the fixture, not in the code.** This person may
      build, see responses, export, administer the organisation and
      administer users — only `can_manage_form_settings` is missing. A person
      without any permission would prove that *some* guard fires, and not that
      it is this one. `canBuild: true` is the point here: precisely the editor
      who builds and publishes the form must **not** write the legal text
      (ADR-0021).
    */
    const restricted = await createRestrictedMember(testApp.prisma, alpha, {
      email: 'ohne-formular-einstellungen@example.org',
      groupName: 'Ohne Formular-Einstellungen',
      permissions: {
        canBuild: true,
        canViewResponses: true,
        canExport: true,
        canManageSettings: true,
        canManageFormSettings: false,
        canManageUsers: true,
      },
    });
    withoutFormSettings = await openSession(testApp, restricted.id, alpha.id);
  }, 120_000);

  afterAll(async () => {
    await testApp.close();
    await database?.release();
  }, 120_000);

  /** Creates a form and publishes it through the real routes. */
  async function createForm(
    token: string,
    title: string,
  ): Promise<{ id: string; publicSlug: string }> {
    const created = await request(app().server)
      .post(apiPath('/forms'))
      .set(authedMutation(token))
      .send({ title });
    expect(created.status).toBe(201);
    const form = created.body as {
      id: string;
      revision: number;
      publicSlug: string;
    };

    const saved = await request(app().server)
      .put(apiPath(`/forms/${form.id}`))
      .set(authedMutation(token))
      .send({ title, definition: definition(), revision: form.revision });
    expect(saved.status).toBe(200);

    const published = await request(app().server)
      .post(apiPath(`/forms/${form.id}/publish`))
      .set(authedMutation(token))
      .send({ revision: (saved.body as { revision: number }).revision });
    expect(published.status).toBe(200);

    return { id: form.id, publicSlug: form.publicSlug };
  }

  async function currentRevisions(
    formId: string,
  ): Promise<{ revision: number; tenantRevision: number }> {
    const form = await app().prisma.form.findUniqueOrThrow({
      where: { id: formId },
      select: { settingsRevision: true, tenantId: true },
    });
    const tenant = await app().prisma.tenant.findUniqueOrThrow({
      where: { id: form.tenantId },
      select: { formDefaultsRevision: true },
    });
    return {
      revision: form.settingsRevision,
      tenantRevision: tenant.formDefaultsRevision,
    };
  }

  /**
   * Writes the notice through the real route.
   *
   * The revisions come from the row and not from a `GET`: half of the
   * callers below may not read at all, and their 403 has to be the guard's
   * answer and not a conflict in the guard's clothing.
   */
  async function writeNotice(
    token: string,
    formId: string,
    privacyNotice: LegalDocument | undefined,
  ): Promise<request.Response> {
    const current = await currentRevisions(formId);
    return request(app().server)
      .put(apiPath(`/forms/${formId}/settings`))
      .set(authedMutation(token))
      .send({
        overridden: NO_SECTIONS,
        values: {},
        revision: current.revision,
        tenantRevision: current.tenantRevision,
        ...(privacyNotice === undefined ? {} : { privacyNotice }),
      });
  }

  async function publicNotice(slug: string): Promise<PublicNotice | null> {
    const response = await request(app().server).get(
      apiPath(`/public/forms/${slug}`),
    );
    expect(response.status).toBe(200);
    return (response.body as { privacyNotice: PublicNotice | null })
      .privacyNotice;
  }

  describe('wer ihn schreiben darf', () => {
    it('weist `can_build` ohne `can_manage_form_settings` beim Schreiben ab', async () => {
      const form = await createForm(alphaAdmin, 'Rechte, Schreiben');

      const refused = await writeNotice(
        withoutFormSettings,
        form.id,
        filledNotice(),
      );

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
      // And the column is untouched — a 403 after which something had been
      // stored would be the worst of all answers.
      const stored = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { privacyNotice: true },
      });
      expect(stored.privacyNotice).toBeNull();
    });

    it('weist dieselbe Person auch beim Lesen ab', async () => {
      const form = await createForm(alphaAdmin, 'Rechte, Lesen');

      const refused = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(withoutFormSettings));

      expect(refused.status).toBe(403);
      expect(refused.text).toContain(MISSING_PERMISSION_MESSAGE);
    });

    it('lässt `can_manage_form_settings` schreiben und liest es zurück', async () => {
      const form = await createForm(alphaAdmin, 'Rechte, erlaubt');

      const written = await writeNotice(alphaAdmin, form.id, filledNotice());
      expect(written.status).toBe(200);
      expect(
        (written.body as { privacyNotice: LegalDocument }).privacyNotice.fills
          .ZWECK,
      ).toContain('Jahrestagung 2026');

      const read = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect(read.status).toBe(200);
      expect(
        (read.body as { privacyNotice: LegalDocument }).privacyNotice.fills
          .RECHTSGRUNDLAGE,
      ).toBe('Art. 6 Abs. 1 lit. b DSGVO');
    });

    /**
     * Silence is not a deletion (`settings-wire.ts`): a client that does not
     * know the field saves settings without taking along a legal text
     * for which there is no trash.
     */
    it('lässt einen Schreibvorgang ohne das Feld den Hinweis stehen', async () => {
      const form = await createForm(alphaAdmin, 'Ohne Feld');
      expect(
        (await writeNotice(alphaAdmin, form.id, filledNotice())).status,
      ).toBe(200);

      const again = await writeNotice(alphaAdmin, form.id, undefined);
      expect(again.status).toBe(200);

      const stored = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { privacyNotice: true },
      });
      expect(stored.privacyNotice).toMatchObject({
        fills: { RECHTSGRUNDLAGE: 'Art. 6 Abs. 1 lit. b DSGVO' },
      });
    });

    it('nimmt ein leeres Dokument als ausdrückliche Löschung', async () => {
      const form = await createForm(alphaAdmin, 'Löschen');
      expect(
        (await writeNotice(alphaAdmin, form.id, filledNotice())).status,
      ).toBe(200);

      const cleared = await writeNotice(
        alphaAdmin,
        form.id,
        EMPTY_LEGAL_DOCUMENT,
      );
      expect(cleared.status).toBe(200);
      expect(await publicNotice(form.publicSlug)).toBeNull();
    });
  });

  describe('Mandantentrennung', () => {
    it('antwortet einer fremden Organisation mit derselben 404 wie auf eine erfundene ID', async () => {
      const form = await createForm(alphaAdmin, 'Fremd');

      const refused = await writeNotice(betaAdmin, form.id, filledNotice());
      expect(refused.status).toBe(404);
      expect(refused.text).toContain(FORM_NOT_FOUND_MESSAGE);

      const invented = await request(app().server)
        .put(apiPath(`/forms/${randomUUID()}/settings`))
        .set(authedMutation(betaAdmin))
        .send({
          overridden: NO_SECTIONS,
          values: {},
          revision: 1,
          tenantRevision: 1,
          privacyNotice: filledNotice(),
        });
      expect(invented.status).toBe(404);
      expect(invented.text).toContain(FORM_NOT_FOUND_MESSAGE);

      // And nothing has been written.
      const stored = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { privacyNotice: true },
      });
      expect(stored.privacyNotice).toBeNull();
    });

    it('zeigt einer fremden Organisation den hinterlegten Hinweis auch nicht beim Lesen', async () => {
      const form = await createForm(alphaAdmin, 'Fremd, Lesen');
      expect(
        (await writeNotice(alphaAdmin, form.id, filledNotice())).status,
      ).toBe(200);

      const refused = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(betaAdmin));

      expect(refused.status).toBe(404);
      expect(refused.text).not.toContain('Jahrestagung 2026');
    });
  });

  describe('der öffentliche Weg', () => {
    it('trägt den Hinweis auf die Ausfüllseite', async () => {
      const form = await createForm(alphaAdmin, 'Öffentlich');
      expect(
        (await writeNotice(alphaAdmin, form.id, filledNotice())).status,
      ).toBe(200);

      const notice = await publicNotice(form.publicSlug);

      expect(notice?.title).toBe('Datenschutzhinweise zu diesem Formular');
      expect(textOf(notice?.blocks ?? [])).toContain(
        'Anmeldung zur Jahrestagung 2026',
      );
      // The reference to the general notices of the organisation — the
      // permanently reachable address, beneath the specific notice.
      expect(textOf(notice?.blocks ?? [])).toContain(
        `→ /o/${alpha.shortName}/privacy`,
      );
    });

    it('liefert null, solange nichts hinterlegt ist — und keinen Ersatztext', async () => {
      const form = await createForm(alphaAdmin, 'Ohne Hinweis');

      expect(await publicNotice(form.publicSlug)).toBeNull();
    });

    /**
     * Eine angefangene Fassung wird **gezeigt, aber ohne ihre Lücken**
     * (Review-Runde 5 Nr. 1). Die Aussagen, die dastehen, sind wahr — und was
     * fehlt, ist eine Auskunft an die Organisation und nicht an die
     * ausfüllende Person: die sieht sie im Entwurf und beim Veröffentlichen
     * (`publish-preview` weiter unten, unverändert `incomplete`).
     */
    it('trägt eine angefangene Fassung hinaus, ohne ihre Lücken zu zeigen', async () => {
      const form = await createForm(alphaAdmin, 'Angefangen');
      expect(
        (
          await writeNotice(alphaAdmin, form.id, {
            ...EMPTY_LEGAL_DOCUMENT,
            fills: { ZWECK: 'Anmeldung zur Mitgliederversammlung' },
          })
        ).status,
      ).toBe(200);

      const notice = await publicNotice(form.publicSlug);
      const text = textOf(notice?.blocks ?? []);

      expect(text).toContain('Anmeldung zur Mitgliederversammlung');
      expect(text).not.toContain('[LÜCKE ');
      expect(text).not.toContain('Rechtsgrundlage');
      expect(notice).not.toHaveProperty('status');
      expect(notice).not.toHaveProperty('missing');
    });

    /**
     * A `[[PLATZHALTER]]` never leaves the server — the promise for whose
     * sake the server renders and the browser only displays.
     */
    it('lässt keinen Platzhalter und keine Blockmarkierung hinaus', async () => {
      const form = await createForm(alphaAdmin, 'Keine Marken');
      expect(
        (await writeNotice(alphaAdmin, form.id, filledNotice())).status,
      ).toBe(200);

      const response = await request(app().server).get(
        apiPath(`/public/forms/${form.publicSlug}`),
      );

      expect(response.text).not.toMatch(/\[\[|\]\]|⟪|⟫/u);
    });
  });

  /**
   * **Die Weiterleitung nach dem Absenden, aus den Einstellungen abgeleitet**
   * (ADR-0028 Nr. 5).
   *
   * Was hier gemessen wird, kann keine Unit prüfen: dass die **Einstellungen
   * dieses Formulars** am öffentlichen Weg tatsächlich bis in den Rechtstext
   * durchreichen. Die Ableitung selbst steht in
   * `packages/shared/src/legal.test.ts`; hier steht die Naht dazwischen —
   * derselbe `PUT`, der Hinweis und Weiterleitung schreibt, und danach die
   * öffentliche Ausfüllseite.
   *
   * Die Gegenprobe ist der halbe Test: ein Abschnitt über eine Übermittlung,
   * der auch dann stünde, wenn nichts übermittelt wird, wäre eine
   * Falschangabe.
   */
  describe('die Weiterleitung nach dem Absenden', () => {
    const TARGET = 'https://beispielverein.de/danke';

    /** Schreibt Hinweis und Weiterleitung in **einem** Schreibvorgang. */
    async function writeWithRedirect(
      formId: string,
      redirectEnabled: boolean,
    ): Promise<void> {
      const current = await currentRevisions(formId);
      const written = await request(app().server)
        .put(apiPath(`/forms/${formId}/settings`))
        .set(authedMutation(alphaAdmin))
        .send({
          // *Bestätigung* übernommen, weil die Weiterleitung dort liegt; die
          // übrigen drei Abschnitte folgen weiter der Organisation.
          overridden: { ...NO_SECTIONS, confirm: true },
          values: { redirectEnabled, redirectUrl: TARGET, redirectDelay: 5 },
          revision: current.revision,
          tenantRevision: current.tenantRevision,
          privacyNotice: filledNotice(),
        });
      expect(written.status).toBe(200);
    }

    it('nennt die Zieladresse im Hinweis, wenn eine eingerichtet ist', async () => {
      const form = await createForm(alphaAdmin, 'Mit Weiterleitung');
      await writeWithRedirect(form.id, true);

      const notice = await publicNotice(form.publicSlug);

      expect(textOf(notice?.blocks ?? [])).toContain(
        'Weiterleitung nach dem Absenden',
      );
      // Als geprüfter Link und nicht als roher Text — `textOf` schreibt das
      // Ziel hinter den Pfeil, also steht hier die Adresse selbst.
      expect(textOf(notice?.blocks ?? [])).toContain(`→ ${TARGET}`);
    });

    it('nennt sie nicht, solange der Schalter aus ist', async () => {
      // Die Zieladresse **bleibt gespeichert** — der Schalter allein
      // entscheidet, und der Rechtstext folgt derselben Regel wie der
      // Browser (`effectiveRedirect`).
      const form = await createForm(alphaAdmin, 'Ohne Weiterleitung');
      await writeWithRedirect(form.id, false);

      const notice = await publicNotice(form.publicSlug);

      expect(textOf(notice?.blocks ?? [])).not.toContain(
        'Weiterleitung nach dem Absenden',
      );
      expect(textOf(notice?.blocks ?? [])).not.toContain(TARGET);
    });

    /**
     * ⚠️ **Die Ampel vor dem Veröffentlichen rührt sich nicht** — in beide
     * Richtungen. Ein abgeleiteter Wert ist kein offener Platzhalter; ein
     * Formular ohne Weiterleitung darf dadurch nicht `incomplete` werden und
     * eines mit Weiterleitung ebenso wenig.
     */
    it.each([
      ['mit Weiterleitung', true],
      ['ohne Weiterleitung', false],
    ])('lässt die Ampel %s auf „ready"', async (_case, redirectEnabled) => {
      const form = await createForm(
        alphaAdmin,
        `Ampel ${String(redirectEnabled)}`,
      );
      await writeWithRedirect(form.id, redirectEnabled);

      const preview = await request(app().server)
        .get(apiPath(`/forms/${form.id}/publish-preview`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(preview.status).toBe(200);
      expect((preview.body as { privacyNotice: string }).privacyNotice).toBe(
        'ready',
      );
    });
  });

  /**
   * **What travels along when copying and what does not** (ADR-0028 no. 4) —
   * the two ways on which a form multiplies, and which are decided there
   * expressly in **opposite** directions.
   *
   * This is the point with the data protection consequence, and both halves
   * are it for the same reason: a purpose statement copied along then stands
   * under a *different* collection. When duplicating that is wanted (the same
   * organisation, the same kind of collection — „Anmeldung 2026" → „Anmeldung
   * 2027"), and the price is named in the ADR: the hint before
   * publishing only stops when **nothing** stands there, not when something
   * outdated stands there. In the template drawer the same travelling along
   * would be wrong — a template is a building block for different purposes.
   *
   * Both without a test would mean: the next change to `duplicate()` or to
   * `formTemplateContentSchema` tips one of the two decisions over without
   * anything going red.
   */
  describe('Duplizieren und Vorlagenschublade', () => {
    /**
     * **It travels along** — in the column *and* on the public page.
     *
     * The second half is not the same promise in other words: the
     * column proves that `duplicate()` writes the document; the public
     * request proves that it also arrives where it belongs. A document
     * that were stored and not delivered would not satisfy Art. 13
     * DSGVO.
     *
     * *Reproduction, measured:* in `FormsService.duplicate`
     * (`apps/api/src/forms/forms.service.ts`) take out the spread
     * `...(form.privacyNotice === null ? {} : { privacyNotice: … })`.
     * The copy then carries `null` in the column, and the case
     * fails at the column check (`null` instead of the document); take that
     * one out and it fails at the public one — `privacyNotice` is `null`
     * there instead of `ready`.
     */
    it('trägt den Hinweis in die Kopie — in die Spalte und auf deren öffentliche Seite', async () => {
      const form = await createForm(alphaAdmin, 'Anmeldung 2026');
      expect(
        (await writeNotice(alphaAdmin, form.id, filledNotice())).status,
      ).toBe(200);

      const duplicated = await request(app().server)
        .post(apiPath(`/forms/${form.id}/duplicate`))
        .set(authedMutation(alphaAdmin))
        .send();
      expect(duplicated.status).toBe(201);
      const copy = duplicated.body as {
        id: string;
        revision: number;
        publicSlug: string;
      };
      // A row of its own with an address of its own — otherwise everything
      // that follows would be checking the original.
      expect(copy.id).not.toBe(form.id);
      expect(copy.publicSlug).not.toBe(form.publicSlug);

      const stored = await app().prisma.form.findUniqueOrThrow({
        where: { id: copy.id },
        select: { privacyNotice: true },
      });
      expect(stored.privacyNotice).toEqual(filledNotice());

      // And publicly the same notice. The copy is a draft (ADR-0028
      // no. 4: „Bestandsformulare bekommen nichts zurückgefüllt", and a
      // duplicate starts like a fresh form), so it is published
      // first — exactly the path that „Anmeldung 2027" takes.
      const published = await request(app().server)
        .post(apiPath(`/forms/${copy.id}/publish`))
        .set(authedMutation(alphaAdmin))
        .send({ revision: copy.revision });
      expect(published.status).toBe(200);

      const notice = await publicNotice(copy.publicSlug);
      expect(textOf(notice?.blocks ?? [])).toContain(
        'Anmeldung zur Jahrestagung 2026',
      );
    });

    /**
     * **Into the template drawer it does not travel.**
     *
     * Today that is secured **structurally**: `formTemplateFormContentSchema`
     * is a `z.strictObject` without `privacyNotice`, and `contentOf`
     * (`form-templates.service.ts`) builds the content field by field and
     * simply leaves it out. It is checked at the **column** anyway and not at
     * the schema: the promise reads „in `form_template.content` there is no
     * purpose", and that one still holds when someone swaps out the
     * construction underneath.
     *
     * The second expectation is the sharper one: it looks for the purpose
     * text in the whole serialised content, not only under the key under
     * which it would stand today.
     *
     * *Reproduction, measured in two steps:*
     *
     * 1. In `contentOf` (`form-templates.service.ts`) enter
     *    `privacyNotice: form.privacyNotice` into the `form` branch.
     *    `strictObject` throws, the route answers **500**, and the case goes
     *    red at `toBe(201)`.
     * 2. In addition, loosen `formTemplateFormContentSchema` to
     *    `z.looseObject`. Then the purpose stands in `form_template.content`,
     *    and the three expectations below go red.
     *
     * ⚠️ The intermediate step `z.object` is **not** a reproduction step and
     * was the surprise while measuring: a `z.object` in Zod 4 *removes*
     * unknown keys silently, so the notice does not reach the column at all
     * and this case rightly stays green. Whoever wants to break the promise
     * needs `looseObject` or a way past the validation — precisely
     * that is why this case measures the column and not the schema.
     */
    it('lässt den Hinweis nicht in die Vorlagenschublade wandern', async () => {
      const form = await createForm(alphaAdmin, 'Vorlage aus Formular');
      expect(
        (await writeNotice(alphaAdmin, form.id, filledNotice())).status,
      ).toBe(200);

      const saved = await request(app().server)
        .post(apiPath(`/forms/${form.id}/templates`))
        .set(authedMutation(alphaAdmin))
        .send({ kind: 'form', name: 'Tagungsanmeldung' });
      expect(saved.status).toBe(201);

      const stored = await app().prisma.formTemplate.findUniqueOrThrow({
        where: { id: (saved.body as { id: string }).id },
        select: { content: true },
      });
      expect(stored.content).not.toHaveProperty('privacyNotice');
      expect(JSON.stringify(stored.content)).not.toContain('Jahrestagung');
      expect(JSON.stringify(stored.content)).not.toContain('Art. 6 Abs. 1');
    });
  });

  /**
   * **The XSS channel** (ADR-0028 section 7) — the most likely error
   * of this undertaking, measured against what the server **delivers**.
   */
  describe('der XSS-Kanal', () => {
    it('liefert Markup als Text und niemals als Struktur aus', async () => {
      const form = await createForm(alphaAdmin, 'XSS');
      expect(
        (
          await writeNotice(alphaAdmin, form.id, {
            ...EMPTY_LEGAL_DOCUMENT,
            mode: 'custom',
            custom:
              '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\nZweck: Anmeldung',
          })
        ).status,
      ).toBe(200);

      const notice = await publicNotice(form.publicSlug);

      // Blocks with text runs: there is no field that could transport
      // markup, and `LegalText.tsx` has nothing it could hand to
      // `dangerouslySetInnerHTML`.
      expect(notice?.blocks).toEqual([
        {
          kind: 'paragraph',
          runs: [{ kind: 'text', text: '<script>alert(1)</script>' }],
        },
        {
          kind: 'paragraph',
          runs: [{ kind: 'text', text: '<img src=x onerror=alert(1)>' }],
        },
        {
          kind: 'paragraph',
          runs: [{ kind: 'text', text: 'Zweck: Anmeldung' }],
        },
      ]);
    });

    it('macht aus einem javascript:-Ziel sichtbaren Text statt eines Links', async () => {
      const form = await createForm(alphaAdmin, 'XSS-Link');
      expect(
        (
          await writeNotice(alphaAdmin, form.id, {
            ...EMPTY_LEGAL_DOCUMENT,
            mode: 'custom',
            custom:
              '[Mehr erfahren](javascript:alert(1)) und [//boese.example](//boese.example)',
          })
        ).status,
      ).toBe(200);

      const notice = await publicNotice(form.publicSlug);
      const links = (notice?.blocks ?? []).flatMap((block) =>
        block.kind === 'paragraph'
          ? block.runs.filter((run) => run.kind === 'link')
          : [],
      );

      expect(links).toEqual([]);
      expect(textOf(notice?.blocks ?? [])).toContain('javascript:alert(1)');
    });

    /**
     * Control characters fall away **at the column** already — the first of
     * the two gates (ADR-0028 section 7 no. 5). It is checked at the row and
     * not at the response, because that is precisely the promise: what never
     * reaches the column cannot stand in any future output.
     */
    it('nimmt Steuer- und Bidi-Zeichen schon an der Spalte weg', async () => {
      const form = await createForm(alphaAdmin, 'Steuerzeichen');
      expect(
        (
          await writeNotice(alphaAdmin, form.id, {
            ...EMPTY_LEGAL_DOCUMENT,
            mode: 'custom',
            custom: 'Zweck‮Anmeldung',
          })
        ).status,
      ).toBe(200);

      const stored = await app().prisma.form.findUniqueOrThrow({
        where: { id: form.id },
        select: { privacyNotice: true },
      });
      expect(stored.privacyNotice).toMatchObject({
        custom: 'ZweckAnmeldung',
      });
    });
  });

  /**
   * **The legacy case.** A form that was created before this column
   * behaves exactly as before: no additional section, no
   * invented purpose, and the settings page opens.
   *
   * The `INSERT` names **only the columns that existed back then**, because a
   * way through the API would prove nothing — the API writes the new column.
   */
  describe('Formulare, die es vor dieser Spalte schon gab', () => {
    async function legacyForm(title: string): Promise<{
      id: string;
      publicSlug: string;
    }> {
      const id = randomUUID();
      const publicSlug = randomBytes(16).toString('base64url');
      await app().prisma.$executeRawUnsafe(
        `INSERT INTO "form" (
           "id", "tenant_id", "title", "status", "draft_schema", "public_slug",
           "revision", "created_at", "updated_at"
         ) VALUES (
           $1::uuid, $2::uuid, $3, 'draft'::"form_status", $4::jsonb, $5,
           1, now(), now()
         )`,
        id,
        alpha.id,
        title,
        JSON.stringify(definition()),
        publicSlug,
      );
      return { id, publicSlug };
    }

    it('meldet „nichts hinterlegt" statt zu scheitern', async () => {
      const form = await legacyForm('Bestand');

      const read = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));

      expect(read.status).toBe(200);
      expect(
        (read.body as { privacyNotice: LegalDocument }).privacyNotice,
      ).toEqual(EMPTY_LEGAL_DOCUMENT);
    });

    /**
     * An unreadable row must not take the **form** down: a fill-out path
     * that answers 500 because of a broken JSONB would be the most
     * expensive conceivable failure of this feature.
     */
    it('liest eine kaputte Spalte als „nichts hinterlegt"', async () => {
      const form = await createForm(alphaAdmin, 'Kaputt');
      await app().prisma.$executeRawUnsafe(
        `UPDATE "form" SET "privacy_notice" = '{"mode":"unsinn"}'::jsonb WHERE "id" = $1::uuid`,
        form.id,
      );

      expect(await publicNotice(form.publicSlug)).toBeNull();

      const read = await request(app().server)
        .get(apiPath(`/forms/${form.id}/settings`))
        .set('Cookie', cookieHeader(alphaAdmin));
      expect(read.status).toBe(200);
    });
  });

  /**
   * **The hint before publishing** (ADR-0028 no. 4) — and the reason
   * why it hangs on the preview and not on the settings document: the
   * preview stands behind `can_build`, that is, behind the permission that
   * publishes. Precisely the person who may **not** write the text
   * learns here that it is missing.
   */
  describe('die Ampel vor dem Veröffentlichen', () => {
    it('sagt `empty`, solange nichts hinterlegt ist — auch der Person ohne das Schreibrecht', async () => {
      const form = await createForm(alphaAdmin, 'Ampel leer');

      const preview = await request(app().server)
        .get(apiPath(`/forms/${form.id}/publish-preview`))
        .set('Cookie', cookieHeader(withoutFormSettings));

      expect(preview.status).toBe(200);
      expect((preview.body as { privacyNotice: string }).privacyNotice).toBe(
        'empty',
      );
      /*
        **The preview is frugal — it is not a bolt** (review finding of
        2026-08-18).

        This used to read „a traffic light, never the text: the preview does
        not hand out the legal text", and that read like a promise about
        secrecy. There is no such promise and there is not meant to be one:
        the notice stands, as intended, on the public fill-out page, and
        `GET /api/public/forms/:slug` delivers it without any login. Whoever
        holds `can_build` knows the `publicSlug` through `GET /api/forms/:id`
        anyway — so this case would prove nothing about protection.

        What it actually measures and what is also true: the response of
        **this** route does not carry the text along. That keeps it small and
        its shape unambiguous; a field that carried sometimes the traffic
        light and sometimes the whole document would be a contract with two
        shapes.
      */
      expect(
        preview.text,
        'Die Vorschau-Antwort bleibt bei der Ampel — nicht weil der Text ' +
          'geheim wäre, sondern damit dieser Vertrag eine Gestalt hat.',
      ).not.toContain('Jahrestagung');
    });

    it('sagt `incomplete` für eine angefangene und `ready` für eine fertige Fassung', async () => {
      const form = await createForm(alphaAdmin, 'Ampel Rest');

      expect(
        (
          await writeNotice(alphaAdmin, form.id, {
            ...EMPTY_LEGAL_DOCUMENT,
            fills: { ZWECK: 'Anmeldung' },
          })
        ).status,
      ).toBe(200);
      const half = await request(app().server)
        .get(apiPath(`/forms/${form.id}/publish-preview`))
        .set('Cookie', cookieHeader(withoutFormSettings));
      expect((half.body as { privacyNotice: string }).privacyNotice).toBe(
        'incomplete',
      );

      expect(
        (await writeNotice(alphaAdmin, form.id, filledNotice())).status,
      ).toBe(200);
      const full = await request(app().server)
        .get(apiPath(`/forms/${form.id}/publish-preview`))
        .set('Cookie', cookieHeader(withoutFormSettings));
      expect((full.body as { privacyNotice: string }).privacyNotice).toBe(
        'ready',
      );
    });
  });
});

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  EMPTY_TENANT_LEGAL_PAGES,
  parseStoredTenantLegalPages,
  renderLegalPage,
  SYSTEM_LEGAL_TEMPLATES,
  TENANT_LEGAL_TEMPLATES,
  type PublicLegalFooter,
  type PublicLegalPage,
  type SystemLegalPage,
  type TenantLegalPage,
} from '@formsache/shared';

import { PrismaService } from '../prisma/prisma.service';
import { SystemLegalService } from '../system-settings/system-legal.service';

/**
 * **The legal texts, delivered to somebody without an account** (ADR-0028).
 *
 * ## Why these pages *must* be public
 *
 * Because participants have no account (data minimization), and because the
 * point in time is part of the obligation: Art. 13 Abs. 1 DSGVO says „zum Zeitpunkt der
 * Erhebung", § 18 Abs. 1 MStV requires „leicht erkennbar, unmittelbar
 * erreichbar und ständig verfügbar". A legal text behind a login is
 * no legal text.
 *
 * ## What takes the place of the guard chain
 *
 * The same as with the fill-in routes next door, with one difference and one
 * thing in common:
 *
 * - **In common:** a rate limit per address (`public-legal.controller.ts`)
 *   and a 404 that gives away nothing about the existence of anything.
 * - **Different:** the key here is **no access credential**. A
 *   form slug is CSPRNG and must not be guessed; `short_name` is
 *   a name, stands in the footer of every page of this organization and is
 *   there to be written down. Exactly for that reason the
 *   organization pages live under `/o/<kurzname>/…` and not under
 *   `/f/<slug>/privacy` (`docs/legal/README.md` 5.2): a legal document
 *   under a non-guessable address contradicts „ständig verfügbar".
 *
 * ## What does **not** go out
 *
 * Neither the stored document nor the template — only the **result**.
 * The server renders (`renderLegalPage`), and the browser gets blocks.
 * The same division that `availabilityOf()` draws for the availability of a
 * form, and the same yield: the promise "a `[[PLATZHALTER]]`
 * never leaves the application" is a property of the server and not a
 * request to the client.
 */
@Injectable()
export class PublicLegalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly legal: SystemLegalService,
  ) {}

  /**
   * What the footer knows about the installation — its name, and nothing else.
   *
   * ⚠️ **Seit Review-Runde 4 Nr. 4 ist das wirklich nur noch ein Feld.** Das
   * zweite hieß `accessibilityDeclared` und entschied, ob der Verweis auf die
   * Erklärung zur Barrierefreiheit in der Fußzeile steht. Die Erklärung ist
   * ersatzlos gestrichen, und damit auch die Bedingung — Impressum und
   * Datenschutzerklärung treffen jeden Betreiber und werden deshalb immer
   * verlinkt, auch wenn nichts hinterlegt ist: ein fehlendes Impressum ist mit
   * oder ohne Verweis ein Verstoß, und **nur mit Verweis ist er behebbar**
   * (`docs/legal/README.md` 5.4).
   *
   * Der Zuschnitt bleibt trotzdem eine eigene, winzige öffentliche Route und
   * kein Feld an jeder Ausfüll-Antwort: die Fußzeile steht unter sechs
   * verschiedenen Ansichten mit fünf verschiedenen Nutzlasten.
   */
  async footer(): Promise<PublicLegalFooter> {
    return { installationName: await this.legal.operatorName() };
  }

  /** A legal text page of the **installation**. */
  async systemPage(page: SystemLegalPage): Promise<PublicLegalPage> {
    const [{ pages }, operatorName, aiActive] = await Promise.all([
      this.legal.read(),
      this.legal.operatorName(),
      this.legal.aiActive(),
    ]);

    const rendered = renderLegalPage(
      SYSTEM_LEGAL_TEMPLATES[page],
      pages[page],
      {
        organisationName: null,
        organisationShortName: null,
        operatorName,
        aiActive,
        // No form and therefore no redirect: this is a page of the
        // installation, and „wohin leitet es weiter" is a question about one
        // form (ADR-0028 no. 5). None of these three templates asks it.
        redirectTarget: null,
      },
      // **Fremde lesen hier mit**, also entfallen die Zeilen mit einer offenen
      // Angabe (Review-Runde 5 Nr. 1). Der Zustand der Seite bleibt der
      // Verwaltung vorbehalten und reist gar nicht mehr mit
      // (`publicLegalPageSchema`).
      'public',
    );

    return {
      title: rendered.title,
      blocks: [...rendered.blocks],
      owner: { kind: 'installation', name: operatorName },
    };
  }

  /**
   * A legal text page of an **organization**, via its short name.
   *
   * ⚠️ **The only access of this application that finds an organization via
   * its name without anybody being logged in.** It is limited to the
   * two columns the page needs, plus name and short name for
   * the caption — in particular **no** mail configuration, no OIDC
   * secret, no form defaults.
   *
   * ## A deleted organization stays reachable here — as the only one
   *
   * Until 2026-08-18 a `deletedAt: null` stood here, "the same rule as
   * on the fill-in path next door". This route now **deliberately** departs
   * from that, and the departure is the purpose of the page:
   *
   * Whoever has filled in a form of this organization needs two pieces of
   * information afterwards, and **precisely then**, when the organization no
   * longer works — who was responsible (§ 5 TMG) and how they exercise their
   * rights (Art. 13, 15 ff. DSGVO). `TENANT_LEGAL_PAGES` are exactly these
   * two, `imprint` and `privacy`; there is no third page here that would
   * accidentally stand open along with them.
   *
   * **The fill-in path stays closed**, and that is no contradiction: there it
   * would be about *taking in* new data, here about giving information about
   * data already taken in. A form of a deleted
   * organization still answers 404.
   *
   * **For how long?** Exactly as long as the row still exists. The
   * 30-day run (`retention-purge.service.ts`) deletes it physically, and
   * afterwards this `findFirst` finds nothing any more — the deadline
   * therefore stands nowhere a second time, it *is* the lifetime of the row. A
   * date calculation of its own here would be the second truth that at some
   * point diverges from the first.
   *
   * Nothing is given away by this that would not have to be public anyway:
   * an imprint is by law „ständig verfügbar" (§ 18 MStV), and
   * the two columns carry the details of the operation, not those of the
   * participants.
   */
  async tenantPage(
    shortName: string,
    page: TenantLegalPage,
  ): Promise<PublicLegalPage> {
    // **No `deletedAt: null`** — see the block above this method. The
    // lifetime of the row is the deadline.
    const tenant = await this.prisma.tenant.findFirst({
      where: { shortName },
      select: { name: true, shortName: true, legalPages: true },
    });
    if (tenant === null) {
      // The same 404 as for an invented short name. It now only hits
      // the organization that **really does not exist any more** — after the
      // 30-day run or never.
      throw new NotFoundException('Diese Seite gibt es nicht.');
    }

    const [operatorName, aiActive] = await Promise.all([
      this.legal.operatorName(),
      this.legal.aiActive(),
    ]);

    const pages =
      tenant.legalPages === null
        ? EMPTY_TENANT_LEGAL_PAGES
        : parseStoredTenantLegalPages(tenant.legalPages);

    const rendered = renderLegalPage(
      TENANT_LEGAL_TEMPLATES[page],
      pages[page],
      {
        organisationName: tenant.name,
        organisationShortName: tenant.shortName,
        operatorName,
        aiActive,
        // An organisation has no single redirect target — several forms have
        // several. Its `⟪WENN:weiterleitung⟫` block therefore names none and
        // is answered by a human; the address stands in the notice of the
        // form it belongs to (ADR-0028 no. 5).
        redirectTarget: null,
      },
      // Dieselbe Zielgruppe wie oben, aus demselben Grund.
      'public',
    );

    return {
      title: rendered.title,
      blocks: [...rendered.blocks],
      owner: { kind: 'organisation', name: tenant.name },
    };
  }
}

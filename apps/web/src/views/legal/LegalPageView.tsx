import type { ReactElement } from 'react';
import type {
  PublicLegalPage,
  SystemLegalPage,
  TenantLegalPage,
} from '@formsache/shared';
import type { UseQueryResult } from '@tanstack/react-query';

import {
  usePublicSystemLegalPage,
  usePublicTenantLegalPage,
} from '../../api/legal';
import { ApiError } from '../../api/http';
import { PublicLegalFooter } from '../../fill/PublicLegalFooter';
import { LegalText } from './LegalText';

import './legal.css';

/**
 * A legal-text page, **without signing in** (ADR-0028).
 *
 * Outside the shell and before the session check, like the fill-out address and
 * the two participant addresses — and for an even sharper reason than
 * those: § 18 Abs. 1 MStV demands „ständig verfügbar", Art. 13 Abs. 1 DSGVO
 * „zum Zeitpunkt der Erhebung". A sign-in mask in front of an imprint would be
 * no imprint.
 *
 * **Nothing is decided here.** The server has rendered; what arrives are blocks
 * and the label saying whom the page belongs to. This view displays it, and the
 * only state it knows is „lädt", „ging schief" and „da".
 *
 * ⚠️ **Auch nicht, ob die Seite fertig ist** (Review-Runde 5 Nr. 1). Offene
 * Angaben und der Hinweis darauf gehören der Verwaltung; hierher reisen sie
 * nicht mehr mit ({@link LegalAudience} in `packages/shared/src/legal.ts`).
 */
export function SystemLegalPageView({
  page,
}: {
  readonly page: SystemLegalPage;
}): ReactElement {
  return <LegalPage query={usePublicSystemLegalPage(page)} />;
}

export function TenantLegalPageView({
  shortName,
  page,
}: {
  readonly shortName: string;
  readonly page: TenantLegalPage;
}): ReactElement {
  return (
    <LegalPage
      query={usePublicTenantLegalPage(shortName, page)}
      shortName={shortName}
    />
  );
}

function LegalPage({
  query,
  shortName,
}: {
  readonly query: UseQueryResult<PublicLegalPage>;
  readonly shortName?: string;
}): ReactElement {
  if (query.isPending) {
    return (
      <main className="legal" role="status">
        <p className="legal__state">Seite wird geladen…</p>
      </main>
    );
  }

  if (query.data === undefined) {
    const gone = query.error instanceof ApiError && query.error.status === 404;
    return (
      <main className="legal">
        <p className="legal__state" role="alert">
          {gone
            ? 'Diese Seite gibt es nicht.'
            : 'Die Seite konnte nicht geladen werden. Bitte später erneut versuchen.'}
        </p>
        {/*
          The footer stands **here too**. Whoever lands on a broken
          legal-text page needs the way to the others most urgently
          — and the link is exactly what makes the defect fixable instead of
          leaving it invisible (`docs/legal/README.md` 5.4).
        */}
        <PublicLegalFooter
          {...(shortName === undefined ? {} : { organisation: { shortName } })}
        />
      </main>
    );
  }

  const page = query.data;

  return (
    <main className="legal">
      <article className="legal__card">
        <p className="legal__owner">
          {page.owner.kind === 'organisation'
            ? 'Verantwortlich für dieses Formular'
            : 'Betrieb dieser Plattform'}
          {page.owner.name === null ? '' : `: ${page.owner.name}`}
        </p>
        <h1 className="legal__title">{page.title}</h1>

        {/*
          **Hier stand der Warnhinweis „Diese Angaben sind unvollständig."**
          Er ist mit Review-Runde 5 Nr. 1 entfallen, und zwar zusammen mit den
          markierten Lücken im Text: was hier unvollständig ist, sieht seitdem
          die verantwortliche Stelle in ihrer Verwaltung, nicht der Fremde auf
          dieser Seite. Die Ansicht *könnte* ihn auch nicht mehr zeigen — der
          Zustand reist nicht mehr mit (`publicLegalPageSchema`), und genau so
          ist die Zusicherung gemeint: nicht als Bedingung, die jemand
          zurückdreht, sondern als Feld, das es nicht gibt.
        */}

        <div className="legal-text">
          <LegalText blocks={page.blocks} />
        </div>
      </article>

      <PublicLegalFooter
        {...(shortName === undefined ? {} : { organisation: { shortName } })}
      />
    </main>
  );
}

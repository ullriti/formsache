import { expect, test } from '@playwright/test';

import {
  expectNoHorizontalScroll,
  expectSideScrollerReachable,
} from './app-flows';
import { authStateFile } from './seed-account';

/**
 * The e-mail dispatch log at 360 px — the mobile half of the requirement
 * that was named as a gap: „**Antworten-Tabelle
 * und Versandprotokoll haben keine 360-px-Zusicherung** — beide klippen
 * (`overflow: auto`), und ihre Specs rufen den Helfer nicht auf."
 *
 * ## The finding that arose while making up the arrears
 *
 * The helper alone would **not** have closed the gap.
 * `expectNoHorizontalScroll` measures the root, `<main>` and every box that
 * *clips* — and expressly excludes boxes with `overflow: auto`/`scroll`
 * (the comment at its third measurement names the reason and the case at which
 * it was decided). `.mail-log__table-scroll` is exactly such a box. For
 * this view's table the helper therefore cannot go red: „die Seite
 * scrollt nicht" would be green even if the content were cut off and
 * unreachable.
 *
 * It stays here all the same, and it does measure something: header, KPI tiles,
 * filter notice, row counter and the frame of the card all lie **outside**
 * the scrolling box — that is the part of the view that has to wrap at 360 px
 * instead of jutting out. What it cannot do is said by
 * {@link expectSideScrollerReachable} beside it.
 *
 * ## Why `page.route`, and why these rows
 *
 * The same shape as `trash-mobile.spec.ts` and
 * `superadmin-deleted-tenants-mobile.spec.ts`: no write, no
 * residue — and, more importantly here, a **guaranteed wide** table. A
 * measurement „das rechte Ende ist erreichbar" is only a measurement if there
 * is a right-hand end outside the picture; a real run would have left it to
 * chance which addresses and subjects happen to stand in the log.
 * This view's four columns are fixed (`MailLogView.tsx`), the width
 * comes from their content — so it stands here, long and named.
 *
 * ⚠️ **The price of this stub, paid once and recorded here.** It
 * is a **second writer** of the wire contract of `mailLogEntrySchema`,
 * and `mailLogListResponseSchema` is a `strictObject`: when a later
 * change added `replyTo` to the entry („die wirksame Antwortadresse
 * ist im Produkt sichtbar"), the parse here fell through — the view stayed in the
 * error state, the `<h1>` never appeared, and the case was **red without
 * anybody having to run it** to break it. It was only seen
 * later at the first full `pnpm e2e`, and the first guess
 * („liegt an der Paginierung", which touched the view at the same time) was
 * wrong. Measured, not guessed: the payload document sent once through
 * `parseMailLogList`, and Zod named the field.
 *
 * **Whoever extends `mailLogEntrySchema` extends this stub with it** — or
 * accepts that exactly the mobile case that carries the only
 * measurement „das rechte Ende der Tabelle ist erreichbar" fails silently.
 *
 * ## A second incident, same symptom, different cause
 *
 * The `<h1>` went missing a second time, and again without a schema change in
 * sight. This one was the mock's own `page.route` pattern: `'**\/api/mail-log*'`
 * (a glob, its trailing `*` matching any suffix without a `/`) also matches
 * this application's own client module, requested by the dev server as
 * `/src/api/mail-log.ts?t=…` — the substring `/api/mail-log` sits in that path
 * too. Once that request landed on this stub instead of on Vite, it came back
 * `application/json` where the browser demanded a JS module, the import
 * failed, and `MailLogView.tsx` never rendered. The route below is now a
 * `RegExp` anchored to the end of the path for exactly this reason — read the
 * comment beside it before loosening it back into a glob.
 */

test.use({ storageState: authStateFile });
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true });

const MAIL_LOG_PATH = '/mail-log';

/** An unreachable address (RFC 2606), as long as a real long one. */
const LONG_RECIPIENT =
  'vorsitzender.des.veranstaltungsausschusses@sehr-langer-organisationsname.example.invalid';
const LONG_SUBJECT =
  'Ihre Anmeldung zum Jahrestreffen 2026 in Musterstadt — Bestätigung und Zimmerwunsch';

const ROW_ID = '00000000-0000-4000-8000-00000000c001';
const SECOND_ROW_ID = '00000000-0000-4000-8000-00000000c002';

test.describe('Versandprotokoll (360 px)', () => {
  test('passt bei 360 px, und die Tabelle reicht ihre letzte Spalte heraus statt sie abzuschneiden', async ({
    page,
  }) => {
    /*
     * A `RegExp`, not the glob `'**\/api/mail-log*'` this stub used to carry.
     *
     * That glob's trailing `*` matches *any* suffix without a `/` in it —
     * including `.ts?t=…`. In dev mode the browser also requests this
     * application's own client module at `/src/api/mail-log.ts`
     * (`apps/web/src/api/mail-log.ts`, Vite's cache-busting query attached),
     * and that request's path contains the very substring `/api/mail-log` the
     * glob was written to catch. Once that module request lands on this
     * route instead of the dev server, it is answered with
     * `application/json` where the browser demanded a JS module — a MIME
     * mismatch that fails the import, and with it every hook this view
     * calls, before the first render. Anchoring to the end of the path (an
     * optional query string, then end of string) leaves the real
     * `/api/mail-log` and `/api/mail-log?status=…` calls matched and stops
     * matching `/src/api/mail-log.ts` at all.
     */
    await page.route(/\/api\/mail-log(\?.*)?$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            {
              id: ROW_ID,
              createdAt: '2026-07-20T10:00:00.000Z',
              sentAt: null,
              recipient: LONG_RECIPIENT,
              subject: LONG_SUBJECT,
              notificationName: 'Anmeldung an das Sekretariat',
              formId: null,
              status: 'failed',
              attempts: 3,
              lastError:
                'Der Empfänger konnte aus dieser Antwort nicht gelesen werden.',
              nextAttemptAt: null,
              senderIdentity: 'system',
              senderAddress: 'noreply@example.org',
              replyTo: null,
              trigger: 'submit',
            },
            {
              id: SECOND_ROW_ID,
              createdAt: '2026-07-20T11:00:00.000Z',
              sentAt: '2026-07-20T11:00:04.000Z',
              recipient: 'kurz@example.invalid',
              subject: 'Kopie der Anmeldung',
              notificationName: 'Kopie an die zweite Adresse',
              formId: null,
              status: 'sent',
              attempts: 1,
              lastError: null,
              nextAttemptAt: null,
              senderIdentity: 'own',
              senderAddress: 'buero@musterstadt.example',
              replyTo: 'buero@musterstadt.example',
              trigger: 'submit',
            },
          ],
          counts: { total: 2, sent: 1, failed: 1, queued: 0 },
        }),
      });
    });

    await page.goto(MAIL_LOG_PATH);
    await expect(
      page.getByRole('heading', { level: 1, name: 'E-Mail-Versandprotokoll' }),
    ).toBeVisible();
    await expect(page.getByTestId(`mail-log-row-${ROW_ID}`)).toBeVisible();

    // The frame of the view — everything that does **not** lie in the scrolling box.
    await expectNoHorizontalScroll(page, 'Versandprotokoll (360 px, geladen)');

    /*
     * And the table itself. „Status" is the last of the four columns
     * (`MailLogView.tsx`), that is, the right-hand end that has to be reachable —
     * without it there would be no reading off whether a row has failed, and that
     * is exactly what one calls up this log for.
     */
    await expectSideScrollerReachable(
      page,
      page.locator('.mail-log__table-scroll'),
      page.getByRole('columnheader', { name: 'Status' }),
      'Versandprotokoll-Tabelle (360 px)',
    );

    /*
     * The KPI tiles are filters (the specification) and have to be operable with the
     * **finger** — the path only this project drives; `mail-log.spec.ts`
     * runs in desktop Chrome without touch. The width is measured once more
     * afterwards, because a filter change re-sets the tiles (`placeholderData`
     * keeps the old answer on the screen) and that is a layout situation of its own.
     */
    await page.getByTestId('kpi-failed').tap();
    await expect(page.getByTestId('kpi-failed')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectNoHorizontalScroll(
      page,
      'Versandprotokoll (360 px, nach „Fehlgeschlagen")',
    );
  });
});

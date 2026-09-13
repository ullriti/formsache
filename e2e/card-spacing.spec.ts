import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * **Die Abstände der alleinstehenden Karten — gemessen, nicht behauptet**
 * (Review-Runde 3 Nr. 4).
 *
 * ## Der Befund, den diese Datei nachstellt
 *
 * „Passwort setzen Dialoge haben keine margins — Frontend agent sollte das
 * durch Screenshots oder so sicherstellen."
 *
 * Er stimmte, und er war unsichtbar für alles, was diese Suite bis dahin
 * konnte. `PasswordResetView` setzte seine beiden Felder und den Knopf
 * **direkt** in `login__body`. Der Abstand dieser Ansicht ist aber keine
 * Eigenschaft der Ansicht, sondern der `gap` von `.login__form` — wer nicht
 * darin steht, bekommt ihn nicht. Beschriftung, Feld, zweites Feld und Knopf
 * klebten aneinander, während die Anmeldung eine Tür weiter richtig aussah.
 *
 * Nichts davon war rot: der Axe-Lauf prüft Rollen und Kontraste, die
 * Einheitstests prüfen das Markup, und ein `--space-5`, das nirgends greift,
 * steht trotzdem korrekt in der Token-Datei.
 *
 * ## Warum gemessen und nicht abgebildet
 *
 * Ein Screenshot-Vergleich wäre die naheliegende Antwort auf „durch
 * Screenshots sicherstellen" und die schlechtere: er wird von jeder
 * Schriftauslieferung, jeder Farbanpassung und jeder Browser-Fassung rot, und
 * ein Team, das ein Referenzbild dreimal blind neu schreibt, hat den Test
 * verloren. Gemessen wird deshalb **das, was der Befund benennt** — der
 * senkrechte Abstand zwischen zwei aufeinanderfolgenden Blöcken —, und zwar
 * am gerenderten Kasten (`boundingBox`), also durch die ganze Kaskade
 * hindurch. Dieselbe Bauform wie `rendered-contrast.spec.ts`: der Bildschirm
 * ist der Zeuge, nicht die Token-Datei.
 *
 * ## Warum eine Untergrenze und keine feste Zahl
 *
 * Eine feste Zahl wäre die Token-Datei ein zweites Mal, nur schlechter
 * gepflegt. Behauptet wird die Eigenschaft, um die es geht: **zwischen zwei
 * Blöcken steht Luft**, und zwar mehr als der Zeilenabstand, den ein
 * zusammengeklebtes Layout zufällig auch hat. `MIN_GAP` ist bewusst kleiner
 * als das kleinste vorkommende `--space-*` dieser Ansichten (16 px), damit
 * eine Verkleinerung der Abstände erlaubt bleibt und ein Verschwinden nicht.
 */

/**
 * Die Untergrenze in CSS-Pixeln.
 *
 * Der Zustand, den diese Datei ausschließt, ist `gap: 0` — dort ist der
 * gemessene Abstand exakt 0. Alles, was die Anwendung tatsächlich setzt, liegt
 * bei 16 px und darüber. 8 px liegt dazwischen und lässt damit eine
 * Gestaltungsentscheidung zu, ohne den Befund wieder einzulassen.
 */
const MIN_GAP = 8;

/** Der senkrechte Zwischenraum zwischen zwei Blöcken, wie er gerendert wird. */
async function gapBetween(above: Locator, below: Locator): Promise<number> {
  const top = await above.boundingBox();
  const bottom = await below.boundingBox();
  expect(top, 'Der obere Block wird nicht dargestellt.').not.toBeNull();
  expect(bottom, 'Der untere Block wird nicht dargestellt.').not.toBeNull();
  if (top === null || bottom === null) {
    throw new Error('unerreichbar — die Zusicherungen oben brechen vorher ab');
  }
  return bottom.y - (top.y + top.height);
}

/**
 * Die Felder und der Knopf einer alleinstehenden Karte stehen nicht
 * aneinander.
 *
 * Gemessen wird paarweise über **alle** direkten Kinder der Karte, nicht nur
 * über die zwei, an denen der Befund auffiel: der nächste Block, den jemand
 * hinzufügt, ist sonst wieder der ungeprüfte.
 */
async function expectSpacedCard(page: Page, heading: string): Promise<void> {
  const body = page.locator('.login__body');
  await expect(body).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 1, name: heading }),
  ).toBeVisible();

  /*
    Die *Blöcke* der Karte, nicht ihre Kinder: gesucht sind die Kästen, die
    untereinander stehen — Absätze, Felder, Knöpfe —, gleich ob sie direkt in
    `login__body` oder in dem `login__form` darin liegen. Ein Kommentarknoten
    hat keinen Kasten und taucht hier nicht auf.
  */
  const blocks = body.locator(
    ':scope > *, :scope > .login__form > *, :scope > form > *',
  );
  const count = await blocks.count();
  expect(
    count,
    `${heading}: Die Karte hat zu wenige Blöcke zum Messen.`,
  ).toBeGreaterThan(2);

  for (let index = 1; index < count; index += 1) {
    const above = blocks.nth(index - 1);
    const below = blocks.nth(index);
    // Ein Block, der die Zeile mit seinem Vorgänger teilt, hat keinen
    // senkrechten Abstand und ist auch keiner gemeint — hier steht alles
    // untereinander, aber die Bedingung gehört trotzdem hin, damit ein
    // späteres nebeneinander stehendes Paar nicht falsch rot wird.
    const top = await above.boundingBox();
    const bottom = await below.boundingBox();
    if (top === null || bottom === null) {
      continue;
    }
    if (bottom.y < top.y + top.height) {
      continue;
    }
    const gap = await gapBetween(above, below);
    expect(
      gap,
      `${heading}: Zwischen Block ${String(index)} und ${String(index + 1)} ` +
        `stehen nur ${gap.toFixed(1)} px. Ein Feld, das direkt in ` +
        '`login__body` steht statt in `login__form`, bekommt dessen `gap` ' +
        'nicht — genau das war der Befund.',
    ).toBeGreaterThanOrEqual(MIN_GAP);
  }
}

/*
  Sitzungslos, und das ist keine Nachlässigkeit: wer sein Passwort setzt, ist
  gerade *nicht* angemeldet. Das Merkzeichen ist frei erfunden — die Ansicht
  zeigt ihr Formular für jedes und beantwortet „kenne ich das?" erst beim
  Absenden (dieselbe Begründung wie in `a11y/views.ts`).
*/
test.use({ storageState: { cookies: [], origins: [] } });

test('Die Anmeldung hat Abstände zwischen ihren Blöcken', async ({ page }) => {
  await page.goto('/');
  await expectSpacedCard(page, 'Formsache');
});

test('„Neues Passwort vergeben" hat Abstände', async ({ page }) => {
  await page.goto('/password/ein-erfundenes-merkzeichen');
  await expectSpacedCard(page, 'Neues Passwort vergeben');
});

test('Die Einladung hat Abstände', async ({ page }) => {
  await page.goto('/invitation/ein-erfundenes-merkzeichen');
  await expectSpacedCard(page, 'Willkommen bei Formsache');
});

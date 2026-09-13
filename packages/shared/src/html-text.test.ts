import { describe, expect, it } from 'vitest';

import {
  collapseWhitespace,
  escapeHtml,
  isSingleLineText,
  neutraliseHtml,
  stripMarkup,
} from './html-text.ts';

/**
 * **The two bolts against a foreign value in the body of a system mail**
 * (ADR-0026) — and the three functions that existed before.
 *
 * The finding: `escapeHtml`/`neutraliseHtml` cover the **HTML** version of a
 * mail, `stripMarkup` the text version against *markup* — against a
 * line break neither of them covers anything, because in `text/plain` a `\n`
 * is not a character but a new line. Exactly out of that arose the way over
 * which a holder of `can_manage_users` could send an SPF/DKIM-signed mail of
 * the installation with self-written lines to a self-chosen
 * mailbox.
 *
 * The cases below therefore measure both in one file: that the predicate
 * **refuses** the value at the place it comes into being and that the folding
 * **defuses** it in the body, in case it got into the column some other way.
 */
describe('einzeiliger Fremdtext (ADR-0026)', () => {
  /** The name from the finding, character for character. */
  const ATTACK =
    'Max\n\nDein Zugang läuft ab. Jetzt bestätigen: https://boese.example\n\n—';

  describe('isSingleLineText — der Riegel am Entstehungsort', () => {
    it('nimmt sichtbaren Text samt Umlauten, Zeichen und Leerzeichen', () => {
      for (const value of [
        'Maria Muster',
        'Ortsgruppe Musterstadt e. V.',
        'Mit dem Vereinskonto anmelden',
        'Renée O’Brien-Škoda',
        '日本語の名前',
      ]) {
        expect(isSingleLineText(value)).toBe(true);
      }
    });

    it('weist jedes Steuerzeichen ab, mit dem sich eine Zeile erzeugen lässt', () => {
      for (const value of [
        ATTACK,
        'Max\nMuster',
        'Max\r\nMuster',
        'Max\tMuster',
        'Max\u{0}Muster',
        // C1: `\u{85}` is NEL and is read as a break by some displays —
        // which is why the whole block `\p{Cc}` falls and not only `\n`.
        'Max\u{85}Muster',
      ]) {
        expect(isSingleLineText(value)).toBe(false);
      }
    });

    /**
     * Invisible format characters fall too, and that is no extra: a bidi mark
     * reorders a **displayed** line („Trojan Source"), which is exactly the
     * property this rule defends for the mail.
     */
    it('weist unsichtbare Formatzeichen ab — Bidi-Marken, ZWSP, BOM', () => {
      for (const value of [
        'Max\u{202E}Muster',
        'Max\u{200B}Muster',
        'Max\u{FEFF}Muster',
        'Max\u{200C}Muster',
      ]) {
        expect(isSingleLineText(value)).toBe(false);
      }
    });
  });

  describe('collapseWhitespace — der Riegel vor dem Einsetzen', () => {
    /**
     * **The promise in one line**: what goes in comes out as *one* line.
     * That is the property the mail hangs on — the rest
     * (legibility) is comfort.
     */
    it('macht aus jedem Angriffsnamen eine einzige Zeile', () => {
      const folded = collapseWhitespace(ATTACK);
      expect(folded.split('\n')).toHaveLength(1);
      expect(folded).toBe(
        'Max Dein Zugang läuft ab. Jetzt bestätigen: https://boese.example —',
      );
    });

    it('faltet zusammen statt zu entfernen — der Name bleibt lesbar', () => {
      // „MaxMustermann" would be the silent corruption of data that mere
      // throwing away would produce.
      expect(collapseWhitespace('Max\nMustermann')).toBe('Max Mustermann');
      expect(collapseWhitespace('  Max   Muster  ')).toBe('Max Muster');
    });

    it('wirft unsichtbare Zeichen weg, statt sie zu Abständen zu machen', () => {
      expect(collapseWhitespace('Max\u{200B}Muster')).toBe('MaxMuster');
      expect(collapseWhitespace('Max\u{202E}Muster')).toBe('MaxMuster');
    });

    it('lässt einen bereits einzeiligen Wert unangetastet', () => {
      for (const value of ['Maria Muster', 'Ortsgruppe Musterstadt e. V.']) {
        expect(collapseWhitespace(value)).toBe(value);
        expect(isSingleLineText(value)).toBe(true);
      }
    });

    /**
     * The connection of the two bolts, written as a property: **what has been
     * folded passes the predicate.** Without this case the two alphabets could
     * drift apart without any check seeing it.
     */
    it('liefert immer einen Wert, den `isSingleLineText` annimmt', () => {
      for (const value of [ATTACK, 'Max\r\n\tMuster', 'a\u{0}\u{202E}b']) {
        expect(isSingleLineText(collapseWhitespace(value))).toBe(true);
      }
    });

    /**
     * The one outcome a caller has to handle — see
     * `mailSafeTenantName` in `account-invitation-mail.ts`, which turns it back
     * into `null` instead of writing `Organisation „"`.
     */
    it('kann leer werden, wenn nichts Sichtbares übrig bleibt', () => {
      expect(collapseWhitespace('\n\t \u{200B}')).toBe('');
    });
  });

  /**
   * **Why the two new functions were necessary** — the three old ones do not
   * cover the text version against a line break, and this case records that
   * instead of claiming it.
   */
  it('zeigt, dass Escapen und Markup-Entfernen den Umbruch durchlassen', () => {
    expect(escapeHtml('Max\nMuster')).toContain('\n');
    expect(stripMarkup('Max\nMuster')).toContain('\n');
    // The HTML version was covered: there the break becomes markup that the
    // application itself writes.
    expect(neutraliseHtml('Max\nMuster')).toBe('Max<br />Muster');
  });
});

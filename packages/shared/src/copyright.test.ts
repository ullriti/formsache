import { describe, expect, it } from 'vitest';

import {
  copyrightNotice,
  copyrightYears,
  parseMitCopyright,
} from './copyright.ts';

describe('parseMitCopyright', () => {
  it('liest Jahr und Namen aus einem MIT-Text', () => {
    expect(
      parseMitCopyright(
        'MIT License\n\nCopyright (c) 2026 Tilo Ullrich\n\nPermission is…',
      ),
    ).toStrictEqual({ year: 2026, holder: 'Tilo Ullrich' });
  });

  it('nimmt auch © und großes C', () => {
    expect(parseMitCopyright('Copyright © 2019 Jemand Anders').holder).toBe(
      'Jemand Anders',
    );
    expect(parseMitCopyright('Copyright (C) 2019 Jemand Anders').year).toBe(
      2019,
    );
  });

  it('lässt einen Namen mit Zusätzen ganz', () => {
    expect(
      parseMitCopyright('Copyright (c) 2026 Muster GmbH & Co. KG').holder,
    ).toBe('Muster GmbH & Co. KG');
  });

  /*
    Der Sinn der Ausnahme: eine Fußzeile ohne Urheberrechtsvermerk ist genau
    der Zustand, den Review-Runde 3 Nr. 10 beanstandet hat. Ein Ersatzwert
    („unbekannt") würde ihn wiederherstellen, nur diesmal still.
  */
  it('wirft, statt einen leeren Vermerk zu erfinden', () => {
    expect(() => parseMitCopyright('MIT License\n\nPermission is…')).toThrow(
      /Copyright/,
    );
  });
});

describe('copyrightYears', () => {
  it('nennt ein Jahr, solange nichts weiter veröffentlicht wurde', () => {
    expect(copyrightYears(2026, 2026)).toBe('2026');
  });

  it('nennt eine Spanne, sobald eine spätere Ausgabe gebaut wurde', () => {
    expect(copyrightYears(2026, 2028)).toBe('2026–2028');
  });

  /*
    Eine Maschine mit falsch gestellter Uhr baut sonst „2026–2019" in die
    Fußzeile — die eine Ausgabe, die mit Sicherheit falsch ist.
  */
  it('läuft nicht rückwärts', () => {
    expect(copyrightYears(2026, 2019)).toBe('2026');
  });
});

describe('copyrightNotice', () => {
  it('setzt Zeichen, Zeitraum und Namen zusammen', () => {
    expect(copyrightNotice({ year: 2026, holder: 'Tilo Ullrich' }, 2027)).toBe(
      '© 2026–2027 Tilo Ullrich',
    );
  });
});

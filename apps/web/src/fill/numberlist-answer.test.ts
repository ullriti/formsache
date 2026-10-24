import { describe, expect, it } from 'vitest';

import { rawNumberOf, withNumber } from './numberlist-answer';

describe('withNumber', () => {
  it('speichert eine eingetippte Null', () => {
    expect(withNumber({}, 'fuexe', '0')).toEqual({ numbers: { fuexe: 0 } });
  });

  it('entfernt die Zeile nur, wenn das Feld leer ist', () => {
    expect(withNumber({ fuexe: 2, aktive: 1 }, 'fuexe', '')).toEqual({
      numbers: { aktive: 1 },
    });
    expect(withNumber({ fuexe: 2 }, 'fuexe', '  ')).toEqual({ numbers: {} });
  });

  it.each(['-1', '1.5', 'abc', '1000001'])('lässt %s weg', (raw) => {
    expect(withNumber({ fuexe: 2 }, 'fuexe', raw)).toEqual({ numbers: {} });
  });

  it('lässt die übrigen Zeilen unberührt', () => {
    expect(withNumber({ aktive: 1 }, 'fuexe', '3')).toEqual({
      numbers: { aktive: 1, fuexe: 3 },
    });
  });
});

describe('rawNumberOf', () => {
  it('zeigt die Null, statt sie wie „leer" zu behandeln', () => {
    expect(rawNumberOf({ numbers: { fuexe: 0 } }, 'fuexe')).toBe(0);
  });

  it('liefert undefined für unberührte Zeilen und fremde Antwortformen', () => {
    expect(rawNumberOf({ numbers: {} }, 'fuexe')).toBeUndefined();
    expect(rawNumberOf('x', 'fuexe')).toBeUndefined();
    expect(rawNumberOf(undefined, 'fuexe')).toBeUndefined();
  });
});

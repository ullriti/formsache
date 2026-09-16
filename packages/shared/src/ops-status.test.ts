import { describe, expect, it } from 'vitest';

import {
  ACK_DURATION_LABELS,
  ACK_DURATION_MS,
  ackDurationSchema,
  acknowledgementHolds,
  acknowledgeAlertRequestSchema,
  ACK_NOTE_MAX,
  OPS_METRIC_SUBJECTS,
  opsMetricSchema,
} from './ops-status.ts';

const NOW = new Date('2026-09-16T12:00:00.000Z');

/**
 * **Wie lange eine Quittierung gilt** (ADR-0016, Fortschreibung 2026-09-16).
 *
 * Die Frist entscheidet, ob ein Betreiber wieder gewarnt wird — sie steht
 * deshalb hier und nicht nur im Wächter, wo eine Datenbank dazwischenliegt.
 */
describe('acknowledgementHolds', () => {
  it('gilt ohne Ende weiter („bis auf Weiteres")', () => {
    expect(acknowledgementHolds(null, NOW)).toBe(true);
  });

  it('gilt, solange die Frist in der Zukunft liegt', () => {
    expect(acknowledgementHolds('2026-09-16T12:00:01.000Z', NOW)).toBe(true);
  });

  /**
   * ⚠️ Die Frist selbst ist der **letzte stille** Augenblick — `>` und nicht
   * `>=`, dieselbe Richtung wie bei `exceeds`. Ohne diesen Fall wäre die
   * Grenze eine Sekunde offen oder eine zu früh geschlossen, und beides sähe
   * in einem Test über Stunden gleich aus.
   */
  it('endet auf die Sekunde genau', () => {
    expect(acknowledgementHolds('2026-09-16T12:00:00.000Z', NOW)).toBe(false);
    expect(acknowledgementHolds('2026-09-16T11:59:59.000Z', NOW)).toBe(false);
  });
});

describe('die Quittierung als Vertrag', () => {
  it('kennt zu jeder Dauer eine Spanne und eine Aufschrift', () => {
    for (const duration of ackDurationSchema.options) {
      expect(ACK_DURATION_LABELS[duration].length).toBeGreaterThan(0);
      // `open` ist die einzige ohne Ende; jede andere muss eine echte Spanne
      // tragen, sonst wäre sie ein „bis auf Weiteres" unter anderem Namen.
      const span: number | null = ACK_DURATION_MS[duration];
      if (duration === 'open') expect(span).toBeNull();
      else expect(span).toBeGreaterThan(0);
    }
  });

  it('gibt jeder Kennzahl eine Überschrift', () => {
    for (const metric of opsMetricSchema.options) {
      expect(OPS_METRIC_SUBJECTS[metric].length).toBeGreaterThan(0);
    }
  });

  it('nimmt eine Begründung an und beschneidet sie', () => {
    const parsed = acknowledgeAlertRequestSchema.parse({
      duration: 'day',
      note: '  Platte wird Freitag vergrößert  ',
    });

    expect(parsed.note).toBe('Platte wird Freitag vergrößert');
  });

  it('weist eine zu lange Begründung ab', () => {
    // Die Spalte ist `VARCHAR(200)`; ohne diese Grenze schlüge erst die
    // Datenbank zu, und zwar mit einem 500 statt einer Auskunft.
    expect(
      acknowledgeAlertRequestSchema.safeParse({
        duration: 'day',
        note: 'x'.repeat(ACK_NOTE_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('weist eine erfundene Dauer ab', () => {
    expect(
      acknowledgeAlertRequestSchema.safeParse({ duration: 'forever' }).success,
    ).toBe(false);
  });
});

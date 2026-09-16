import { opsMetricSchema } from '@formsache/shared';
import { OpsMetric } from '@prisma/client';
import { describe, expect, it } from 'vitest';

/**
 * **Die Datenbank und der Draht-Vertrag zählen dieselben Kennzahlen.**
 *
 * Dieselbe Abmachung wie bei `job-kinds.spec.ts`: `OpsMetric` ist die Spalte,
 * `opsMetricSchema` die Nutzlast. Ohne diesen Fall hielte sie nur der
 * Typprüfer zusammen — und der meldet sich an einer Stelle, die mit der
 * vergessenen Zeile nichts zu tun hat.
 *
 * Die Reihenfolge wird mitgeprüft: die Überwachung zeigt die Quittier-Knöpfe
 * in der Reihenfolge des Schemas. Dass jede Kennzahl auch eine Überschrift
 * trägt, steht dort, wo die Tabelle steht — `packages/shared/src/ops-status.test.ts`.
 */
describe('die Kennzahlen, aus beiden Richtungen gezählt', () => {
  it('nennt in `opsMetricSchema` genau die Werte von `OpsMetric`', () => {
    expect(opsMetricSchema.options).toStrictEqual(Object.values(OpsMetric));
  });

  it('zählt überhaupt etwas (Boden unter dem Wächter)', () => {
    expect(opsMetricSchema.options.length).toBe(5);
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TestMailResult } from '@formsache/shared';

import type { TestMailVariables } from '../../api/tenant-admin';
import { renderWithQuery } from '../../test/render-with-query';

import { TestMailCard } from './TestMailCard';

/**
 * **„Speichern und Testmail senden"** (Review-Runde 4 Nr. 3).
 *
 * Der Vorschlag lautete: *„Testmail im Wizard: Vielleicht den Button so:
 * ‚Speichern und Testmail senden'?"* Er löst einen Befund auf, den Runde 3 nur
 * halb erledigt hatte — die Testmail prüft, was **gespeichert** ist, und der
 * Weg dorthin führte über einen zweiten Knopf am anderen Ende der Seite.
 *
 * Gemessen werden die drei Zusagen, die daran hängen, und keine davon ist
 * Geschmack:
 *
 * 1. **Ohne `saveFirst` ändert sich nichts.** Die beiden Verwaltungs-Reiter
 *    behalten „Testmail senden"; dort steht der Speichern-Knopf des Blocks
 *    unmittelbar über der Karte.
 * 2. **Mit `saveFirst` wird erst gespeichert, dann gesendet** — und zwar in
 *    dieser Reihenfolge, sonst prüfte die Mail den vorherigen Stand.
 * 3. **Eine gescheiterte Speicherung sendet nicht.** Das ist die teuerste der
 *    drei: eine Erfolgsmeldung über einen Mailserver, den niemand hinterlegt
 *    hat, wäre eine Falschauskunft, die nach einer Prüfung aussieht.
 */

const RECIPIENT = 'admin@example.org';

/** Die Absende-Mutation, mit einer Antwort, die der Aufrufer bestimmt. */
function useStubSend(
  send: (variables: TestMailVariables) => Promise<TestMailResult>,
): UseMutationResult<TestMailResult, Error, TestMailVariables> {
  return useMutation({ retry: false, mutationFn: send });
}

function Harness({
  send,
  saveFirst,
}: {
  readonly send: (variables: TestMailVariables) => Promise<TestMailResult>;
  readonly saveFirst?: {
    readonly run: (onSaved: () => void) => void;
    readonly pending: boolean;
  };
}): ReactElement {
  return (
    <TestMailCard
      heading="Testmail"
      headingId="test-mail"
      hint="Prüft den Mailserver."
      currentUserEmail={RECIPIENT}
      blockedReason={null}
      logged
      {...(saveFirst === undefined ? {} : { saveFirst })}
      send={useStubSend(send)}
      forbiddenMessage="Keine Berechtigung."
    />
  );
}

const SENT: TestMailResult = {
  recipientEmail: RECIPIENT,
  status: 'sent',
  reason: null,
};

describe('die Testmail-Karte', () => {
  it('heißt ohne saveFirst weiterhin „Testmail senden"', async () => {
    const send = vi.fn().mockResolvedValue(SENT);
    renderWithQuery(<Harness send={send} />);

    expect(
      screen.queryByRole('button', { name: 'Speichern und Testmail senden' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Testmail senden' }));

    // Leer heißt „an mich selbst", und `null` ist die Schreibweise dafür auf
    // der Leitung. Nur das erste Argument: react-query reicht der
    // Mutationsfunktion daneben noch seinen eigenen Kontext herein.
    await waitFor(() => {
      expect(send).toHaveBeenCalledOnce();
    });
    expect(send.mock.calls[0]?.[0]).toEqual({ recipientEmail: null });
  });

  it('speichert zuerst und sendet danach', async () => {
    const order: string[] = [];
    const send = vi.fn().mockImplementation(() => {
      order.push('senden');
      return Promise.resolve(SENT);
    });
    const run = (onSaved: () => void): void => {
      order.push('speichern');
      onSaved();
    };

    renderWithQuery(
      <Harness send={send} saveFirst={{ run, pending: false }} />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Speichern und Testmail senden' }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(`✓ Testmail an ${RECIPIENT} gesendet.`),
      ).toBeDefined();
    });
    // Die Reihenfolge ist die Aussage: umgekehrt prüfte die Mail den
    // vorherigen Stand und meldete Erfolg über einen fremden Server.
    expect(order).toEqual(['speichern', 'senden']);
  });

  /**
   * ⚠️ **Der teuerste Fall.** `run` ruft `onSaved` nur bei Erfolg — hier gar
   * nicht. Sendete die Karte trotzdem, stünde eine Erfolgsmeldung über einem
   * Mailserver, den der Server gerade abgelehnt hat.
   *
   * *Reproduktion:* in `TestMailCard` `saveFirst.run(…)` durch
   * `saveFirst.run(…); send.mutate(…)` ersetzen → dieser Fall wird rot.
   */
  it('sendet nicht, wenn das Speichern scheitert', async () => {
    const send = vi.fn().mockResolvedValue(SENT);
    // Speichert und ruft `onSaved` **nicht** — die Ablehnung steht oben am
    // Assistenten, nicht hier.
    const run = vi.fn();

    renderWithQuery(
      <Harness send={send} saveFirst={{ run, pending: false }} />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Speichern und Testmail senden' }),
    );

    await waitFor(() => {
      expect(run).toHaveBeenCalledOnce();
    });
    expect(send).not.toHaveBeenCalled();
    expect(
      screen.queryByText(`✓ Testmail an ${RECIPIENT} gesendet.`),
    ).toBeNull();
  });

  it('sperrt den Knopf, solange gespeichert wird', () => {
    renderWithQuery(
      <Harness send={vi.fn()} saveFirst={{ run: vi.fn(), pending: true }} />,
    );

    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Wird gespeichert…',
    });
    expect(button.disabled).toBe(true);
  });
});

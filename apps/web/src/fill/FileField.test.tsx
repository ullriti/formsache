import { useState } from 'react';

import type { AnswerValue, Question } from '@formsache/shared';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/http';
import * as api from '../api/public-form';
import { FieldInput } from './FieldInput';

/**
 * **The round trip the requirement asks for, in a browser-shaped test**:
 * pick, upload, see what was uploaded, remove again.
 *
 * What is asserted here is the *wiring* — which control appears, what the pick
 * hands to the upload, what the answer becomes and what a refusal looks like on
 * screen. The upload itself is stubbed at the one function that talks to the
 * server (`uploadAttachment`), which is also where the contract is: what comes
 * back is what goes into the answer, and nothing here invents a reference or a
 * name.
 */

const QUESTION_ID = '019fe700-0000-7000-8000-0000000000c1';
const TARGET = { kind: 'form', slug: 'abcdefghijklmnopqrstuv' } as const;

function fileQuestion(maxFiles = 1): Question {
  return {
    id: QUESTION_ID,
    type: 'file',
    label: 'Nachweis',
    hint: null,
    required: false,
    width: 'full',
    maxFiles,
  };
}

function Harness({
  question,
  onValue,
}: {
  readonly question: Question;
  readonly onValue: (value: AnswerValue) => void;
}) {
  const [value, setValue] = useState<AnswerValue | undefined>(undefined);
  return (
    <FieldInput
      question={question}
      value={value}
      error={undefined}
      uploadTarget={TARGET}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

/** The one control in the drop zone — a real `<input type="file">`. */
function picker(): HTMLInputElement {
  const input = screen.getByLabelText('Nachweis');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Der Datei-Upload hat kein Eingabefeld.');
  }
  return input;
}

function pick(...files: readonly File[]): void {
  fireEvent.change(picker(), { target: { files } });
}

const pdf = (name: string): File =>
  new File(['%PDF-1.7\n'], name, { type: 'application/pdf' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FieldInput – Datei-Upload', () => {
  it('uploads the picked file and puts reference and name into the answer', async () => {
    const upload = vi.spyOn(api, 'uploadAttachment').mockResolvedValue({
      ref: 'AbCdEfGhIjKlMnOpQrStUv',
      fileName: 'Nachweis.pdf',
      contentType: 'application/pdf',
      byteSize: 9,
    });
    const onValue = vi.fn();
    render(<Harness question={fileQuestion()} onValue={onValue} />);

    pick(pdf('Nachweis.pdf'));

    await waitFor(() => {
      expect(onValue).toHaveBeenCalledWith({
        files: [{ ref: 'AbCdEfGhIjKlMnOpQrStUv', name: 'Nachweis.pdf' }],
      });
    });
    // The door this view uploads through travels with the call — the public
    // form's slug here, an edit token on the correction view.
    expect(upload).toHaveBeenCalledWith(TARGET, expect.any(File));
  });

  it('shows what was uploaded, and takes it away again on „Entfernen"', async () => {
    vi.spyOn(api, 'uploadAttachment').mockResolvedValue({
      ref: 'AbCdEfGhIjKlMnOpQrStUv',
      fileName: 'Nachweis.pdf',
      contentType: 'application/pdf',
      byteSize: 9,
    });
    const onValue = vi.fn();
    render(<Harness question={fileQuestion()} onValue={onValue} />);

    pick(pdf('Nachweis.pdf'));
    await screen.findByText('Nachweis.pdf');

    // The picker is **disabled**, not removed, while the one file this question
    // offers is attached: the question's own `<label htmlFor>` points at it, and
    // taking it out of the document would leave that pointing at nothing — the
    // missing-accessible-name defect, where the question text is simply never announced.
    expect(picker().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Entfernen/u }));

    // **The empty object, not `null`** — `{files: []}` is the one blank shape
    // the shared validator knows for this type (`blankSchemaFor`).
    expect(onValue).toHaveBeenLastCalledWith({ files: [] });
    expect(screen.queryByText('Nachweis.pdf')).toBeNull();
    expect(picker().disabled).toBe(false);
  });

  /**
   * **What does not fit is said, not swallowed** (a review finding).
   *
   * `picked.slice(0, remaining)` used to drop the surplus silently. A
   * participant who selects five scans for a question that takes two sees two
   * appear and no explanation for the other three — indistinguishable from the
   * browser losing them, and the thing they would do next is pick them again.
   */
  it('says how many of the picked files did not fit', async () => {
    vi.spyOn(api, 'uploadAttachment').mockResolvedValue({
      ref: 'AbCdEfGhIjKlMnOpQrStUv',
      fileName: 'Erst.pdf',
      contentType: 'application/pdf',
      byteSize: 9,
    });
    render(<Harness question={fileQuestion()} onValue={vi.fn()} />);

    pick(pdf('Erst.pdf'), pdf('Zweit.pdf'), pdf('Dritt.pdf'));

    expect(
      await screen.findByText(/Es ist noch Platz für eine Datei\./u),
    ).toBeDefined();
  });

  /**
   * **The list cannot be edited while it is being written** (a review finding).
   *
   * `addAll` carries the list it started with and republishes it after every
   * single upload, so a removal landing in that window would be written back by
   * the next one — and the participant would submit an attachment they had
   * taken away. The lock is the assertion here; without it the case below
   * removes „Erst.pdf" and gets it again.
   */
  it('locks the remove buttons while an upload is running', async () => {
    let release: (() => void) | undefined;
    vi.spyOn(api, 'uploadAttachment')
      .mockResolvedValueOnce({
        ref: 'AbCdEfGhIjKlMnOpQrStUv',
        fileName: 'Erst.pdf',
        contentType: 'application/pdf',
        byteSize: 9,
      })
      .mockImplementationOnce(
        async () =>
          new Promise((resolve) => {
            release = () => {
              resolve({
                ref: 'ZyXwVuTsRqPoNmLkJiHgFe',
                fileName: 'Dann.pdf',
                contentType: 'application/pdf',
                byteSize: 9,
              });
            };
          }),
      );
    const onValue = vi.fn();
    render(<Harness question={fileQuestion(2)} onValue={onValue} />);

    pick(pdf('Erst.pdf'), pdf('Dann.pdf'));

    // „Erst.pdf" is on screen while „Dann.pdf" is still in flight — the exact
    // window in which the old code accepted a click.
    const remove = await screen.findByRole('button', {
      name: 'Entfernen: Erst.pdf',
    });
    expect((remove as HTMLButtonElement).disabled).toBe(true);

    release?.();
    await waitFor(() => {
      expect((remove as HTMLButtonElement).disabled).toBe(false);
    });
  });

  /**
   * The remove button names **which** file it removes. With two attachments a
   * row of identical „Entfernen" buttons would leave a screen reader user no
   * way to tell them apart.
   */
  it('names the file each remove button belongs to', async () => {
    vi.spyOn(api, 'uploadAttachment')
      .mockResolvedValueOnce({
        ref: 'AbCdEfGhIjKlMnOpQrStUv',
        fileName: 'Erst.pdf',
        contentType: 'application/pdf',
        byteSize: 9,
      })
      .mockResolvedValueOnce({
        ref: 'ZyXwVuTsRqPoNmLkJiHgFe',
        fileName: 'Dann.pdf',
        contentType: 'application/pdf',
        byteSize: 9,
      });
    const onValue = vi.fn();
    render(<Harness question={fileQuestion(2)} onValue={onValue} />);

    pick(pdf('Erst.pdf'), pdf('Dann.pdf'));

    await screen.findByText('Dann.pdf');
    expect(
      screen.getByRole('button', { name: 'Entfernen: Erst.pdf' }),
    ).toBeDefined();

    fireEvent.click(
      screen.getByRole('button', { name: 'Entfernen: Erst.pdf' }),
    );

    expect(onValue).toHaveBeenLastCalledWith({
      files: [{ ref: 'ZyXwVuTsRqPoNmLkJiHgFe', name: 'Dann.pdf' }],
    });
  });

  /**
   * **A refusal is shown where it happened**, in the server's own words.
   *
   * „Diese Datei wird nicht angenommen. Erlaubt sind PDF, PNG und JPEG …" is
   * written for exactly this screen (`public-uploads.service.ts`); a sentence
   * invented in the browser would drift away from the rule it describes. And it
   * goes under the field rather than into a page-level banner: the file that
   * was refused is the one just picked.
   */
  it('shows the server’s own sentence when the upload is refused', async () => {
    vi.spyOn(api, 'uploadAttachment').mockRejectedValue(
      new ApiError(
        415,
        'POST failed',
        undefined,
        undefined,
        'Diese Datei wird nicht angenommen.',
      ),
    );
    render(<Harness question={fileQuestion()} onValue={vi.fn()} />);

    pick(pdf('Anhang.svg'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Diese Datei wird nicht angenommen.');
    // Nothing was attached, so the picker is ready for the next try.
    expect(picker().disabled).toBe(false);
  });

  /**
   * The **only** client-side check, and it is UX: the server enforces the same
   * number while the bytes arrive (ADR-0014 no. 6). What it buys is a
   * participant on a mobile connection not sending eleven megabytes to be told
   * no — so the request must not go out at all.
   */
  it('refuses a file above the limit without sending it', async () => {
    const upload = vi.spyOn(api, 'uploadAttachment');
    render(<Harness question={fileQuestion()} onValue={vi.fn()} />);

    const big = pdf('Riesig.pdf');
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    pick(big);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Riesig.pdf');
    expect(alert.textContent).toContain('max. 10 MB');
    expect(upload).not.toHaveBeenCalled();
  });

  /**
   * The hint is `ATTACHMENT_HINT` from `@formsache/shared`, not a sentence typed
   * here: the rule belongs to the server's allow list and size limit
   * (`fileQuestionSchema` says why the handoff's editable „Erlaubte
   * Dateitypen" box is gone), and a second spelling is a caption that goes on
   * promising something after the rule moved.
   */
  it('shows the rule the server will apply', () => {
    render(<Harness question={fileQuestion()} onValue={vi.fn()} />);

    const zone = picker().closest('label');
    expect(zone).not.toBeNull();
    expect(
      within(zone as HTMLElement).getByText(
        'Erlaubt: PDF, PNG, JPG · max. 10 MB',
      ),
    ).toBeDefined();
  });
});

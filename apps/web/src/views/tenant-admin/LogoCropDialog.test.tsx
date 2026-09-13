import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LogoCropDialog } from './LogoCropDialog';

/**
 * „Ausschnitt wählen" .
 *
 * **What this file can and cannot measure.** jsdom lays nothing out — every
 * `getBoundingClientRect()` is zero — so the *gesture* (pointer, touch, the
 * 360 px viewport) belongs to Playwright and is measured there
 * (`e2e/tenant-admin.spec.ts`, `e2e/tenant-admin-mobile.spec.ts`). What is
 * measured here is what a browser makes expensive and jsdom makes cheap: the
 * keyboard path, the frame's name, and above all **the two ways this dialog
 * could fail silently** — a `toBlob` that answers with `null`, and a file the
 * browser cannot decode.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function pickedFile(name = 'Mein Logo.JPG'): File {
  return new File([PNG_BYTES], name, { type: 'image/jpeg' });
}

/** jsdom has no canvas; these two are the whole surface `render-crop.ts` uses. */
function stubCanvas(options: { readonly blob: Blob | null }): {
  readonly drawImage: ReturnType<typeof vi.fn>;
  readonly sizes: { width: number; height: number }[];
} {
  const drawImage = vi.fn();
  const sizes: { width: number; height: number }[] = [];

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement) {
      sizes.push({ width: this.width, height: this.height });
      return { drawImage } as unknown as CanvasRenderingContext2D;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
    (callback: BlobCallback) => {
      callback(options.blob);
    },
  );

  return { drawImage, sizes };
}

/** Gives the `<img>` a natural size and fires `load`, as a browser would. */
function loadImage(width: number, height: number): void {
  const image = document.querySelector('img.logo-crop__image');
  if (image === null) {
    throw new Error('The crop stage has no image.');
  }
  Object.defineProperty(image, 'naturalWidth', { value: width });
  Object.defineProperty(image, 'naturalHeight', { value: height });
  fireEvent.load(image);
}

function frame(): HTMLElement {
  return screen.getByRole('group', { name: 'Bildausschnitt' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Ausschnitt wählen', () => {
  it('opens with the frame around the whole picture', () => {
    render(
      <LogoCropDialog
        file={pickedFile()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    loadImage(400, 300);

    expect(frame().style.left).toBe('0%');
    expect(frame().style.top).toBe('0%');
    expect(frame().style.width).toBe('100%');
    expect(frame().style.height).toBe('100%');
    expect(
      screen.getByText(
        'Ausschnitt 400 × 300 Pixel, linke obere Ecke bei 0, 0.',
      ),
    ).toBeDefined();
  });

  /**
   * **Trap 1 — the frame is a control.** An editor without a mouse
   * has to be able to place it, and „focusable" alone is not that: the arrows
   * move, Shift and the arrows resize, and the readout says what happened.
   *
   * *Reproduction:* drop the `onKeyDown` from the frame → both assertions read
   * the opening values.
   */
  describe('the keyboard path', () => {
    it('moves the frame with the arrow keys', () => {
      render(
        <LogoCropDialog
          file={pickedFile()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      loadImage(1000, 500);

      // The frame fills the picture, so it cannot move until it is smaller.
      fireEvent.keyDown(frame(), { key: 'ArrowLeft', shiftKey: true });
      fireEvent.keyDown(frame(), { key: 'ArrowUp', shiftKey: true });
      // 2 % steps: 20 px in x, 10 px in y.
      expect(frame().style.width).toBe('98%');
      expect(frame().style.height).toBe('98%');

      fireEvent.keyDown(frame(), { key: 'ArrowRight' });
      fireEvent.keyDown(frame(), { key: 'ArrowDown' });

      expect(frame().style.left).toBe('2%');
      expect(frame().style.top).toBe('2%');
      expect(
        screen.getByText(
          'Ausschnitt 768 × 384 Pixel, linke obere Ecke bei 20, 10.',
        ),
      ).toBeDefined();
    });

    it('leaves arrows it does not act on to the page', () => {
      render(
        <LogoCropDialog
          file={pickedFile()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      loadImage(400, 300);

      // Not an arrow: nothing prevented, so Tab still leaves the frame.
      expect(fireEvent.keyDown(frame(), { key: 'Tab' })).toBe(true);
      // An arrow it acts on: the page must not scroll underneath.
      expect(fireEvent.keyDown(frame(), { key: 'ArrowRight' })).toBe(false);
    });

    it('puts the whole picture back', () => {
      render(
        <LogoCropDialog
          file={pickedFile()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );
      loadImage(1000, 500);

      fireEvent.keyDown(frame(), { key: 'ArrowLeft', shiftKey: true });
      expect(frame().style.width).toBe('98%');

      fireEvent.click(screen.getByRole('button', { name: 'Ganzes Bild' }));

      expect(frame().style.width).toBe('100%');
    });
  });

  describe('the file it hands on', () => {
    it('is a PNG scaled to the longest edge, named after the pick', async () => {
      const onConfirm = vi.fn();
      const canvas = stubCanvas({ blob: new Blob([PNG_BYTES]) });
      render(
        <LogoCropDialog
          file={pickedFile('Mein Logo.JPG')}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
      loadImage(4000, 3000);

      fireEvent.click(screen.getByRole('button', { name: 'Logo übernehmen' }));

      await waitFor(() => {
        expect(onConfirm).toHaveBeenCalledTimes(1);
      });
      const uploaded = onConfirm.mock.calls[0]?.[0] as File;
      // PNG whatever came in — a Logo has transparency and JPEG has no alpha
      // channel (`render-crop.ts`). The name must not go on claiming `.JPG`.
      expect(uploaded.type).toBe('image/png');
      expect(uploaded.name).toBe('Mein Logo.png');
      // 4000 × 3000 → 768 × 576, never larger: the public header renders a
      // Logo in a 220 × 96 box.
      expect(canvas.sizes).toEqual([{ width: 768, height: 576 }]);
      expect(canvas.drawImage).toHaveBeenCalledWith(
        expect.anything(),
        0,
        0,
        4000,
        3000,
        0,
        0,
        768,
        576,
      );
    });

    /**
     * **Trap 4 — `canvas.toBlob` is asynchronous and can deliver `null`.**
     * The shape this project has to guard against is the quiet one: the
     * dialog closes, no request goes out, and nothing on the screen says why.
     *
     * *Reproduction:* swallow the rejection in `onSubmit` (`.catch(() => {})`)
     * → `onConfirm` is still not called, no alert appears, and the editor is
     * left in front of a dialog that did nothing.
     */
    it('says so when the browser produces no image, instead of uploading nothing', async () => {
      const onConfirm = vi.fn();
      stubCanvas({ blob: null });
      render(
        <LogoCropDialog
          file={pickedFile()}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
      loadImage(400, 300);

      fireEvent.click(screen.getByRole('button', { name: 'Logo übernehmen' }));

      expect(
        await screen.findByText(/Ausschnitt konnte im Browser nicht erzeugt/),
      ).toBeDefined();
      expect(onConfirm).not.toHaveBeenCalled();
      // Still operable: the button is back, not stuck on „Wird zugeschnitten…".
      expect(
        screen.getByRole<HTMLButtonElement>('button', {
          name: 'Logo übernehmen',
        }).disabled,
      ).toBe(false);
    });

    it('refuses a file the browser cannot decode, with a sentence', () => {
      render(
        <LogoCropDialog
          file={pickedFile()}
          onCancel={vi.fn()}
          onConfirm={vi.fn()}
        />,
      );

      const image = document.querySelector('img.logo-crop__image');
      if (image === null) {
        throw new Error('The crop stage has no image.');
      }
      fireEvent.error(image);

      expect(
        screen.getByText(/lässt sich im Browser nicht als Bild öffnen/),
      ).toBeDefined();
      expect(
        screen.getByRole<HTMLButtonElement>('button', {
          name: 'Logo übernehmen',
        }).disabled,
      ).toBe(true);
    });
  });

  it('hands nothing on when it is cancelled', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <LogoCropDialog
        file={pickedFile()}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
    loadImage(400, 300);

    fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

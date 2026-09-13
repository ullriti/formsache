import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from 'react';

import { useFocusTrap } from '../../shell/use-focus-trap';
import {
  clampCrop,
  cropSummary,
  initialCrop,
  minCropSide,
  moveCrop,
  outputSize,
  resizeCrop,
  sourcePerDisplayPixel,
  type CropCorner,
  type CropRect,
  type Size,
} from './crop-geometry';
import { CropRenderError, renderCroppedLogo } from './render-crop';

/**
 * „Ausschnitt wählen" — the frame over a picked Logo.
 *
 * ## Why every upload comes through here
 *
 * There is no second, „raw" way past this dialog, and that is a decision rather
 * than an omission: **the step that crops is the step that scales**. A phone
 * photo of a Organisationslogo is 3–6 MiB and the limit is 2 MiB (ADR-0014 no. 6),
 * so on the raw path that file is refused by the server for a reason the
 * browser was in a position to fix. Keeping both paths would mean the refusal
 * survives on the one an editor is most likely to take.
 *
 * The cost is one click for somebody who wanted no crop at all, and it is paid
 * down rather than argued away: the dialog opens with the frame **around the
 * whole image** (`initialCrop`), the primary button is right there, and
 * „Ganzes Bild" puts it back at any time. Nothing is cut unless somebody cuts
 * it.
 *
 * ## Why the frame is operable without a pointer
 *
 * A frame that can only be dragged is not a control for everyone who edits a
 * organisation's appearance. It is focusable, it has a name and a role description, and
 * the arrow keys move it while Shift and the arrow keys resize it — the same
 * split the builder's grips use (`use-pointer-drag.ts`), for the same reason.
 *
 * The corner handles are pointer decoration and stay out of the accessibility
 * tree: four more tab stops would each need a name of their own, and they would
 * offer nothing the arrows do not already do.
 */

/** One arrow press moves or resizes by this share of the image. */
const KEY_STEP_SHARE = 0.02;

function stepOf(image: Size): { readonly x: number; readonly y: number } {
  return {
    x: Math.max(1, Math.round(image.width * KEY_STEP_SHARE)),
    y: Math.max(1, Math.round(image.height * KEY_STEP_SHARE)),
  };
}

const CORNERS: readonly CropCorner[] = ['nw', 'ne', 'sw', 'se'];

function percent(part: number, whole: number): string {
  if (whole <= 0) {
    return '0%';
  }
  return `${String((part / whole) * 100)}%`;
}

export function LogoCropDialog({
  file,
  onCancel,
  onConfirm,
  fallbackRef,
}: {
  /** What the editor picked; never leaves this dialog unchanged. */
  readonly file: File;
  readonly onCancel: () => void;
  /** The rendered PNG, ready for the upload mutation. */
  readonly onConfirm: (cropped: File) => void;
  /**
   * Where focus goes when the picker cannot take it back — see the hook.
   *
   * Optional for the same reason `openerRef` is: a caller whose trigger stays
   * enabled across the close has nothing to thread through. The Logo field
   * is not such a caller, which is why it passes one.
   */
  readonly fallbackRef?: RefObject<HTMLElement | null>;
}): ReactElement {
  const titleId = useId();
  const helpId = useId();
  const readoutId = useId();
  const imageRef = useRef<HTMLImageElement>(null);
  const { panelRef, onKeyDown: onPanelKeyDown } = useFocusTrap({
    onClose: onCancel,
    ...(fallbackRef === undefined ? {} : { fallbackRef }),
  });

  const [source, setSource] = useState<string | null>(null);
  const [image, setImage] = useState<Size | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  // The object URL is the only resource this dialog owns, and it is released on
  // the way out — an un-revoked one keeps the whole file in memory for the life
  // of the document, and a logo picker is somewhere an editor tries four
  // files in a row.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSource(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  /**
   * How many source pixels one screen pixel is worth, **read at the moment it
   * is needed**.
   *
   * Not state: it changes with every resize and rotation, and a stale copy
   * would make a drag move the frame by the wrong amount rather than fail
   * visibly. `0` means „nothing laid out" — see `sourcePerDisplayPixel`.
   */
  const sourcePerDisplay = useCallback((size: Size): number => {
    const element = imageRef.current;
    if (element === null) {
      return 0;
    }
    return sourcePerDisplayPixel(size, element.getBoundingClientRect().width);
  }, []);

  const onImageLoad = useCallback(() => {
    const element = imageRef.current;
    if (element === null) {
      return;
    }
    const size: Size = {
      width: element.naturalWidth,
      height: element.naturalHeight,
    };
    if (size.width <= 0 || size.height <= 0) {
      setFailure(
        'Diese Datei lässt sich im Browser nicht als Bild öffnen. Bitte ein PNG oder JPG wählen.',
      );
      return;
    }
    setFailure(null);
    setImage(size);
    setCrop(initialCrop(size));
  }, []);

  const onImageError = useCallback(() => {
    setFailure(
      'Diese Datei lässt sich im Browser nicht als Bild öffnen. Bitte ein PNG oder JPG wählen.',
    );
  }, []);

  /**
   * One pointer gesture — move when `corner` is `null`, resize otherwise.
   *
   * Pointer events rather than mouse events, and the same three details the
   * builder's drag needed: capture on the element that was pressed, so a fast
   * drag that outruns the cursor keeps its events; `touch-action: none` in CSS,
   * or the browser scrolls the page instead of handing over the move; and every
   * move measured from the crop **as it was when the gesture started**, so that
   * hitting an edge does not eat the way back.
   */
  const startGesture = useCallback(
    (event: ReactPointerEvent<HTMLElement>, corner: CropCorner | null) => {
      if (event.button !== 0 || image === null || crop === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);

      const perPixel = sourcePerDisplay(image);
      const min = minCropSide(perPixel);
      const startCrop = crop;
      const startX = event.clientX;
      const startY = event.clientY;

      const onMove = (moveEvent: PointerEvent): void => {
        const dx = (moveEvent.clientX - startX) * perPixel;
        const dy = (moveEvent.clientY - startY) * perPixel;
        setCrop(
          corner === null
            ? moveCrop(startCrop, image, dx, dy)
            : resizeCrop(startCrop, image, corner, dx, dy, min),
        );
      };

      const finish = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', onCancelGesture);
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      };

      // A cancelled pointer (a system gesture took over) leaves the frame where
      // it got to. Snapping it back would undo a move the editor watched
      // happen, and unlike the builder there is no list order to corrupt here.
      const onCancelGesture = (): void => {
        finish();
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', onCancelGesture);
    },
    [crop, image, sourcePerDisplay],
  );

  const onFrameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (image === null || crop === null) {
        return;
      }
      const step = stepOf(image);
      const deltas: Record<string, readonly [number, number]> = {
        ArrowLeft: [-step.x, 0],
        ArrowRight: [step.x, 0],
        ArrowUp: [0, -step.y],
        ArrowDown: [0, step.y],
      };
      const delta = deltas[event.key];
      if (delta === undefined) {
        return;
      }
      // Only now: an arrow this handler does not act on belongs to the page
      // (scrolling the dialog), and swallowing it would trap the reader.
      event.preventDefault();
      const [dx, dy] = delta;

      // Shift resizes, and it resizes the bottom-right corner: the top-left
      // stays put, so „größer" and „kleiner" are the same gesture the mouse
      // makes with the handle furthest from the picture's origin.
      setCrop(
        event.shiftKey
          ? resizeCrop(
              crop,
              image,
              'se',
              dx,
              dy,
              minCropSide(sourcePerDisplay(image)),
            )
          : moveCrop(crop, image, dx, dy),
      );
    },
    [crop, image, sourcePerDisplay],
  );

  const onTakeWhole = useCallback(() => {
    if (image !== null) {
      setCrop(initialCrop(image));
    }
  }, [image]);

  const onSubmit = useCallback(() => {
    const element = imageRef.current;
    if (element === null || image === null || crop === null) {
      return;
    }
    setRendering(true);
    setFailure(null);
    renderCroppedLogo(
      element,
      // Belt to the braces of every clamp above: what reaches `drawImage` is
      // inside the picture, whatever a resize race left in state.
      clampCrop(crop, image, minCropSide(sourcePerDisplay(image))),
      file.name,
    )
      .then((cropped) => {
        onConfirm(cropped);
      })
      .catch((error: unknown) => {
        setRendering(false);
        // The one thing that must not happen here is nothing. `toBlob` answers
        // with `null` when it cannot encode, and a dialog that closed on that
        // would upload nothing and say nothing (`render-crop.ts`).
        setFailure(
          error instanceof CropRenderError
            ? 'Der Ausschnitt konnte im Browser nicht erzeugt werden. Bitte noch einmal versuchen oder eine andere Datei wählen.'
            : 'Der Ausschnitt konnte nicht übernommen werden.',
        );
      });
  }, [crop, file.name, image, onConfirm, sourcePerDisplay]);

  const ready = image !== null && crop !== null;
  const output = crop === null ? null : outputSize(crop);

  const frameStyle: CSSProperties | undefined =
    image === null || crop === null
      ? undefined
      : {
          left: percent(crop.x, image.width),
          top: percent(crop.y, image.height),
          width: percent(crop.width, image.width),
          height: percent(crop.height, image.height),
        };

  return (
    <div className="logo-crop">
      {/* Redundant with „Abbrechen" and Escape, so it stays out of the
          accessibility tree rather than becoming a second, unnamed control —
          the same call `PublishNotice` makes. */}
      <div className="logo-crop__scrim" aria-hidden="true" onClick={onCancel} />
      <div
        className="logo-crop__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onPanelKeyDown}
      >
        <h2 className="logo-crop__title" id={titleId}>
          Ausschnitt wählen
        </h2>
        <p className="logo-crop__hint" id={helpId}>
          Ziehe den Rahmen oder seine Ecken. Mit der Tastatur: Rahmen anwählen,
          dann mit den Pfeiltasten verschieben und mit Umschalt + Pfeiltasten
          vergrößern oder verkleinern.
        </p>

        <div className="logo-crop__stage">
          <div className="logo-crop__canvas">
            {source === null ? null : (
              <img
                ref={imageRef}
                className="logo-crop__image"
                src={source}
                // Decorative: the frame next to it carries the name, and the
                // picture's content is what the editor is looking at, not
                // something this dialog can describe.
                alt=""
                onLoad={onImageLoad}
                onError={onImageError}
              />
            )}
            {ready && frameStyle !== undefined ? (
              <div
                className="logo-crop__frame"
                // No ARIA role carries a rectangle, so the frame is a named
                // group whose value is the text below (`aria-describedby`
                // points at the instructions, the live caption reports the
                // number). `aria-roledescription` makes a screen reader say
                // „Ausschnittsrahmen" instead of „Gruppe".
                role="group"
                aria-roledescription="Ausschnittsrahmen"
                aria-label="Bildausschnitt"
                // **The instructions and the readout**, not just the
                // instructions: `aria-live` reports a *change*, so a frame that
                // was only described by its help text said nothing about where
                // it stood when it received focus. Naming the readout here
                // makes „Ausschnitt 200 × 400 Pixel, linke obere Ecke bei
                // 200, 0" part of what is announced on arrival (the
                // crop-dialog review).
                aria-describedby={`${helpId} ${readoutId}`}
                tabIndex={0}
                style={frameStyle}
                onPointerDown={(event) => {
                  startGesture(event, null);
                }}
                onKeyDown={onFrameKeyDown}
              >
                {CORNERS.map((corner) => (
                  <span
                    key={corner}
                    className={`logo-crop__handle logo-crop__handle--${corner}`}
                    aria-hidden="true"
                    onPointerDown={(event) => {
                      startGesture(event, corner);
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <p className="logo-crop__readout" id={readoutId} aria-live="polite">
          {crop === null || output === null
            ? 'Bild wird geladen…'
            : cropSummary(crop)}
        </p>

        {failure === null ? null : (
          <p className="logo-crop__problem" role="alert">
            {failure}
          </p>
        )}

        <div className="logo-crop__actions">
          <button
            type="button"
            className="logo-crop__reset"
            onClick={onTakeWhole}
            disabled={!ready}
          >
            Ganzes Bild
          </button>
          <span className="logo-crop__spacer" />
          <button
            type="button"
            className="logo-crop__cancel"
            onClick={onCancel}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="logo-crop__confirm"
            disabled={!ready || rendering}
            onClick={onSubmit}
          >
            {rendering ? 'Wird zugeschnitten…' : 'Logo übernehmen'}
          </button>
        </div>
      </div>
    </div>
  );
}

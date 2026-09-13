/**
 * The arithmetic behind the logo crop frame.
 *
 * **Everything here counts source pixels** — the pixels of the file the editor
 * picked, not the pixels it happens to be shown at. The stage scales the image
 * to fit the dialog, and that scale changes with the viewport, with a rotated
 * phone, with the browser's zoom. A frame stored in screen coordinates would
 * mean something different after each of those; stored in source coordinates it
 * is the same rectangle of the same image, and the only place the display scale
 * appears is where a pointer delta has to be translated into one
 * ({@link minCropSide} and the callers of {@link moveCrop}).
 *
 * Pure functions with no DOM in sight, for the reason the builder's
 * `drag-geometry.ts` is pure: this is the part that is worth testing at every
 * boundary, and a test that needs a layout can test none of them.
 */

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface CropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The corner a pointer or a keystroke is dragging. */
export type CropCorner = 'nw' | 'ne' | 'sw' | 'se';

/**
 * The smallest crop, in **source** pixels: 96 — the height of
 * `--layout-logo-height-fill`.
 *
 * That token is the tallest box this application ever renders a logo in (the
 * card header of the public fill-in page, 220 × 96, `public-form-view.css`).
 * A crop below it can only ever be shown enlarged, so the floor is not a taste
 * decision: it is the point below which the editor is choosing a picture that
 * the one place it is shown largest cannot display without inventing pixels.
 *
 * Capped against the image itself by {@link minCropSide} — a 40 px source image
 * is under the floor as a whole, and refusing to let its frame exist would be
 * refusing the file.
 */
export const MIN_CROP_SOURCE_PX = 96;

/**
 * The smallest crop, in **displayed** pixels: 44 — a touch target.
 *
 * The frame is dragged by its corners, and a corner of a 12 px frame is not
 * something a finger can hit. This floor is the one that needs the display
 * scale, which is why it is a second number rather than a bigger
 * {@link MIN_CROP_SOURCE_PX}: on a 4000 px photo shown 500 px wide, 44 display
 * pixels are 352 source pixels, and on a 200 px Logo shown at 1:1 they are 44.
 */
export const MIN_CROP_DISPLAY_PX = 44;

/**
 * `value` inside `[lo, hi]`, and `lo` when the interval is empty.
 *
 * The empty case is not hypothetical: an image narrower than the minimum crop
 * makes `right - min` negative, and `Math.min(Math.max(…))` on a reversed
 * interval silently returns the wrong end.
 */
function clampRange(value: number, lo: number, hi: number): number {
  if (hi < lo) {
    return lo;
  }
  return Math.min(Math.max(value, lo), hi);
}

/**
 * How many source pixels one displayed pixel is worth.
 *
 * `0` when nothing is laid out yet (jsdom always, a browser for one frame after
 * mounting). Callers treat that as „no display floor", not as a divide by zero.
 */
export function sourcePerDisplayPixel(
  image: Size,
  displayedWidth: number,
): number {
  if (displayedWidth <= 0 || image.width <= 0) {
    return 0;
  }
  return image.width / displayedWidth;
}

/**
 * The smallest side this frame may have, in source pixels — **both floors, and
 * no image cap**.
 *
 * The cap belongs to {@link minCropOnAxis}, per axis. Applying it here with the
 * *shorter* side of the image gave away the very touch target this number
 * exists for whenever the picture was a banner (the crop-dialog review).
 */
export function minCropSide(sourcePerDisplay: number): number {
  const touchFloor = MIN_CROP_DISPLAY_PX * Math.max(sourcePerDisplay, 0);
  return Math.max(MIN_CROP_SOURCE_PX, touchFloor);
}

/**
 * The floor for one axis — the shared minimum, capped by *that* side.
 *
 * Capping with the shorter side of the image on both axes is what
 * {@link minCropSide} used to do, and it gave away the touch target it exists
 * to guarantee: on a 4000 × 200 banner the floor collapsed to 200 source
 * pixels, which at a displayed width of 500 px is 25 display pixels — well
 * under the 44 the finger needs (the crop-dialog review). A crop can never
 * be asked to be wider than the picture, but the *width* is bounded by the
 * width and the *height* by the height.
 */
export function minCropOnAxis(minSide: number, axisLength: number): number {
  return Math.min(minSide, axisLength);
}

/**
 * The frame the dialog opens with: **the whole image**.
 *
 * Deliberately not a centred square. Opening on a guess would cut a logo for
 * an editor who only wanted to upload it, and the one thing this dialog must
 * not do is quietly remove part of a picture nobody asked it to touch. „Take it
 * as it is" is therefore one click, and every crop is a deliberate act.
 */
export function initialCrop(image: Size): CropRect {
  return { x: 0, y: 0, width: image.width, height: image.height };
}

/** The frame back inside the image, no smaller than `minSide`. */
export function clampCrop(
  crop: CropRect,
  image: Size,
  minSide: number,
): CropRect {
  const width = clampRange(
    crop.width,
    minCropOnAxis(minSide, image.width),
    image.width,
  );
  const height = clampRange(
    crop.height,
    minCropOnAxis(minSide, image.height),
    image.height,
  );
  return {
    x: clampRange(crop.x, 0, image.width - width),
    y: clampRange(crop.y, 0, image.height - height),
    width,
    height,
  };
}

/**
 * Moves the frame, keeping its size.
 *
 * The size is kept rather than clipped at the edge: a frame that shrank when it
 * hit the border would make a drag across the picture change the crop the
 * editor had already sized, which is not what dragging something means.
 */
export function moveCrop(
  crop: CropRect,
  image: Size,
  dx: number,
  dy: number,
): CropRect {
  return {
    ...crop,
    x: clampRange(crop.x + dx, 0, image.width - crop.width),
    y: clampRange(crop.y + dy, 0, image.height - crop.height),
  };
}

/**
 * Drags one corner; the opposite corner stays put.
 *
 * Free in both axes — see the decision recorded in Konzept no. 62 and ADR-0014
 * no. 20. Both places this application renders a logo fit it with
 * `object-fit: contain` inside a box (`tenant-mark.css`, `public-form-view.css`)
 * and neither assumes a square, so locking the frame to 1:1 would force an
 * editor to pad a portrait crest with empty space in order to satisfy a
 * constraint the renderer does not have.
 */
export function resizeCrop(
  crop: CropRect,
  image: Size,
  corner: CropCorner,
  dx: number,
  dy: number,
  minSide: number,
): CropRect {
  const minWidth = minCropOnAxis(minSide, image.width);
  const minHeight = minCropOnAxis(minSide, image.height);

  let left = crop.x;
  let top = crop.y;
  let right = crop.x + crop.width;
  let bottom = crop.y + crop.height;

  if (corner === 'nw' || corner === 'sw') {
    left = clampRange(left + dx, 0, right - minWidth);
  } else {
    right = clampRange(right + dx, left + minWidth, image.width);
  }

  if (corner === 'nw' || corner === 'ne') {
    top = clampRange(top + dy, 0, bottom - minHeight);
  } else {
    bottom = clampRange(bottom + dy, top + minHeight, image.height);
  }

  // **Through `clampCrop` on the way out**, and this is not belt and braces.
  // `minSide` is not a constant: it grows when the *displayed* width shrinks,
  // because the touch floor is measured in display pixels (`minCropSide`). A
  // phone turned sideways, a URL bar sliding in, a browser zoom — each of them
  // changes it between two gestures. The clamps above are then anchored on
  // `right - minWidth` and `bottom - minHeight`, which can lie outside the
  // image, and `clampRange` answers an empty interval with its lower bound.
  //
  // Measured in the crop-dialog review: a 96 × 96 frame at (900, 504) on a
  // 1000 × 600 image, displayed width dropping from 1000 to 120 px, one
  // Shift+Arrow — and the frame reads 367 × 367 at (900, 504), i.e. right
  // 1267 and bottom 871 on an image that ends at 1000 × 600. It was drawn
  // outside the picture, the readout said so, and the *submit* then clamped
  // silently to (633, 233): the file uploaded was a section nobody had seen.
  return clampCrop(
    { x: left, y: top, width: right - left, height: bottom - top },
    image,
    minSide,
  );
}

/**
 * The longest edge of the file that leaves the browser: **768 px**.
 *
 * Read off the render sites rather than chosen for roundness. The largest box
 * this application puts a logo in is the public fill-in header's 220 × 96
 * (`--layout-logo-width-fill` / `--layout-logo-height-fill`); on a phone with a
 * device pixel ratio of 3 that is 660 device pixels on the long edge. 768
 * covers it with headroom, and everything above it is bytes that no screen this
 * application draws on can resolve.
 */
export const MAX_OUTPUT_EDGE = 768;

/**
 * How large the written file is — the crop, scaled down to {@link MAX_OUTPUT_EDGE}.
 *
 * **Never up.** Enlarging a small crest would add bytes and no detail, and it
 * would hide from the editor that the picture they chose is small; the renderers
 * scale it up anyway, and they do it with the browser's filter rather than ours.
 */
export function outputSize(crop: CropRect, maxEdge = MAX_OUTPUT_EDGE): Size {
  const longest = Math.max(crop.width, crop.height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  return {
    width: Math.max(1, Math.round(crop.width * scale)),
    height: Math.max(1, Math.round(crop.height * scale)),
  };
}

/**
 * What the frame currently is, in words — read out on every change and shown
 * next to the stage.
 *
 * A crop frame has no ARIA role that carries a value (it is not a slider and not
 * a spinbutton), so the value has to be text. It names the **output** size, not
 * the source rectangle, because that is the number the editor can act on: it is
 * what the file will contain.
 */
export function cropSummary(crop: CropRect): string {
  const size = outputSize(crop);
  return `Ausschnitt ${String(size.width)} × ${String(size.height)} Pixel, linke obere Ecke bei ${String(Math.round(crop.x))}, ${String(Math.round(crop.y))}.`;
}

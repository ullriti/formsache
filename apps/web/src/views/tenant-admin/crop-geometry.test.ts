import { describe, expect, it } from 'vitest';

import {
  MAX_OUTPUT_EDGE,
  MIN_CROP_DISPLAY_PX,
  MIN_CROP_SOURCE_PX,
  clampCrop,
  cropSummary,
  initialCrop,
  minCropOnAxis,
  minCropSide,
  moveCrop,
  outputSize,
  resizeCrop,
  sourcePerDisplayPixel,
  type CropRect,
  type Size,
} from './crop-geometry';

/**
 * The arithmetic of the Logo crop frame.
 *
 * The frame's *behaviour* is measured in a browser (`e2e/tenant-admin*.spec.ts`)
 * because a pointer gesture needs a layout. What is measured here is everything
 * a layout cannot show: the edges — an image narrower than the minimum crop, a
 * drag that leaves the picture, a crop smaller than the box it will be rendered
 * in.
 */

const IMAGE: Size = { width: 1000, height: 600 };

describe('the crop frame', () => {
  it('opens around the whole picture, so „nichts zuschneiden" cuts nothing', () => {
    expect(initialCrop(IMAGE)).toEqual({
      x: 0,
      y: 0,
      width: 1000,
      height: 600,
    });
  });

  describe('moving', () => {
    it('keeps its size when it runs into an edge', () => {
      const crop = { x: 100, y: 100, width: 400, height: 300 };

      const moved = moveCrop(crop, IMAGE, -1000, -1000);

      expect(moved).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    });

    it('stops at the far edge rather than leaving the picture', () => {
      const crop = { x: 100, y: 100, width: 400, height: 300 };

      const moved = moveCrop(crop, IMAGE, 5000, 5000);

      // 1000 − 400 and 600 − 300: the frame's own size is subtracted, so the
      // whole frame stays inside, not just its top-left corner.
      expect(moved).toEqual({ x: 600, y: 300, width: 400, height: 300 });
    });

    /**
     * **The reason a gesture is measured from where it started.** Clamping is
     * idempotent, so a drag past the edge and back returns to the frame the
     * editor had — an implementation that added each move's delta to the
     * *current* crop would have eaten the overshoot and the frame would lag
     * behind the finger by however far it was pushed.
     *
     * *Reproduction:* apply the same two deltas cumulatively
     * (`moveCrop(moveCrop(crop, −1000, 0), +900, 0)`) → x = 900, not 100.
     */
    it('is unchanged by a drag that overshoots and comes back', () => {
      const crop = { x: 100, y: 100, width: 400, height: 300 };

      expect(moveCrop(crop, IMAGE, -1000, 0)).toEqual({ ...crop, x: 0 });
      expect(moveCrop(crop, IMAGE, 0, 0)).toEqual(crop);
    });
  });

  describe('resizing', () => {
    it('holds the opposite corner still', () => {
      const crop = { x: 200, y: 100, width: 400, height: 300 };

      const resized = resizeCrop(crop, IMAGE, 'nw', 50, 40, MIN_CROP_SOURCE_PX);

      // The south-east corner was at (600, 400) and still is.
      expect(resized).toEqual({ x: 250, y: 140, width: 350, height: 260 });
    });

    it('never shrinks past the minimum side', () => {
      const crop = { x: 0, y: 0, width: 400, height: 300 };

      const resized = resizeCrop(crop, IMAGE, 'se', -1000, -1000, 96);

      expect(resized).toEqual({ x: 0, y: 0, width: 96, height: 96 });
    });

    it('never grows past the picture', () => {
      const crop = { x: 800, y: 500, width: 100, height: 50 };

      const resized = resizeCrop(crop, IMAGE, 'se', 9000, 9000, 96);

      expect(resized).toEqual({ x: 800, y: 500, width: 200, height: 100 });
    });

    /**
     * The empty-interval case `clampRange` exists for: an image narrower than
     * the minimum crop makes `right − min` negative. With a plain
     * `Math.min(Math.max(…))` the reversed interval returns the *wrong* end and
     * the frame jumps outside the picture.
     *
     * *Reproduction:* replace `clampRange` with
     * `Math.min(Math.max(v, lo), hi)` → x becomes −56 instead of 0.
     */
    it('survives a picture smaller than the minimum crop', () => {
      const tiny: Size = { width: 40, height: 40 };
      const crop = initialCrop(tiny);

      // The floor itself is 96; the **axis** cap is what a 40 px picture
      // brings it down to (the crop-dialog review: capping inside
      // `minCropSide` with the shorter side gave away the touch target on a
      // banner).
      const min = minCropSide(0);
      expect(min).toBe(MIN_CROP_SOURCE_PX);
      expect(minCropOnAxis(min, tiny.width)).toBe(40);

      expect(resizeCrop(crop, tiny, 'nw', -100, -100, min)).toEqual({
        x: 0,
        y: 0,
        width: 40,
        height: 40,
      });
      expect(resizeCrop(crop, tiny, 'se', 100, 100, min)).toEqual({
        x: 0,
        y: 0,
        width: 40,
        height: 40,
      });
    });
  });

  describe('the minimum side changing between two gestures', () => {
    /**
     * **The frame must not leave the picture when the floor grows** (the
     * crop-dialog review's one blocking defect).
     *
     * `minSide` is not a constant: the touch floor is counted in *displayed*
     * pixels, so turning a phone sideways, a URL bar sliding in or a browser
     * zoom changes it between one gesture and the next. `resizeCrop` anchors
     * its clamps on `right - minWidth`, which then lies outside the image, and
     * `clampRange` answers an empty interval with its lower bound.
     *
     * Measured before the fix: the frame read 367 × 367 at (900, 504) on a
     * 1000 × 600 image — right 1267, bottom 871 — was drawn outside the
     * picture, and the submit clamped silently to (633, 233). The file uploaded
     * was a section nobody had seen.
     *
     * *Reproduction:* drop the closing `clampCrop` from `resizeCrop` → this
     * case is red on `right`.
     */
    it('keeps the frame inside when the floor grew since it was sized', () => {
      const image: Size = { width: 1000, height: 600 };
      const small: CropRect = { x: 900, y: 504, width: 96, height: 96 };

      // The dialog got narrow: 1000 source pixels across 120 display pixels.
      const grown = minCropSide(sourcePerDisplayPixel(image, 120));
      expect(grown).toBeGreaterThan(small.width);

      // The **`se`** corner is where the interval turns empty: its lower bound
      // is `left + minWidth` = 1267 on an image 1000 wide, and `clampRange`
      // answers an empty interval with that lower bound. The `nw` corner
      // happens to stay inside, which is why the case has to name the corner
      // rather than trust „a resize".
      const resized = resizeCrop(small, image, 'se', 1, 1, grown);

      expect(resized.x + resized.width).toBeLessThanOrEqual(image.width);
      expect(resized.y + resized.height).toBeLessThanOrEqual(image.height);
      expect(resized.x).toBeGreaterThanOrEqual(0);
      expect(resized.y).toBeGreaterThanOrEqual(0);
    });
  });

  describe('the minimum side', () => {
    it('is the tallest render box when the picture is shown at 1:1', () => {
      // `--layout-logo-height-fill: 96px` — see MIN_CROP_SOURCE_PX.
      expect(minCropSide(1)).toBe(MIN_CROP_SOURCE_PX);
    });

    /**
     * A 4000 px photo shown 500 px wide: one screen pixel is 8 source pixels,
     * so a 44 px touch target is 352 source pixels — far above the 96 px render
     * floor, which is exactly why both floors exist rather than one.
     */
    it('grows with the display scale, so a corner stays touchable', () => {
      const photo: Size = { width: 4000, height: 3000 };
      const perPixel = sourcePerDisplayPixel(photo, 500);

      expect(perPixel).toBe(8);
      expect(minCropSide(perPixel)).toBe(MIN_CROP_DISPLAY_PX * 8);
    });

    /**
     * **A banner keeps its touch target on the long axis** (the crop-dialog
     * review).
     *
     * Capping the floor with the *shorter* side of the image on both axes made
     * a 4000 × 200 picture collapse the minimum to 200 source pixels — 25
     * display pixels at a width of 500 px, well under the 44 a finger needs.
     * The height is legitimately capped by the height; the width is not.
     *
     * *Reproduction:* cap both axes with `Math.min(minSide, image.width,
     * image.height)` again → the width floor drops to 200 and this is red.
     */
    it('caps each axis with its own side, not with the shorter one', () => {
      const banner: Size = { width: 4000, height: 200 };
      const floor = minCropSide(sourcePerDisplayPixel(banner, 500));

      expect(floor).toBe(MIN_CROP_DISPLAY_PX * 8);
      expect(minCropOnAxis(floor, banner.width)).toBe(MIN_CROP_DISPLAY_PX * 8);
      // The height genuinely cannot be more than the picture is tall.
      expect(minCropOnAxis(floor, banner.height)).toBe(200);
    });

    it('falls back to the render floor when nothing is laid out yet', () => {
      expect(sourcePerDisplayPixel(IMAGE, 0)).toBe(0);
      expect(minCropSide(0)).toBe(MIN_CROP_SOURCE_PX);
    });
  });

  describe('clamping a frame from elsewhere', () => {
    it('pulls an out-of-bounds frame back inside', () => {
      const clamped = clampCrop(
        { x: -50, y: 900, width: 5000, height: 10 },
        IMAGE,
        96,
      );

      // y is pulled to 600 − 96, not to 0: clamping puts the frame back inside
      // the picture, it does not reset it to the origin.
      expect(clamped).toEqual({ x: 0, y: 504, width: 1000, height: 96 });
    });
  });
});

describe('the file that leaves the browser', () => {
  it('scales a large crop down to the longest edge', () => {
    expect(outputSize({ x: 0, y: 0, width: 4000, height: 3000 })).toEqual({
      width: MAX_OUTPUT_EDGE,
      height: 576,
    });
  });

  /**
   * **Never up.** Enlarging adds bytes and no detail, and it hides from the
   * editor that the picture they chose is small.
   *
   * *Reproduction:* drop the `longest > maxEdge` guard → a 120 px crest is
   * written as 768 px, a file roughly 40× the size with the same information.
   */
  it('leaves a small crop at its own size', () => {
    expect(outputSize({ x: 0, y: 0, width: 120, height: 90 })).toEqual({
      width: 120,
      height: 90,
    });
  });

  it('never writes a zero-pixel canvas', () => {
    // Unreachable through the UI (the minimum side stops it), and a canvas of
    // width 0 throws in `drawImage` rather than producing an empty file.
    expect(outputSize({ x: 0, y: 0, width: 0.2, height: 4000 })).toEqual({
      width: 1,
      height: MAX_OUTPUT_EDGE,
    });
  });

  it('reports the output size, not the source rectangle', () => {
    expect(cropSummary({ x: 10.4, y: 20.6, width: 4000, height: 2000 })).toBe(
      'Ausschnitt 768 × 384 Pixel, linke obere Ecke bei 10, 21.',
    );
  });
});

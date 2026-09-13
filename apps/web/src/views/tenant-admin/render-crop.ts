import { outputSize, type CropRect } from './crop-geometry';

/**
 * Turning the chosen frame into the file that goes to the server
 * (ADR-0014 no. 20).
 *
 * **The upload chain is untouched.** What leaves here is an ordinary `File`
 * that walks into the same `POST /api/tenant/branding/logo` a raw pick used to
 * walk into, and the server checks it exactly as before — signature at offset 0,
 * allow list PNG/JPEG, 2 MiB (ADR-0014 no. 5, no. 6). Cropping in the browser
 * buys a picture the editor chose; it buys **no** trust.
 */

/**
 * **PNG, always — whatever came in.**
 *
 * Three reasons, in the order they matter here:
 *
 * 1. **Transparency.** A Logo regularly has some, and it is rendered on a
 *    white plate in the header (`tenant-mark.css`) and on the tenant's canvas
 *    tone on the public page. JPEG has no alpha channel: every transparent
 *    pixel would come out as whatever the canvas held, and the mark would carry
 *    a visible rectangle on one of the two surfaces.
 * 2. **What a crest is made of.** Flat areas and hard edges — the content JPEG's
 *    frequency transform is worst at. At the sizes involved the ringing around
 *    a black outline is visible and the file is not meaningfully smaller.
 * 3. **One format, not a choice.** The alternative („JPEG when the source had no
 *    alpha") is a rule whose failure mode is a logo with a black box behind
 *    it, found by whoever looks at the public page after the fact.
 *
 * The price is named rather than hidden: a *photograph* cropped as a logo
 * re-encodes to PNG and can be several hundred KiB where JPEG would be tens.
 * At 768 px it stays well inside the 2 MiB limit, and if it ever did not, the
 * server refuses it with its own sentence — no silent path.
 */
export const LOGO_OUTPUT_TYPE = 'image/png';

/**
 * The dialog could not produce a file.
 *
 * Its own class, because it is the one failure of this module the view has to
 * be able to tell apart from an upload failure — the editor is still standing
 * in front of their picture and the honest thing to say is „try again", not
 * „the server refused it".
 */
export class CropRenderError extends Error {
  constructor(cause: string) {
    super(`The crop could not be rendered: ${cause}`);
    this.name = 'CropRenderError';
  }
}

/**
 * `logo.jpg` → `logo.png`; the name must not claim the old type.
 *
 * `{0,10}` rather than `{1,10}`: a name ending in a bare dot („logo.") would
 * otherwise keep it and become „logo..png" (the crop-dialog review).
 */
export function croppedFileName(original: string): string {
  const base = original.replace(/\.[^./\\]{0,10}$/u, '').trim();
  return base === '' ? 'logo.png' : `${base}.png`;
}

/**
 * `canvas.toBlob` as a promise that **cannot resolve with nothing**.
 *
 * The callback is specified to receive `null` when the image could not be
 * encoded, and a `?.` or an `if (blob) …` there is precisely the shape this
 * project has to guard against: the editor presses „übernehmen", the
 * dialog closes, no request is sent, and nothing on the screen says why. It
 * rejects instead, and the caller shows a sentence.
 */
function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new CropRenderError('toBlob produced no blob'));
        return;
      }
      resolve(blob);
    }, type);
  });
}

/**
 * Draws `crop` out of `source` and hands back the file to upload.
 *
 * @param source the loaded `<img>` — the same element the editor was looking
 *   at, so what is written is what the frame was over. Browsers apply EXIF
 *   orientation to an `<img>` and report the oriented size in
 *   `naturalWidth`/`naturalHeight`, which is why the frame's coordinates and
 *   `drawImage`'s source rectangle agree without a rotation of our own.
 *
 * Re-encoding through a canvas also drops every piece of metadata the original
 * carried — EXIF included, and with it the GPS coordinates a phone writes into
 * a photo. ADR-0014 names that as an unsolved point for attachments; for the
 * Logo it falls out of this step, and it is worth saying so, because it is
 * the sort of property that gets lost the moment somebody „optimises" this
 * module into a straight byte pass-through.
 */
export async function renderCroppedLogo(
  source: CanvasImageSource,
  crop: CropRect,
  originalName: string,
): Promise<File> {
  const size = outputSize(crop);

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new CropRenderError('no 2d context');
  }

  context.drawImage(
    source,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    size.width,
    size.height,
  );

  const blob = await encode(canvas, LOGO_OUTPUT_TYPE);
  return new File([blob], croppedFileName(originalName), {
    type: LOGO_OUTPUT_TYPE,
  });
}

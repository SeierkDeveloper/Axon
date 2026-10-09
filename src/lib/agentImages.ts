// Pictures, made ready for a model to look at.
//
// A model looks at a picture at a limited size: past about 1,568 pixels on the long side it is scaled down on arrival
// anyway, and it costs more for nothing. A phone photo or a full-screen capture is far larger than that. So a picture
// that is too large is scaled down here, once, before it is handed over. The stored file is never changed, and the
// hash a receipt commits to is always the hash of what was uploaded.
//
// A picture that already fits goes through untouched, byte for byte.

import { logger } from "./logger";

/** The long side a picture is brought down to. */
export const MAX_SIDE = 1568;
/** A picture already under this many bytes and inside MAX_SIDE is handed over as it is. */
export const PASS_BYTES = 3 * 1024 * 1024;

export interface ReadyImage { data: Buffer; mime: string; scaled: boolean; width: number | null; height: number | null }

type Sharp = typeof import("sharp");
let sharpLib: Sharp | null | undefined;
async function sharp(): Promise<Sharp | null> {
  if (sharpLib !== undefined) return sharpLib;
  try {
    sharpLib = (await import("sharp")).default as unknown as Sharp;
  } catch (err) {
    logger.warn("images.no_sharp", "The image library is not available: pictures are handed over unscaled", { err });
    sharpLib = null;
  }
  return sharpLib;
}

/**
 * A picture as a model should get it. Scaled to fit MAX_SIDE when it is larger or heavy, an animation reduced to its
 * first frame, kept as PNG when it has transparency and as JPEG otherwise. Never throws: a picture that cannot be
 * read is handed over as it came, and the model says what it can make of it.
 */
export async function forModel(bytes: Buffer, mime: string): Promise<ReadyImage> {
  const asIs: ReadyImage = { data: bytes, mime, scaled: false, width: null, height: null };
  const lib = await sharp();
  if (!lib) return asIs;
  try {
    const meta = await lib(bytes, { animated: false }).metadata();
    const width = meta.width ?? 0, height = meta.height ?? 0;
    if (!width || !height) return asIs;
    const animated = (meta.pages ?? 1) > 1;
    const fits = Math.max(width, height) <= MAX_SIDE && bytes.length <= PASS_BYTES && !animated;
    if (fits) return { ...asIs, width, height };
    const base = lib(bytes, { animated: false }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
    const out = meta.hasAlpha
      ? await base.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await base.jpeg({ quality: 86, mozjpeg: true }).toBuffer({ resolveWithObject: true });
    return { data: out.data, mime: meta.hasAlpha ? "image/png" : "image/jpeg", scaled: true, width: out.info.width, height: out.info.height };
  } catch (err) {
    logger.warn("images.unreadable", "A picture could not be read for scaling: handed over as it came", { err, mime, size: bytes.length });
    return asIs;
  }
}

/** Whether pictures can be scaled here at all. Without it, a picture over the model's limit has to be refused. */
export async function canScale(): Promise<boolean> {
  return (await sharp()) !== null;
}

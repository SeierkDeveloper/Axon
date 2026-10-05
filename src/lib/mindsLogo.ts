// Agent Minds: a token's picture.
//
// The launch transaction carries a link to the picture, so the picture has to live somewhere that link keeps working.
// It lives here: small, checked to be a real image by its own first bytes (never by what the upload called itself),
// and stored under the hash of its bytes.

import { createHash } from "node:crypto";
import { getDb } from "./db";

export const LOGO_LIMITS = { bytes: 512 * 1024, perDay: 30 } as const;

/** The kind of image these bytes are, read from the bytes themselves. SVG is not one of them: it can carry script. */
export function imageKind(b: Buffer): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "image/gif";
  return null;
}

/** Keep a picture for a wallet. Returns its id, or why not. */
export function saveLogo(wallet: string, bytes: Buffer): { id: string; mime: string } | string {
  if (!bytes.length) return "That file is empty.";
  if (bytes.length > LOGO_LIMITS.bytes) return "That picture is too large. Use one under 500 KB.";
  const mime = imageKind(bytes);
  if (!mime) return "Use a PNG, JPEG, WebP or GIF picture.";
  const me = wallet.toLowerCase();
  const db = getDb();
  const today = (db.prepare("SELECT COUNT(*) n FROM mind_logos WHERE wallet = ? AND created_at >= ?").get(me, new Date(Date.now() - 86_400_000).toISOString()) as { n: number }).n;
  if (today >= LOGO_LIMITS.perDay) return "That is a lot of pictures today. Try again tomorrow.";
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 40);
  db.prepare("INSERT INTO mind_logos (id, wallet, mime, bytes, size, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING").run(id, me, mime, bytes, bytes.length, new Date().toISOString());
  return { id, mime };
}

export function getLogo(id: string): { mime: string; bytes: Buffer } | null {
  if (!/^[0-9a-f]{40}$/.test(id)) return null;
  const r = getDb().prepare("SELECT mime, bytes FROM mind_logos WHERE id = ?").get(id) as { mime: string; bytes: Buffer } | undefined;
  return r ?? null;
}

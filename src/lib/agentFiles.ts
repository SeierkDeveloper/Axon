// Files for agents: what somebody hands an agent to work on, and what an agent hands back.
//
// This is the store and its rules, nothing else: taking a file in, deciding what it is, keeping it, handing it back to
// whoever may read it, and clearing it when its time is up. Attaching a file to a hire and letting an agent read it
// build on this.
//
// The rules the whole thing rests on:
//
//   What a file IS comes from its bytes. The type the uploader states and the name they give are never trusted: a
//   file is a PDF because it starts like one, an image because it starts like one, text because it decodes as text.
//   Anything else is refused, so nothing executable, no archive and no office macro ever lands here.
//
//   A file is never served as a page. It always goes out as a download, with its sniffed type, under a sandbox policy,
//   so an uploaded file cannot run in anybody's browser on our origin.
//
//   Reading a file takes either the key of the wallet that uploaded it or the file's own token, which is handed to the
//   uploader once. A visitor who is not signed in has only the token. Nothing here is public.
//
//   The bytes are stored once per content, named by their SHA-256. That hash is also what a receipt can commit to.
//
//   It cannot fill the volume: one file has a size limit, an uploader a daily allowance, and the store a ceiling; and
//   an upload is refused when the volume itself is nearly full, whoever is asking.
//
// AGENT_FILES=on switches it on. Off (the default) every route answers as if it did not exist.

import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb, getDbPath } from "./db";
import { logger } from "./logger";

export function filesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AGENT_FILES ?? "off").trim().toLowerCase() === "on";
}

const MB = 1024 * 1024;
const DAY_MS = 86_400_000;

const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

/** The largest single file, in bytes. AXON_FILE_MAX_MB, 10 by default, 25 at most. */
export const maxFileBytes = (env: Record<string, string | undefined> = process.env): number => num(env.AXON_FILE_MAX_MB, 10, 1, 25) * MB;
/** What the whole store may hold, in bytes. AXON_FILES_MAX_GB, 2 by default. */
export const maxStoreBytes = (env: Record<string, string | undefined> = process.env): number => num(env.AXON_FILES_MAX_GB, 2, 0.01, 50) * 1024 * MB;
/** An upload is refused when the volume would be left with less free space than this: 500 MB, or a fifth of a small volume. */
export const MIN_FREE_BYTES = 500 * MB;
export const reserveFor = (volumeBytes: number): number => Math.min(MIN_FREE_BYTES, Math.floor(volumeBytes * 0.2));
/** How many files one hire may carry. */
export const MAX_FILES_PER_TASK = 5;

/** What one uploader may add in a day. A visitor is counted by address; a wallet by itself. */
export const DAILY = {
  guest: { files: 10, bytes: 20 * MB },
  wallet: { files: 100, bytes: 200 * MB },
} as const;

/** How long a file is kept. A visitor's goes after a week, a wallet's after thirty days. */
export const KEEP_MS = { guest: 7 * DAY_MS, wallet: 30 * DAY_MS } as const;
/** An upload nobody attached to a hire is cleared after this long. */
export const UNATTACHED_MS = DAY_MS;

export type FileKind = "pdf" | "image" | "text";
export interface Sniffed { mime: string; kind: FileKind; ext: string }

const starts = (b: Buffer, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/** The text types a name may ask for. The bytes decide that it is text; the name only says which kind. */
const TEXT_BY_EXT: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", log: "text/plain",
};

/**
 * What these bytes are, or null when they are nothing an agent may be handed. Read from the bytes alone; the name is
 * only used to tell one kind of text from another.
 */
export function sniff(bytes: Buffer, name = ""): Sniffed | null {
  if (bytes.length === 0) return null;
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: "application/pdf", kind: "pdf", ext: "pdf" };
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", kind: "image", ext: "png" };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", kind: "image", ext: "jpg" };
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return { mime: "image/gif", kind: "image", ext: "gif" };
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { mime: "image/webp", kind: "image", ext: "webp" };
  // text: it must decode as UTF-8 and hold no control characters but tab, newline and carriage return
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
   
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return null;
  const ext = (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "").toLowerCase();
  const mime = TEXT_BY_EXT[ext];
  return mime ? { mime, kind: "text", ext } : { mime: "text/plain", kind: "text", ext: "txt" };
}

/** A name safe to keep and to put in a header: the last path part, no control characters, a sane length. */
export function cleanName(raw: unknown, ext: string): string {
  const s = typeof raw === "string" ? raw : "";
   
  let base = (s.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "").replace(/\s+/g, " ").replace(/^\.+/, "").trim();
  if (base.length > 120) {
    const e = /\.[a-z0-9]{1,8}$/i.exec(base)?.[0] ?? "";
    base = base.slice(0, 120 - e.length).trim() + e;
  }
  return base || `file.${ext}`;
}

export function filesDir(env: Record<string, string | undefined> = process.env): string {
  return env.AXON_FILES_DIR?.trim() || path.join(path.dirname(getDbPath()), "files");
}
const blobPath = (sha: string, dir = filesDir()) => path.join(dir, sha.slice(0, 2), sha.slice(2, 4), sha);

export const sha256Of = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

// ── The file's own token ─────────────────────────────────────────────────────────────────────────────────────────────
// Possession of it is the permission to read that one file. Derived, not stored, in the same way a task's claim token
// is, and kept apart from it so neither can stand in for the other.

export function fileTokenFor(fileId: string): string {
  const seed = process.env.SEED_SECRET ?? "";
  if (!seed && process.env.NODE_ENV === "production") throw new Error("SEED_SECRET is required to mint file tokens");
  return createHmac("sha256", `axon-file:${seed}`).update(fileId).digest("hex").slice(0, 32);
}
export function fileTokenValid(fileId: string, token: unknown): boolean {
  if (typeof token !== "string" || !token) return false;
  const expected = Buffer.from(fileTokenFor(fileId)), given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ── Rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FileRow {
  id: string; sha256: string; name: string; mime: string; kind: FileKind; size: number; direction: "in" | "out";
  owner_wallet: string | null; task_id: string | null; created_at: string; expires_at: string; deleted_at: string | null;
}
export interface FileView {
  id: string; name: string; mime: string; kind: FileKind; size: number; sha256: string; direction: "in" | "out";
  taskId: string | null; createdAt: string; expiresAt: string;
}
export const toView = (r: FileRow): FileView => ({
  id: r.id, name: r.name, mime: r.mime, kind: r.kind, size: r.size, sha256: r.sha256, direction: r.direction,
  taskId: r.task_id, createdAt: r.created_at, expiresAt: r.expires_at,
});

/** A file that is still there: not deleted and not past its time. */
export function getFile(id: string, now = Date.now()): FileRow | null {
  if (!/^f_[0-9a-f]{32}$/.test(id)) return null;
  const r = getDb().prepare("SELECT * FROM task_files WHERE id = ? AND deleted_at IS NULL").get(id) as FileRow | undefined;
  return r && Date.parse(r.expires_at) > now ? r : null;
}

/** Whether this caller may read the file: the wallet that uploaded it, or anyone holding its token. */
export function mayRead(file: FileRow, who: { wallet?: string | null; token?: unknown }): boolean {
  if (file.owner_wallet && who.wallet && file.owner_wallet === who.wallet.toLowerCase()) return true;
  return fileTokenValid(file.id, who.token);
}

export function readBytes(file: FileRow): Buffer | null {
  try {
    return fs.readFileSync(blobPath(file.sha256));
  } catch {
    return null;
  }
}

/** What is stored right now, counting each blob once. */
export function storeBytes(): number {
  return (getDb().prepare("SELECT COALESCE(SUM(size), 0) v FROM (SELECT sha256, MAX(size) size FROM task_files WHERE deleted_at IS NULL GROUP BY sha256)").get() as { v: number }).v;
}

/** What a wallet has added since a point in time. A visitor is held to their allowance by the route's rate limiter. */
export function addedSince(wallet: string, sinceIso: string): { files: number; bytes: number } {
  return getDb().prepare("SELECT COUNT(*) files, COALESCE(SUM(size), 0) bytes FROM task_files WHERE owner_wallet = ? AND created_at >= ? AND direction = 'in'").get(wallet.toLowerCase(), sinceIso) as { files: number; bytes: number };
}

function volume(dir: string): { free: number; total: number } | null {
  try {
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null; // cannot tell: the write itself fails cleanly if the disk is full
  }
}

export type StoreRefusal = "empty" | "too_large" | "type" | "quota" | "store_full" | "disk_full" | "write_failed";
export type StoreResult = { ok: true; file: FileView; token: string } | { ok: false; refused: StoreRefusal; reason: string; status: 400 | 413 | 415 | 429 | 507 };

const no = (status: 400 | 413 | 415 | 429 | 507, refused: StoreRefusal, reason: string): StoreResult => ({ ok: false, refused, reason, status });

/**
 * Take a file in. Returns what was stored and its token, or a plain reason it was not. Nothing is written unless
 * every rule passes; a file already held (the same bytes) is not written a second time.
 */
export function storeFile(input: { bytes: Buffer; name?: unknown; wallet?: string | null; direction?: "in" | "out"; taskId?: string | null }, o: { now?: number; env?: Record<string, string | undefined> } = {}): StoreResult {
  const env = o.env ?? process.env, now = o.now ?? Date.now();
  const { bytes } = input;
  const wallet = input.wallet ? input.wallet.toLowerCase() : null;
  if (bytes.length === 0) return no(400, "empty", "The file is empty.");
  const max = maxFileBytes(env);
  if (bytes.length > max) return no(413, "too_large", `A file is at most ${Math.round(max / MB)} MB. This one is ${(bytes.length / MB).toFixed(1)} MB.`);
  const what = sniff(bytes, typeof input.name === "string" ? input.name : "");
  if (!what) return no(415, "type", "Only PDFs, images (PNG, JPEG, GIF, WebP) and plain text files (text, Markdown, CSV, JSON) can be handed to an agent.");
  if (wallet && (input.direction ?? "in") === "in") {
    const day = addedSince(wallet, new Date(now - DAY_MS).toISOString());
    if (day.files + 1 > DAILY.wallet.files || day.bytes + bytes.length > DAILY.wallet.bytes) {
      return no(429, "quota", `That is past what one wallet can upload in a day (${DAILY.wallet.files} files, ${DAILY.wallet.bytes / MB} MB). Try again tomorrow.`);
    }
  }
  const sha = sha256Of(bytes), dir = filesDir(env), target = blobPath(sha, dir);
  const held = fs.existsSync(target);
  if (!held) {
    if (storeBytes() + bytes.length > maxStoreBytes(env)) return no(507, "store_full", "File storage is full right now. Try again later.");
    const vol = volume(fs.existsSync(dir) ? dir : path.dirname(dir));
    if (vol && vol.free - bytes.length < reserveFor(vol.total)) return no(507, "disk_full", "File storage is full right now. Try again later.");
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${randomBytes(6).toString("hex")}.part`;
      fs.writeFileSync(tmp, bytes, { flag: "wx" });
      fs.renameSync(tmp, target);
    } catch (err) {
      logger.warn("files.write_failed", "A file could not be written", { err, size: bytes.length });
      return no(507, "write_failed", "The file could not be saved. Try again.");
    }
  }
  const id = `f_${randomBytes(16).toString("hex")}`;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + (wallet ? KEEP_MS.wallet : KEEP_MS.guest)).toISOString();
  getDb().prepare("INSERT INTO task_files (id, sha256, name, mime, kind, size, direction, owner_wallet, task_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, sha, cleanName(input.name, what.ext), what.mime, what.kind, bytes.length, input.direction ?? "in", wallet, input.taskId ?? null, createdAt, expiresAt);
  return { ok: true, file: toView(getDb().prepare("SELECT * FROM task_files WHERE id = ?").get(id) as FileRow), token: fileTokenFor(id) };
}

/** Remove the bytes of a content hash when no live row holds them any more. */
function dropBlobIfUnused(sha: string): boolean {
  const still = getDb().prepare("SELECT 1 FROM task_files WHERE sha256 = ? AND deleted_at IS NULL LIMIT 1").get(sha);
  if (still) return false;
  try {
    fs.unlinkSync(blobPath(sha));
    return true;
  } catch {
    return false; // already gone
  }
}

/** Delete one file. Its bytes go too unless another upload holds the same content. */
export function deleteFile(id: string, now = Date.now()): boolean {
  const r = getDb().prepare("SELECT sha256 FROM task_files WHERE id = ? AND deleted_at IS NULL").get(id) as { sha256: string } | undefined;
  if (!r) return false;
  getDb().prepare("UPDATE task_files SET deleted_at = ? WHERE id = ?").run(new Date(now).toISOString(), id);
  dropBlobIfUnused(r.sha256);
  return true;
}

/**
 * Clear what is past its time: files past their expiry, and uploads nobody attached to a hire within a day. Their
 * rows are kept, marked deleted, so a receipt that names a hash still finds what it was; the bytes go.
 */
export function purgeExpiredFiles(now = Date.now()): { files: number; blobs: number } {
  const db = getDb();
  const nowIso = new Date(now).toISOString(), strayIso = new Date(now - UNATTACHED_MS).toISOString();
  const due = db.prepare("SELECT id, sha256 FROM task_files WHERE deleted_at IS NULL AND (expires_at <= ? OR (task_id IS NULL AND direction = 'in' AND created_at <= ?))").all(nowIso, strayIso) as { id: string; sha256: string }[];
  if (!due.length) return { files: 0, blobs: 0 };
  const mark = db.prepare("UPDATE task_files SET deleted_at = ? WHERE id = ?");
  db.transaction(() => { for (const r of due) mark.run(nowIso, r.id); })();
  let blobs = 0;
  for (const sha of new Set(due.map((r) => r.sha256))) if (dropBlobIfUnused(sha)) blobs++;
  return { files: due.length, blobs };
}

// ── A visitor's daily allowance ──────────────────────────────────────────────────────────────────────────────────────
// A wallet's day is read from its own rows. A visitor has no rows of their own, so their day is counted in the same
// table the rate limiter keeps its windows in, in kilobytes, under a key the route builds from their address.

/** Count `bytes` against a visitor's day. False when it would take them past their allowance (nothing is counted then). */
export function guestBytesAllowed(key: string, bytes: number, now = Date.now()): boolean {
  const db = getDb(), kb = Math.max(1, Math.ceil(bytes / 1024)), limit = Math.floor(DAILY.guest.bytes / 1024);
  return db.transaction((): boolean => {
    db.prepare("DELETE FROM rate_limit_windows WHERE key = ? AND reset_at <= ?").run(key, now);
    const row = db.prepare("SELECT count FROM rate_limit_windows WHERE key = ?").get(key) as { count: number } | undefined;
    if ((row?.count ?? 0) + kb > limit) return false;
    db.prepare("INSERT INTO rate_limit_windows (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = count + ?").run(key, kb, now + DAY_MS, kb);
    return true;
  })();
}
/** Give back what a refused upload was counted for. */
export function guestBytesRefund(key: string, bytes: number, now = Date.now()): void {
  const kb = Math.max(1, Math.ceil(bytes / 1024));
  getDb().prepare("UPDATE rate_limit_windows SET count = MAX(0, count - ?) WHERE key = ? AND reset_at > ?").run(kb, key, now);
}

/** Read a request body up to a limit. Null when it is longer: the rest is not read. */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer | null> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

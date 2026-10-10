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
import { forModel } from "./agentImages";
import { looksZip } from "./zip";
import { officeEnabled, officeText, officeType, officeTypeOf, OFFICE } from "./officeFiles";

export function filesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.AGENT_FILES ?? "off").trim().toLowerCase() === "on";
}

/**
 * Whether agents may run code. A second switch inside the first: AGENT_CODE=on, and only while files are on. Off, an
 * agent is handed files exactly as before and computes nothing.
 */
export function codeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return filesEnabled(env) && (env.AGENT_CODE ?? "off").trim().toLowerCase() === "on";
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

export type FileKind = "pdf" | "image" | "text" | "office";
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
  // Word, Excel and PowerPoint: a ZIP archive that is one of the three, and only where they are switched on. Any
  // other archive is nothing an agent is handed.
  if (looksZip(bytes)) {
    const office = officeEnabled() ? officeType(bytes) : null;
    return office ? { mime: OFFICE[office].mime, kind: "office", ext: office } : null;
  }
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

function filesDir(env: Record<string, string | undefined> = process.env): string {
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
  /** the job this file first belonged to, when it was handed on from another job; null for an upload */
  source_task_id?: string | null;
  /** a revision: its number (2 and up), the content it replaces, the first version's content, and the job that made that */
  version?: number | null;
  revises_sha256?: string | null;
  first_sha256?: string | null;
  first_task_id?: string | null;
}

/** What a listing says about a file that is a revision. Nothing for a file that is not one. */
export interface VersionInfo { version: number; revises: string; first: { sha256: string; taskId: string | null } }
export const versionInfo = (r: FileRow): { version?: number; revises?: string; first?: VersionInfo["first"] } =>
  r.version && r.version > 1 && r.revises_sha256 && r.first_sha256
    ? { version: r.version, revises: r.revises_sha256, first: { sha256: r.first_sha256, taskId: r.first_task_id ?? null } }
    : {};
export interface FileView {
  /** `type` and `mime` are the same thing: `type` is what every other listing of a file calls it */
  id: string; name: string; type: string; mime: string; kind: FileKind; size: number; sha256: string; direction: "in" | "out";
  taskId: string | null; createdAt: string; expiresAt: string;
}
export const toView = (r: FileRow): FileView => ({
  id: r.id, name: r.name, type: r.mime, mime: r.mime, kind: r.kind, size: r.size, sha256: r.sha256, direction: r.direction,
  taskId: r.task_id, createdAt: r.created_at, expiresAt: r.expires_at,
});

/** The line a file belongs to: the content of its first version. A file that revises nothing is its own line. */
export const lineOf = (r: Pick<FileRow, "sha256" | "first_sha256">): string => r.first_sha256 ?? r.sha256;

/** Of these files, each line's latest version only, in the order given. An older version of a file is not carried on. */
export function latestOnly(rows: FileRow[]): FileRow[] {
  const best = new Map<string, FileRow>();
  for (const r of rows) {
    const had = best.get(lineOf(r));
    if (!had || (r.version ?? 1) > (had.version ?? 1)) best.set(lineOf(r), r);
  }
  return rows.filter((r) => best.get(lineOf(r)) === r);
}

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
  return getDb().prepare("SELECT COUNT(*) files, COALESCE(SUM(size), 0) bytes FROM task_files WHERE owner_wallet = ? AND created_at >= ? AND direction = 'in' AND source_task_id IS NULL").get(wallet.toLowerCase(), sinceIso) as { files: number; bytes: number };
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

// ── Files on a hire ──────────────────────────────────────────────────────────────────────────────────────────────────
// A file is attached to exactly one hire. What it is (name, type, size, hash) is written into the hire's context, so
// the job's commitment and its receipt cover the files as much as the words. The agent is handed the bytes when it
// runs: text is put into the message, a PDF or a picture is given to the model as itself.

/**
 * What a model takes for one picture. A larger picture is scaled down before it is handed over (see agentImages), so
 * this only refuses a picture that is still too heavy after that, which a scaled picture never is.
 */
export const IMAGE_MAX_BYTES = 5 * MB;
/** How much text from files goes into one message. The rest is cut, and the message says so. */
export const INLINE_TEXT_CHARS = 120_000;
/**
 * What one hire may carry. A free hire is paid for by the project and a paid one by a price fixed in advance, so both
 * are bounded: a long PDF is the expensive case, and it is held by its page count where that can be read.
 */
export const TASK_FILES = {
  free: { files: 2, bytes: 2 * MB, pdfPages: 10 },
  paid: { files: MAX_FILES_PER_TASK, bytes: 10 * MB, pdfPages: 40 },
} as const;
/** The key in a hire's context that lists its files. A caller may not set it themselves. */
export const CONTEXT_KEY = "attachedFiles";

/** Pages in a PDF, counted from its page objects. Null when they cannot be seen (compressed object streams). */
export function pdfPages(bytes: Buffer): number | null {
  const found = bytes.toString("latin1").match(/\/Type\s*\/Page(?![s\w])/g);
  return found ? found.length : null;
}

export interface Reads { text: boolean; pdf: boolean; image: boolean; why: string | null }
/**
 * What kinds of file an agent can be handed. Text reaches every agent, since it goes into the message. A PDF or a
 * picture needs a model that takes them: an agent Axon runs on Claude reads both, one on GPT or Grok reads pictures.
 * An agent that runs on its own server fetches its files itself, so it is offered everything and decides what to do
 * with it.
 */
export function agentReads(agent: { provider?: string | null; endpoint?: string | null; orchestrator?: boolean }, o: { runsThroughMcp?: boolean } = {}): Reads {
  if (agent.endpoint && !agent.orchestrator && !o.runsThroughMcp) return { text: true, pdf: true, image: true, why: null };
  if (o.runsThroughMcp) return { text: true, pdf: false, image: false, why: "This agent takes text files only." };
  const provider = agent.provider ?? "anthropic";
  if (provider === "anthropic") return { text: true, pdf: true, image: true, why: null };
  // these models look at pictures; a PDF they are not given
  if (provider === "openai" || provider === "grok") return { text: true, pdf: false, image: true, why: "This agent reads pictures and text files, but not PDFs." };
  return { text: true, pdf: false, image: false, why: "This agent cannot read PDFs or pictures. Text files work with every agent." };
}

export interface AttachedFile { name: string; type: string; size: number; sha256: string }
export type AttachRefusal = "off" | "too_many" | "not_found" | "taken" | "too_large" | "kind" | "pages";
export type AttachCheck = { ok: true; rows: FileRow[]; listed: AttachedFile[] } | { ok: false; refused: AttachRefusal; reason: string };

const mb = (n: number) => `${+(n / MB).toFixed(1)} MB`;

/**
 * Whether these files may go on this hire. Nothing is changed: `attachFiles` does that once the hire exists. Every
 * file must be one the caller may read, not yet on another hire, of a kind the agent reads, and inside the limits.
 */
export function checkTaskFiles(input: { files: { id: string; token?: string }[]; wallet: string | null; reads: Reads; paid: boolean }, o: { now?: number; env?: Record<string, string | undefined> } = {}): AttachCheck {
  const no = (refused: AttachRefusal, reason: string): AttachCheck => ({ ok: false, refused, reason });
  if (!filesEnabled(o.env)) return no("off", "Files cannot be attached to a hire yet.");
  const limits = input.paid ? TASK_FILES.paid : TASK_FILES.free;
  const ids = [...new Set(input.files.map((f) => f.id))];
  if (ids.length !== input.files.length) return no("not_found", "The same file is listed twice.");
  if (ids.length > limits.files) return no("too_many", `${input.paid ? "A hire" : "A free hire"} carries at most ${limits.files} files.`);
  const rows: FileRow[] = [];
  let total = 0;
  for (const f of input.files) {
    const row = getFile(f.id, o.now);
    // a file the caller may not read answers exactly as one that does not exist
    if (!row || row.direction !== "in" || !mayRead(row, { wallet: input.wallet, token: f.token })) return no("not_found", `No file with the id ${String(f.id).slice(0, 40)}. Upload it first, and send its token if you are not signed in.`);
    if (row.task_id) return no("taken", `${row.name} is already attached to another hire. Upload it again to use it here.`);
    if (row.kind === "pdf" && !input.reads.pdf) return no("kind", `${row.name} is a PDF. ${input.reads.why ?? "This agent cannot read PDFs."}`);
    if (row.kind === "image" && !input.reads.image) return no("kind", `${row.name} is a picture. ${input.reads.why ?? "This agent cannot read pictures."}`);
    if (row.kind === "pdf") {
      const bytes = readBytes(row);
      if (!bytes) return no("not_found", `${row.name} is no longer stored. Upload it again.`);
      const pages = pdfPages(bytes);
      if (pages !== null && pages > limits.pdfPages) return no("pages", `${row.name} has ${pages} pages. ${input.paid ? "A hire" : "A free hire"} takes PDFs of up to ${limits.pdfPages} pages.`);
    }
    total += row.size;
    rows.push(row);
  }
  if (total > limits.bytes) return no("too_large", `These files are ${mb(total)} together. ${input.paid ? "A hire" : "A free hire"} carries at most ${mb(limits.bytes)}.`);
  return { ok: true, rows, listed: rows.map((r) => ({ name: r.name, type: r.mime, size: r.size, sha256: r.sha256 })) };
}

/** Put files on a hire. Only files not yet on one are taken, so two hires racing for a file cannot both have it. */
export function attachFiles(taskId: string, ids: string[]): number {
  const db = getDb(), set = db.prepare("UPDATE task_files SET task_id = ? WHERE id = ? AND task_id IS NULL AND deleted_at IS NULL");
  return db.transaction(() => ids.reduce((n, id) => n + set.run(taskId, id).changes, 0))();
}

/** The files on a hire, in the order they were uploaded. */
export function filesOfTask(taskId: string, direction: "in" | "out" = "in"): FileRow[] {
  return getDb().prepare("SELECT * FROM task_files WHERE task_id = ? AND direction = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC").all(taskId, direction) as FileRow[];
}

// ── Files between agents ─────────────────────────────────────────────────────────────────────────────────────────────
// A job is often more than one agent: an agent that hires specialists, a crew that runs in order, a pipeline. The
// files travel with the work. Nothing is uploaded again and no bytes are copied: a file handed on is a new row that
// points at the same stored content, and it remembers the job it came from.
//
// A job that is handed files carries what any hire may carry, and no more: the same count, size and page limits, and
// only the kinds its agent reads. What does not fit is left behind and named, never silently dropped.

export interface LeftBehind { name: string; why: string }

/**
 * Of these files, in this order of preference, the ones a hire of this agent can carry. The same content is taken
 * once. A file whose bytes are gone, of a kind the agent does not read, with too many pages, or past the hire's
 * count or size, is left behind with the reason.
 */
export function fitForHire(rows: FileRow[], reads: Reads, paid: boolean): { rows: FileRow[]; left: LeftBehind[] } {
  const limits = paid ? TASK_FILES.paid : TASK_FILES.free;
  const taken: FileRow[] = [], left: LeftBehind[] = [], seen = new Set<string>();
  let total = 0;
  for (const r of rows) {
    if (seen.has(r.sha256)) continue;
    seen.add(r.sha256);
    const leave = (why: string) => { left.push({ name: r.name, why }); };
    if (r.deleted_at || !fs.existsSync(blobPath(r.sha256))) { leave("it is no longer stored"); continue; }
    if (r.kind === "pdf" && !reads.pdf) { leave("this agent does not read PDFs"); continue; }
    if (r.kind === "image" && !reads.image) { leave("this agent does not read pictures"); continue; }
    if (taken.length >= limits.files) { leave(`a hire carries at most ${limits.files} files`); continue; }
    if (total + r.size > limits.bytes) { leave(`a hire carries at most ${mb(limits.bytes)}`); continue; }
    if (r.kind === "pdf") {
      const bytes = readBytes(r), pages = bytes ? pdfPages(bytes) : null;
      if (pages !== null && pages > limits.pdfPages) { leave(`it has ${pages} pages, and a hire takes up to ${limits.pdfPages}`); continue; }
    }
    total += r.size;
    taken.push(r);
  }
  return { rows: taken, left };
}

/** What a hire's context lists for these files. */
export const listFiles = (rows: FileRow[]): AttachedFile[] => rows.map((r) => ({ name: r.name, type: r.mime, size: r.size, sha256: r.sha256 }));

function copyRow(r: FileRow, to: { taskId: string | null; direction: "in" | "out"; wallet: string | null }, now: number): FileRow {
  const id = `f_${randomBytes(16).toString("hex")}`;
  const wallet = to.wallet ? to.wallet.toLowerCase() : null;
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + (wallet ? KEEP_MS.wallet : KEEP_MS.guest)).toISOString();
  // The job that MADE it: a file handed on twice still names where it was made. A file somebody uploaded was made
  // by no job, however far it travels.
  const source = r.source_task_id ?? (r.direction === "out" ? r.task_id : null);
  // a file handed on is still the version it was: the next change to it is the version after
  getDb().prepare("INSERT INTO task_files (id, sha256, name, mime, kind, size, direction, owner_wallet, task_id, created_at, expires_at, source_task_id, version, revises_sha256, first_sha256, first_task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, r.sha256, r.name, r.mime, r.kind, r.size, to.direction, wallet, to.taskId, createdAt, expiresAt, source, r.version ?? null, r.revises_sha256 ?? null, r.first_sha256 ?? null, r.first_task_id ?? null);
  return getDb().prepare("SELECT * FROM task_files WHERE id = ?").get(id) as FileRow;
}

/**
 * Hand files to a job as its input. With no job yet (`taskId` null) the copies wait, unattached, for the hire that
 * is about to be created to take them by id and token, exactly as uploads do.
 */
export function passFiles(rows: FileRow[], taskId: string | null, o: { wallet?: string | null; now?: number } = {}): FileRow[] {
  if (!rows.length) return [];
  const now = o.now ?? Date.now();
  // a millisecond apart, so the job lists them in the order they were handed over
  return getDb().transaction(() => rows.map((r, i) => copyRow(r, { taskId, direction: "in", wallet: o.wallet ?? null }, now + i)))();
}

/**
 * What one job handed back becomes part of what another hands back: the files a specialist made are the hirer's too.
 * Content the job already has is not added twice. Returns what was added.
 */
export function adoptOutputs(taskId: string, fromTaskId: string, o: { wallet?: string | null; now?: number } = {}): FileRow[] {
  const now = o.now ?? Date.now();
  return getDb().transaction(() => {
    const added: FileRow[] = [];
    for (const r of filesOfTask(fromTaskId, "out")) {
      if (hasOutput(taskId, r.sha256)) continue;
      added.push(copyRow(r, { taskId, direction: "out", wallet: o.wallet ?? null }, now + added.length));
    }
    return added;
  })();
}

/** Which agent made a file that was handed on, and in which job. Null for a file made by the job itself. */
export function madeBy(row: { source_task_id?: string | null; task_id?: string | null }): { agentId: string; name: string; taskId: string } | null {
  if (!row.source_task_id || row.source_task_id === row.task_id) return null;
  const r = getDb().prepare("SELECT t.to_agent agentId, a.name name FROM tasks t LEFT JOIN agents a ON a.agent_id = t.to_agent WHERE t.task_id = ?").get(row.source_task_id) as { agentId: string; name: string | null } | undefined;
  return r ? { agentId: r.agentId, name: r.name ?? r.agentId, taskId: row.source_task_id } : null;
}

// ── What an agent hands back ─────────────────────────────────────────────────────────────────────────────────────────
// A file an agent wrote belongs to its job: whoever may read the job's answer may download it, and the job's receipt
// names it by its hash, so the file somebody holds can be checked against what the job committed to.

/** A file as a receipt lists it. `stored` is false once its bytes have been cleared; the hash stays. */
export interface ReceiptFile { id: string; name: string; type: string; size: number; sha256: string; stored: boolean; madeBy?: { agentId: string; name: string; taskId: string }; version?: number; revises?: string; first?: VersionInfo["first"] }

/** The files a job handed back, for its receipt: every one it ever had, in order, cleared or not. */
export function receiptFiles(taskId: string, direction: "in" | "out" = "out"): ReceiptFile[] {
  const rows = getDb().prepare("SELECT * FROM task_files WHERE task_id = ? AND direction = ? ORDER BY created_at ASC, id ASC").all(taskId, direction) as FileRow[];
  return rows.map((r) => { const by = madeBy(r); return { id: r.id, name: r.name, type: r.mime, size: r.size, sha256: r.sha256, stored: !r.deleted_at, ...(by ? { madeBy: by } : {}), ...versionInfo(r) }; });
}

/**
 * One hash for a set of files: SHA-256 over their own hashes, lowercase, sorted, one a line. Sorted, so it does not
 * depend on the order the files were written in. Null for no files.
 */
export function filesHash(shas: string[]): string | null {
  if (!shas.length) return null;
  return createHash("sha256").update(shas.map((s) => s.toLowerCase()).sort().join("\n"), "utf8").digest("hex");
}

/** True when this job already handed back these exact bytes, so a job that runs twice does not list a file twice. */
function hasOutput(taskId: string, sha256: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM task_files WHERE task_id = ? AND direction = 'out' AND sha256 = ? LIMIT 1").get(taskId, sha256));
}

/** Keep a file an agent made with its job. Null when the job already has it. */
export function keepOutput(input: { taskId: string; bytes: Buffer; name: string; wallet: string | null }, o: { now?: number; env?: Record<string, string | undefined> } = {}): StoreResult | null {
  if (hasOutput(input.taskId, sha256Of(input.bytes))) return null;
  return storeFile({ bytes: input.bytes, name: input.name, wallet: input.wallet, direction: "out", taskId: input.taskId }, o);
}

/** A returned file as the job's reader gets it: what it is, its hash, and the token and path that download it. */
export interface OutputFile { id: string; name: string; type: string; kind: FileKind; size: number; sha256: string; token: string; path: string; madeBy?: { agentId: string; name: string; taskId: string }; version?: number; revises?: string; first?: VersionInfo["first"] }
export const outputFileFor = (f: FileRow): OutputFile => {
  const by = madeBy(f);
  return { id: f.id, name: f.name, type: f.mime, kind: f.kind, size: f.size, sha256: f.sha256, token: fileTokenFor(f.id), path: `/api/files/${f.id}/content`, ...(by ? { madeBy: by } : {}), ...versionInfo(f) };
};

/** The key in a hire's context that asks for the answer as a file as well. Set by `reportFile` on a hire, never directly. */
export const REPORT_KEY = "reportFile";
/** What the agent is told when its answer is also going out as a file. */
export const REPORT_NOTE = "\n\nThe person also receives your answer as a Markdown file to keep. It is made for you from what you write, so do not save the answer as a file yourself. Write it as a finished document: a title, then the content. Do not mention the file.";

/** The name of an answer kept as a file: "Deep Dive AI" gives "deep-dive-ai-report.md". */
export function reportName(agentName: string): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || "agent"}-report.md`;
}

/** Keep a job's answer as a Markdown file beside it. Null when there is nothing to keep or it is already there. */
export function storeReport(input: { taskId: string; output: string; agentName: string; wallet: string | null }, o: { now?: number; env?: Record<string, string | undefined> } = {}): StoreResult | null {
  if (!input.output.trim()) return null;
  return keepOutput({ taskId: input.taskId, bytes: Buffer.from(input.output, "utf8"), name: reportName(input.agentName), wallet: input.wallet }, o);
}

/** A file as a model is handed it: itself, not a description of it. */
export interface ModelAttachment { kind: "pdf" | "image"; mime: string; name: string; data: string }

/**
 * What an agent is handed for a hire's files: the text of the text files, ready to follow the task in the message, and
 * the PDFs and pictures as themselves. A picture is brought down to the size a model looks at. A file whose bytes are
 * gone is named as missing rather than silently dropped.
 */
export async function attachmentsForTask(taskId: string): Promise<{ text: string; attachments: ModelAttachment[]; files: FileRow[] }> {
  const files = filesOfTask(taskId);
  if (!files.length) return { text: "", attachments: [], files };
  const parts: string[] = [], attachments: ModelAttachment[] = [];
  let room = INLINE_TEXT_CHARS;
  for (const f of files) {
    const bytes = readBytes(f);
    if (!bytes) { parts.push(`[Attached file ${f.name} could not be read: it is no longer stored.]`); continue; }
    if (f.kind === "text") {
      const all = bytes.toString("utf8");
      const shown = all.slice(0, Math.max(0, room));
      room -= shown.length;
      const cut = shown.length < all.length ? `\n[The file is longer: ${all.length - shown.length} more characters were left out.]` : "";
      parts.push(`Attached file: ${f.name} (${f.mime}, ${f.size} bytes)\n<<<\n${shown}\n>>>${cut}`);
    } else if (f.kind === "office") {
      // every agent reads what a document, a workbook or a deck says; one with a sandbox has the file itself too
      const type = officeTypeOf(f.mime), read = type ? officeText(bytes, type) : null;
      if (!type || read === null) { parts.push(`[Attached file ${f.name} could not be read: it is damaged.]`); continue; }
      const shown = read.slice(0, Math.max(0, room));
      room -= shown.length;
      const cut = shown.length < read.length ? `\n[The file says more: ${read.length - shown.length} more characters were left out.]` : "";
      parts.push(`Attached file: ${f.name} (${OFFICE[type].label}, ${f.size} bytes). What it says:\n<<<\n${shown}\n>>>${cut}`);
    } else if (f.kind === "image") {
      const ready = await forModel(bytes, f.mime);
      if (ready.data.length > IMAGE_MAX_BYTES) { parts.push(`[Attached picture ${f.name} is too large to look at (${mb(ready.data.length)}) and was left out.]`); continue; }
      attachments.push({ kind: "image", mime: ready.mime, name: f.name, data: ready.data.toString("base64") });
      const dims = ready.width && ready.height ? `, ${ready.width} by ${ready.height} pixels${ready.scaled ? " as you see it, scaled down from the original" : ""}` : "";
      parts.push(`Attached picture: ${f.name} (${f.mime}${dims}) is given to you with this message.`);
    } else {
      attachments.push({ kind: "pdf", mime: f.mime, name: f.name, data: bytes.toString("base64") });
      parts.push(`Attached file: ${f.name} (${f.mime}, ${f.size} bytes) is given to you with this message.`);
    }
  }
  return { text: `\n\n${parts.join("\n\n")}`, attachments, files };
}

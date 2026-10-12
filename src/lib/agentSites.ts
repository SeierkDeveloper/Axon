// Agents that build: the store for what an agent built, and its rules.
//
// An agent that can only answer in words and files cannot hand over a working thing: the calculator, the landing
// page, the small tool. With this it builds one out of a few small files and the person opens it. This file is what
// that rests on and nothing else: whether it is on, how much may be built, what a built page may be made of, what it
// may never be, keeping its versions, and taking one down. How a built page is shown is in ./siteSeal.
//
// The rules the whole thing rests on:
//
//   A built page is never a page of Axon's. It is only ever shown sealed (./siteSeal): in a frame with an origin of
//   its own that nothing shares, so it cannot read anybody's sign-in here, and under a policy that lets it reach
//   nothing outside itself. Everything it shows and runs is in its own files.
//
//   It asks nobody for a secret. A page that takes a password, a recovery phrase, a private key or a card, that
//   talks to a wallet, or that dresses up as another company's sign-in is refused when it is built, whoever asked.
//
//   It is small. A site has a handful of files of a few plain kinds, each with a size limit, and what a file IS comes
//   from its bytes and its name together, never from what the agent says it is.
//
//   Every change is a new version and the old ones are kept, so a change can be taken back.
//
//   It can be taken down. Anybody can report a built page; enough reports hide it at once, and a moderator can hide
//   or restore any of them. A hidden page shows nothing.
//
//   It cannot fill the volume: a person has a daily allowance of new sites and the store a ceiling.
//
// AGENT_SITES=on switches it on. Off (the default) no agent can build and nothing here is reachable.
//
// (Not to be confused with Axon Build, the six-agent pipeline that makes a game: ./buildPipeline. That is its own
// product with its own store. This is something any agent can do inside an ordinary job.)

import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { logger } from "./logger";

type Env = Record<string, string | undefined>;

export function sitesEnabled(env: Env = process.env): boolean {
  return (env.AGENT_SITES ?? "off").trim().toLowerCase() === "on";
}

/**
 * Whether this agent is one that can build at all, whatever the job: an agent Axon runs on Claude (the loop that runs
 * tools), not one behind its own server or a crew, and not a hire that came through an outside tool server.
 */
export function agentBuilds(agent: { provider?: string | null; orchestrator?: unknown; endpoint?: string | null }, o: { viaMcp?: boolean; env?: Env } = {}): boolean {
  if (!sitesEnabled(o.env) || o.viaMcp || agent.orchestrator || agent.endpoint) return false;
  return (agent.provider ?? "anthropic") === "anthropic";
}

const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};

export interface SiteLimits {
  /** files one site may have */
  files: number;
  /** bytes one file may be */
  fileBytes: number;
  /** bytes all the files of one version may be together */
  totalBytes: number;
  /** versions kept for one site; the oldest go first, never the one shown */
  versions: number;
  /** new sites one person may have built in a day */
  perOwnerDay: number;
  /** megabytes the whole store may hold */
  storeMegabytes: number;
  /** different people whose reports hide a page at once */
  reportsToHide: number;
}

/** What may be built. Each number can be set for a deployment; a value out of range is ignored. */
export function siteLimits(env: Env = process.env): SiteLimits {
  return {
    files: num(env.AXON_SITE_MAX_FILES, 12, 1, 50),
    fileBytes: num(env.AXON_SITE_FILE_KB, 300, 1, 2000) * 1024,
    totalBytes: num(env.AXON_SITE_TOTAL_KB, 1024, 1, 8000) * 1024,
    versions: num(env.AXON_SITE_VERSIONS, 20, 1, 100),
    perOwnerDay: num(env.AXON_SITE_PER_DAY, 10, 1, 500),
    storeMegabytes: num(env.AXON_SITE_STORE_MB, 300, 1, 20_000),
    reportsToHide: num(env.AXON_SITE_REPORTS_TO_HIDE, 3, 1, 50),
  };
}

export const SITE = { titleChars: 80, noteChars: 160, pathChars: 80, entry: "index.html" } as const;

// ── What a built page is made of ──────────────────────────────────────────────

const TEXT_KINDS: Record<string, string> = {
  html: "text/html", css: "text/css", js: "text/javascript", json: "application/json", svg: "image/svg+xml",
  txt: "text/plain", md: "text/markdown", csv: "text/csv",
};
const PICTURES: [string, string, (b: Buffer) => boolean][] = [
  ["png", "image/png", (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ["jpg", "image/jpeg", (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["jpeg", "image/jpeg", (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["gif", "image/gif", (b) => b.length > 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")],
  ["webp", "image/webp", (b) => b.length > 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP"],
];

/** A file's place in its site, as it is kept: lowercase, at most two folders deep, nothing hidden, nothing that climbs. */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const p = raw.trim().replace(/^\.?\/+/, "");
  if (!p || p.length > SITE.pathChars) return null;
  return /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*(\/[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*){0,2}$/.test(p) ? p : null;
}

const isText = (b: Buffer): boolean => {
  if (b.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
};

/** What a file is, from its name and its bytes together, or null when it is not a kind a site may hold. */
export function kindOf(path: string, bytes: Buffer): string | null {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "";
  if (TEXT_KINDS[ext]) return isText(bytes) ? TEXT_KINDS[ext] : null;
  const picture = PICTURES.find(([e]) => e === ext);
  return picture && picture[2](bytes) ? picture[1] : null;
}

export interface SiteFileIn { path: string; content: string | Buffer }
export interface SiteFile { path: string; mime: string; bytes: number; sha256: string; content: Buffer }

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const kb = (n: number): string => `${Math.ceil(n / 1024)} KB`;

// ── What a built page may never be ────────────────────────────────────────────

const WHERE = /\.(html|js|svg)$/;
// a place somebody types into
const TYPES_IN = /<\s*(input|textarea|select)\b|contenteditable/i;
const NEVER: [RegExp, string, { onlyWithInput?: boolean }?][] = [
  [/type\s*=\s*["']?\s*password|autocomplete\s*=\s*["']?\s*(current-password|new-password|cc-number|cc-csc)/i, "it asks for a password or a card. A built page never takes either."],
  // (a field of type password is refused above; the bare word is not, so a page may make or rate passwords)
  [/(seed|recovery|secret|mnemonic|backup)\s*(phrase|words)|private\s*key|\b(12|24)[- ]word|card\s*number|\bcvv\b|\bcvc\b|social\s*security/i, "it has a place to type in beside words like recovery phrase, private key or card number. A built page never asks for a secret: take that out.", { onlyWithInput: true }],
  [/window\s*\.\s*ethereum|\bethereum\s*\.\s*request|eth_(requestAccounts|sendTransaction|sign\w*)|personal_sign|wallet_(switch|add)EthereumChain|walletconnect|web3modal|\bnew\s+Web3\b|\bethers\s*\.\s*(BrowserProvider|providers)|window\s*\.\s*(solana|phantom)/i, "it talks to a wallet. A built page never connects to one."],
  [/\b(metamask|phantom|trust\s*wallet|ledger|trezor|coinbase|binance|robinhood|paypal|apple\s*id|google\s*account|microsoft\s*account)\b[\s\S]{0,400}\b(log\s*in|sign\s*in|unlock|restore|verify\s+your|connect\s+(your\s+)?wallet)\b/i, "it looks like another company's sign-in. A built page never stands in for one.", { onlyWithInput: true }],
  [/<\s*(iframe|frame|object|embed|base)\b|<\s*meta[^>]+http-equiv/i, "it has a frame, an embedded object, a <base> or an http-equiv tag. A built page is one document of its own: take that out."],
  [/\b(top|parent)\s*\.\s*location|window\s*\.\s*(top|opener)\b|navigator\s*\.\s*serviceWorker|document\s*\.\s*domain/i, "it reaches for the page around it. A built page stays inside its own frame."],
  [/<\s*script[^>]+\bsrc\s*=\s*["']?\s*(https?:)?\/\/|<\s*link[^>]+\bhref\s*=\s*["']?\s*(https?:)?\/\/|@import\s+(url\()?\s*["']?\s*(https?:)?\/\//i, "it loads a script or a style sheet from another site. Everything a built page runs is in its own files: put the code in the page."],
  [/\bfetch\s*\(|XMLHttpRequest|\bWebSocket\s*\(|\bEventSource\s*\(|sendBeacon|importScripts\s*\(/i, "it calls out over the network. A built page cannot reach anything outside itself: work with what is in its files."],
  [/\beval\s*\(|\bnew\s+Function\s*\(|document\s*\.\s*write(ln)?\s*\(/i, "it builds code from text as it runs (eval, new Function, document.write). Write the code out plainly."],
];

/** Everything about these files that a built page may never be, in words the agent can act on. Empty when clean. */
export function neverIn(files: readonly { path: string; content: Buffer }[]): string[] {
  const out: string[] = [];
  const texts = files.filter((f) => WHERE.test(f.path)).map((f) => ({ path: f.path, text: f.content.toString("utf8") }));
  const typed = texts.some((t) => TYPES_IN.test(t.text));
  for (const { path, text } of texts) {
    for (const [re, why, o] of NEVER) {
      if (o?.onlyWithInput && !typed) continue;
      if (re.test(text)) out.push(`${path}: ${why}`);
    }
  }
  return [...new Set(out)];
}

/** The files as they will be kept, or everything that is wrong with them. Nothing is trimmed to fit. */
export function checkFiles(input: readonly SiteFileIn[], limits: SiteLimits = siteLimits()): { ok: true; files: SiteFile[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(input) || input.length === 0) return { ok: false, problems: [`a site needs at least ${SITE.entry}`] };
  if (input.length > limits.files) problems.push(`a site has at most ${limits.files} files: this one has ${input.length}`);
  const files: SiteFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const f of input.slice(0, limits.files + 1)) {
    const path = cleanPath(f?.path);
    if (!path) { problems.push(`"${String(f?.path).slice(0, 60)}" is not a file name a site may use: lowercase letters, digits, - and _, at most two folders deep`); continue; }
    if (seen.has(path)) { problems.push(`${path} is there twice`); continue; }
    seen.add(path);
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content ?? ""), "utf8");
    if (content.length === 0) { problems.push(`${path} is empty`); continue; }
    if (content.length > limits.fileBytes) { problems.push(`${path} is ${kb(content.length)}: one file is at most ${kb(limits.fileBytes)}`); continue; }
    const mime = kindOf(path, content);
    if (!mime) { problems.push(`${path} is not a kind of file a site may hold (html, css, js, json, svg, txt, md, csv, png, jpg, gif, webp), or its contents are not what its name says`); continue; }
    total += content.length;
    files.push({ path, mime, bytes: content.length, sha256: sha(content), content });
  }
  if (total > limits.totalBytes) problems.push(`the files are ${kb(total)} together: a site is at most ${kb(limits.totalBytes)}`);
  if (!seen.has(SITE.entry)) problems.push(`a site needs a file called ${SITE.entry}: it is the page that opens`);
  problems.push(...neverIn(files));
  return problems.length ? { ok: false, problems } : { ok: true, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)) };
}

/** The fingerprint of a whole version: every path with its file's hash, in order. It is what a receipt can commit to. */
export function fingerprint(files: readonly { path: string; sha256: string }[]): string {
  return sha([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\n${f.sha256}\n`).join(""));
}

// ── The store ─────────────────────────────────────────────────────────────────

export interface Site {
  siteId: string; taskId: string; agentId: string; ownerMark: string | null; title: string;
  status: "live" | "hidden"; hiddenReason: string | null; version: number; createdAt: string; updatedAt: string;
}
export interface SiteVersion { version: number; taskId: string; note: string | null; files: number; bytes: number; sha256: string; createdAt: string }

type Row = Record<string, unknown>;
const toSite = (r: Row): Site => ({
  siteId: String(r.site_id), taskId: String(r.task_id), agentId: String(r.agent_id), ownerMark: (r.owner_mark as string | null) ?? null, title: String(r.title),
  status: r.status === "hidden" ? "hidden" : "live", hiddenReason: (r.hidden_reason as string | null) ?? null, version: Number(r.version), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});
const clip = (s: unknown, most: number): string => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, most);
const now = (): string => new Date().toISOString();

export function getSite(siteId: string): Site | null {
  const r = getDb().prepare("SELECT * FROM built_sites WHERE site_id = ?").get(siteId) as Row | undefined;
  return r ? toSite(r) : null;
}
/** The site a job built or changed (the newest, if it touched several). */
export function siteOfTask(taskId: string): Site | null {
  const r = getDb().prepare(
    "SELECT * FROM built_sites WHERE task_id = ? OR site_id IN (SELECT site_id FROM built_site_versions WHERE task_id = ?) ORDER BY updated_at DESC, rowid DESC LIMIT 1",
  ).get(taskId, taskId) as Row | undefined;
  return r ? toSite(r) : null;
}

/** What a job's reader is told about the site it built: enough to open it. Null when it built nothing that is shown. */
export function siteViewOf(taskId: string, origin = ""): { siteId: string; title: string; version: number; url: string } | null {
  const site = siteOfTask(taskId);
  if (!site || site.version === 0 || site.status !== "live") return null;
  // the version this job made, when it made one; the one shown otherwise
  const mine = (getDb().prepare("SELECT MAX(version) v FROM built_site_versions WHERE site_id = ? AND task_id = ?").get(site.siteId, taskId) as { v: number | null }).v;
  return { siteId: site.siteId, title: site.title, version: mine ?? site.version, url: `${origin.replace(/\/+$/, "")}/s/${site.siteId}` };
}
export function sitesOf(ownerMark: string, limit = 50): Site[] {
  return (getDb().prepare("SELECT * FROM built_sites WHERE owner_mark = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?").all(ownerMark, limit) as Row[]).map(toSite);
}

/** Bytes the whole store holds. */
export function storeBytes(): number {
  return (getDb().prepare("SELECT COALESCE(SUM(bytes), 0) n FROM built_site_files").get() as { n: number }).n;
}

export type Made = { ok: true; site: Site } | { ok: false; why: string };

/**
 * A new, empty site for a job. It shows nothing until its first version is kept. Refused when the person has used
 * their day's allowance or the store is full.
 */
export function createSite(a: { taskId: string; agentId: string; ownerMark?: string | null; title: string }, limits: SiteLimits = siteLimits()): Made {
  const db = getDb();
  const mark = a.ownerMark?.trim() || null;
  // a job with no mark counts against itself, so a stream of anonymous jobs is still bounded per job
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const made = mark
    ? (db.prepare("SELECT COUNT(*) n FROM built_sites WHERE owner_mark = ? AND created_at > ?").get(mark, since) as { n: number }).n
    : (db.prepare("SELECT COUNT(*) n FROM built_sites WHERE owner_mark IS NULL AND task_id = ? AND created_at > ?").get(a.taskId, since) as { n: number }).n;
  if (made >= limits.perOwnerDay) return { ok: false, why: `this person has had ${made} sites built in the last day, which is the most a day allows. An existing one can still be changed.` };
  if (storeBytes() >= limits.storeMegabytes * 1024 * 1024) {
    logger.warn("sites.store_full", "The store for built pages is full", { megabytes: limits.storeMegabytes });
    return { ok: false, why: "no more sites can be kept right now. Nothing was built." };
  }
  const at = now(), siteId = randomBytes(12).toString("base64url");
  db.prepare("INSERT INTO built_sites (site_id, task_id, agent_id, owner_mark, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(siteId, a.taskId, a.agentId, mark, clip(a.title, SITE.titleChars) || "Untitled", at, at);
  return { ok: true, site: getSite(siteId)! };
}

export type Kept = { ok: true; version: number; sha256: string; files: number; bytes: number } | { ok: false; problems: string[] };

/**
 * Keep these files as the site's next version and show it. All or nothing: files that break a rule keep nothing, and
 * the version shown stays the one it was. Old versions beyond the limit are cleared, oldest first.
 */
export function addVersion(siteId: string, input: readonly SiteFileIn[], o: { taskId: string; note?: string; title?: string }, limits: SiteLimits = siteLimits()): Kept {
  const db = getDb();
  const site = getSite(siteId);
  if (!site) return { ok: false, problems: ["there is no such site"] };
  if (site.status === "hidden") return { ok: false, problems: ["this site was taken down and cannot be changed"] };
  const checked = checkFiles(input, limits);
  if (!checked.ok) return checked;
  const bytes = checked.files.reduce((n, f) => n + f.bytes, 0);
  if (storeBytes() + bytes > limits.storeMegabytes * 1024 * 1024) return { ok: false, problems: ["no more can be kept right now. Nothing was changed."] };
  const print = fingerprint(checked.files);
  return db.transaction((): Kept => {
    const version = ((db.prepare("SELECT MAX(version) v FROM built_site_versions WHERE site_id = ?").get(siteId) as { v: number | null }).v ?? 0) + 1;
    const at = now();
    db.prepare("INSERT INTO built_site_versions (site_id, version, task_id, note, files, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(siteId, version, o.taskId, o.note ? clip(o.note, SITE.noteChars) : null, checked.files.length, bytes, print, at);
    const put = db.prepare("INSERT INTO built_site_files (site_id, version, path, mime, bytes, sha256, content) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const f of checked.files) put.run(siteId, version, f.path, f.mime, f.bytes, f.sha256, f.content);
    db.prepare("UPDATE built_sites SET version = ?, updated_at = ?, title = COALESCE(?, title) WHERE site_id = ?").run(version, at, o.title ? clip(o.title, SITE.titleChars) || null : null, siteId);
    // the oldest versions beyond the limit go; the one just kept is the newest, so it never does
    const old = (db.prepare("SELECT version FROM built_site_versions WHERE site_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?").all(siteId, limits.versions) as { version: number }[]).map((r) => r.version);
    for (const v of old) {
      db.prepare("DELETE FROM built_site_files WHERE site_id = ? AND version = ?").run(siteId, v);
      db.prepare("DELETE FROM built_site_versions WHERE site_id = ? AND version = ?").run(siteId, v);
    }
    return { ok: true, version, sha256: print, files: checked.files.length, bytes };
  })();
}

export function versionsOf(siteId: string): SiteVersion[] {
  return (getDb().prepare("SELECT version, task_id, note, files, bytes, sha256, created_at FROM built_site_versions WHERE site_id = ? ORDER BY version DESC").all(siteId) as Row[])
    .map((r) => ({ version: Number(r.version), taskId: String(r.task_id), note: (r.note as string | null) ?? null, files: Number(r.files), bytes: Number(r.bytes), sha256: String(r.sha256), createdAt: String(r.created_at) }));
}

/** The files of a version (the one shown, when none is named). A hidden site has none to give. */
export function filesOf(siteId: string, version?: number): SiteFile[] {
  const site = getSite(siteId);
  if (!site || site.status === "hidden") return [];
  const v = version ?? site.version;
  return (getDb().prepare("SELECT path, mime, bytes, sha256, content FROM built_site_files WHERE site_id = ? AND version = ? ORDER BY path").all(siteId, v) as Row[])
    .map((r) => ({ path: String(r.path), mime: String(r.mime), bytes: Number(r.bytes), sha256: String(r.sha256), content: r.content as Buffer }));
}

/** Show an earlier version again. The versions after it are kept. */
export function showVersion(siteId: string, version: number): boolean {
  const db = getDb();
  if (!db.prepare("SELECT 1 FROM built_site_versions WHERE site_id = ? AND version = ?").get(siteId, version)) return false;
  return db.prepare("UPDATE built_sites SET version = ?, updated_at = ? WHERE site_id = ? AND status = 'live'").run(version, now(), siteId).changes === 1;
}

// ── Taking one down ───────────────────────────────────────────────────────────

export const REPORT_REASONS = ["scam", "impersonation", "harmful", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Take a site down. It shows nothing from here on, to anybody, until a moderator restores it. */
export function hideSite(siteId: string, reason: string): boolean {
  const done = getDb().prepare("UPDATE built_sites SET status = 'hidden', hidden_reason = ?, hidden_at = ?, updated_at = ? WHERE site_id = ? AND status = 'live'").run(clip(reason, 200) || "taken down", now(), now(), siteId).changes === 1;
  if (done) logger.warn("sites.hidden", "A built page was taken down", { siteId, reason: clip(reason, 200) });
  return done;
}

/** A moderator puts a site back. The reports that hid it are cleared, so it does not go down again on the same ones. */
export function restoreSite(siteId: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const done = db.prepare("UPDATE built_sites SET status = 'live', hidden_reason = NULL, hidden_at = NULL, updated_at = ? WHERE site_id = ? AND status = 'hidden'").run(now(), siteId).changes === 1;
    if (done) db.prepare("DELETE FROM built_site_reports WHERE site_id = ?").run(siteId);
    return done;
  })();
}

/**
 * Somebody says a built page should not be up. One person counts once, however often they say it; when enough
 * different people have, the page is hidden at once and a moderator looks afterwards.
 */
export function reportSite(siteId: string, r: { reason: string; details?: string; reporter: string }, limits: SiteLimits = siteLimits()): { ok: boolean; reports: number; hidden: boolean } {
  const db = getDb();
  const site = getSite(siteId);
  if (!site) return { ok: false, reports: 0, hidden: false };
  const reason = (REPORT_REASONS as readonly string[]).includes(r.reason) ? r.reason : "other";
  db.prepare("INSERT OR IGNORE INTO built_site_reports (site_id, reason, details, reporter_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(siteId, reason, r.details ? clip(r.details, 500) : null, sha(`site-report:${r.reporter}`), now());
  const reports = (db.prepare("SELECT COUNT(*) n FROM built_site_reports WHERE site_id = ?").get(siteId) as { n: number }).n;
  const hidden = site.status === "hidden" || (reports >= limits.reportsToHide && hideSite(siteId, `reported by ${reports} people`));
  return { ok: true, reports, hidden };
}

/** For a moderator: the sites people have reported, most reported first, and the ones that are down. */
export function reportedSites(limit = 100): { site: Site; reports: number; reasons: string[] }[] {
  const rows = getDb().prepare(
    `SELECT s.*, COUNT(r.id) n, GROUP_CONCAT(DISTINCT r.reason) reasons FROM built_sites s LEFT JOIN built_site_reports r ON r.site_id = s.site_id
     GROUP BY s.site_id HAVING n > 0 OR s.status = 'hidden' ORDER BY n DESC, s.updated_at DESC LIMIT ?`,
  ).all(limit) as (Row & { n: number; reasons: string | null })[];
  return rows.map((r) => ({ site: toSite(r), reports: r.n, reasons: r.reasons ? r.reasons.split(",") : [] }));
}

/** The newest sites, whoever they belong to: for a moderator's eyes only. */
export function newestSites(limit = 20): (Site & { files: number; bytes: number })[] {
  const rows = getDb().prepare(
    `SELECT s.*, COALESCE(v.files, 0) files, COALESCE(v.bytes, 0) bytes FROM built_sites s LEFT JOIN built_site_versions v ON v.site_id = s.site_id AND v.version = s.version
     ORDER BY s.updated_at DESC, s.rowid DESC LIMIT ?`,
  ).all(limit) as (Row & { files: number; bytes: number })[];
  return rows.map((r) => ({ ...toSite(r), files: r.files, bytes: r.bytes }));
}

/** What the store holds, for the owner's eyes. */
export function siteStats(): { sites: number; live: number; hidden: number; versions: number; megabytes: number; reported: number } {
  const db = getDb();
  const s = db.prepare("SELECT COUNT(*) sites, COALESCE(SUM(status = 'live'), 0) live, COALESCE(SUM(status = 'hidden'), 0) hidden FROM built_sites").get() as { sites: number; live: number; hidden: number };
  const versions = (db.prepare("SELECT COUNT(*) n FROM built_site_versions").get() as { n: number }).n;
  const reported = (db.prepare("SELECT COUNT(DISTINCT site_id) n FROM built_site_reports").get() as { n: number }).n;
  return { ...s, versions, megabytes: Math.round((storeBytes() / (1024 * 1024)) * 100) / 100, reported };
}

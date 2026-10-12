// Agents that build: forms that collect answers.
//
// A built page is sealed (./siteSeal): it can send nothing anywhere. So a form on it does not send itself. The seal's
// own small script takes the form when the visitor sends it and hands its fields to the page that holds the frame
// (./siteViewer); that page shows the visitor what is about to go and to whom, and only when they say yes does it
// post the fields here. They are kept for whoever had the page built, who reads them with the job (and nobody else
// can): a list, a file to download, and a way to remove any one of them.
//
// What is never taken, whatever the page asks for: a password, a card, a recovery phrase or a private key. The store
// already refuses a page that asks for one (./agentSites); a field named like one is refused here too.
//
// AGENT_SITES_FORMS=off switches forms off on their own (built pages still open; their forms say they cannot send).

import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { filesOf, getSite, sitesEnabled } from "./agentSites";

type Env = Record<string, string | undefined>;

export function formsEnabled(env: Env = process.env): boolean {
  return sitesEnabled(env) && (env.AGENT_SITES_FORMS ?? "on").trim().toLowerCase() !== "off";
}

/** How much one answer may hold, and how many a page keeps. */
export const ANSWER = { fields: 40, nameChars: 60, valueChars: 4000, bytes: 16_000, formChars: 60, perSite: 1000 } as const;

// a field named like a secret: never taken, whatever was typed into it
const SECRET = /pass(word|phrase|code)?\b|\bpwd\b|seed|mnemonic|recovery|private[\s_-]?key|secret|card[\s_-]?(number|no|num)\b|\bcvv\b|\bcvc\b|\bssn\b|social[\s_-]?security/i;

export interface Answer { id: string; form: string; at: string; version: number; fields: [string, string][] }
export type Checked = { ok: true; form: string; fields: [string, string][]; bytes: number } | { ok: false; why: string };

const oneLine = (s: string, max: number): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
// what somebody typed: its line breaks stay, anything else unprintable goes
const typed = (s: string, max: number): string => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/[ \t]+$/gm, "").trim().slice(0, max);

/** What was sent, as it will be kept, or why it is not taken. Nothing is guessed: a shape that is not a form is refused. */
export function checkAnswer(raw: unknown): Checked {
  const body = (raw && typeof raw === "object" ? raw : {}) as { form?: unknown; fields?: unknown };
  if (!Array.isArray(body.fields) || body.fields.length === 0) return { ok: false, why: "There is nothing to send." };
  if (body.fields.length > ANSWER.fields) return { ok: false, why: `A form sends at most ${ANSWER.fields} fields.` };
  const fields: [string, string][] = [];
  for (const pair of body.fields) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") return { ok: false, why: "That is not a form's answer." };
    const name = oneLine(pair[0], ANSWER.nameChars), value = typed(pair[1], ANSWER.valueChars);
    if (!name) continue;
    if (value && SECRET.test(name)) return { ok: false, why: "This form asks for a password, a card or a recovery phrase. A built page never takes those, so nothing was sent." };
    fields.push([name, value]);
  }
  if (!fields.some(([, v]) => v !== "")) return { ok: false, why: "Fill in the form first." };
  const bytes = Buffer.byteLength(JSON.stringify(fields));
  if (bytes > ANSWER.bytes) return { ok: false, why: "That is too much for one answer. Shorten it and send again." };
  return { ok: true, form: oneLine(typeof body.form === "string" ? body.form : "", ANSWER.formChars) || "form", fields, bytes };
}

const hash = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 32);

export type KeptAnswer = { ok: true; id: string } | { ok: false; why: string; status: 404 | 409 | 410 };

/**
 * Keep one answer for a page. `sender` says who sent it (an address); only its hash is kept. The same answer sent
 * twice within a minute by the same sender is one answer (a double press).
 */
export function keepAnswer(siteId: string, a: { form: string; fields: [string, string][]; bytes: number }, o: { sender: string; version?: number; now?: number } = { sender: "" }): KeptAnswer {
  const site = getSite(siteId);
  if (!site || site.version === 0) return { ok: false, why: "There is no such page.", status: 404 };
  if (site.status !== "live") return { ok: false, why: "This page was taken down.", status: 410 };
  const db = getDb(), now = o.now ?? Date.now();
  const had = (db.prepare("SELECT COUNT(*) n FROM built_site_answers WHERE site_id = ?").get(siteId) as { n: number }).n;
  if (had >= ANSWER.perSite) return { ok: false, why: "This form has all the answers it can hold.", status: 409 };
  const fields = JSON.stringify(a.fields), sender = hash(`${siteId}:${o.sender}`);
  const twin = db.prepare("SELECT id FROM built_site_answers WHERE site_id = ? AND sender_hash = ? AND fields = ? AND created_at > ?").get(siteId, sender, fields, new Date(now - 60_000).toISOString()) as { id: string } | undefined;
  if (twin) return { ok: true, id: twin.id };
  const id = randomBytes(9).toString("base64url");
  const version = Number.isInteger(o.version) && o.version! >= 1 && o.version! <= site.version ? o.version! : site.version;
  db.prepare("INSERT INTO built_site_answers (id, site_id, version, form, fields, bytes, sender_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, siteId, version, a.form, fields, a.bytes, sender, new Date(now).toISOString());
  return { ok: true, id };
}

interface Row { id: string; form: string; created_at: string; version: number; fields: string }
const toAnswer = (r: Row): Answer => {
  let fields: [string, string][] = [];
  try { fields = JSON.parse(r.fields) as [string, string][]; } catch { /* kept as nothing rather than failing the list */ }
  return { id: r.id, form: r.form, at: r.created_at, version: r.version, fields };
};

/** A page's answers, newest first. */
export function answersOf(siteId: string, limit = 200): Answer[] {
  const rows = getDb().prepare("SELECT id, form, created_at, version, fields FROM built_site_answers WHERE site_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(siteId, Math.max(1, Math.min(ANSWER.perSite, Math.floor(limit)))) as Row[];
  return rows.map(toAnswer);
}

export function answerCount(siteId: string): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM built_site_answers WHERE site_id = ?").get(siteId) as { n: number }).n;
}

/** Take one answer away for good. */
export function removeAnswer(siteId: string, id: string): boolean {
  return getDb().prepare("DELETE FROM built_site_answers WHERE site_id = ? AND id = ?").run(siteId, id).changes > 0;
}

/** A form that collects answers says so with this mark (see SEAL_FORMS in ./siteSeal). */
export const COLLECTS = /<\s*form\b[^>]*\bdata-collect\b/i;

/** Whether the page a site shows has a form on it that collects answers. */
export function hasForm(siteId: string): boolean {
  return filesOf(siteId).some((f) => f.mime === "text/html" && COLLECTS.test(f.content.toString("utf8")));
}

// a cell a spreadsheet would run as a formula is kept as words
const cell = (v: string): string => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Every answer of a page as a file a spreadsheet opens: one row an answer, one column for each field there ever was. */
export function answersCsv(siteId: string): string {
  const all = answersOf(siteId, ANSWER.perSite).reverse();
  const names: string[] = [];
  for (const a of all) for (const [name] of a.fields) if (!names.includes(name)) names.push(name);
  const rows = [["sent", "form", ...names].map(cell).join(",")];
  for (const a of all) {
    // a field given more than once (ticked boxes of one name) is one cell
    const by = new Map<string, string[]>();
    for (const [name, value] of a.fields) by.set(name, [...(by.get(name) ?? []), value]);
    rows.push([a.at, a.form, ...names.map((n) => (by.get(n) ?? []).filter((v) => v !== "").join("; "))].map(cell).join(","));
  }
  return `${rows.join("\r\n")}\r\n`;
}

/** What the store holds, for the owner's eyes. */
export function answerStats(): { answers: number; pages: number } {
  return getDb().prepare("SELECT COUNT(*) answers, COUNT(DISTINCT site_id) pages FROM built_site_answers").get() as { answers: number; pages: number };
}

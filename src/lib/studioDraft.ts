// Agent Studio, phase 2: one sentence in, a whole draft agent out.
//
// The writer (studioModels().writer) is asked for one thing, a draft as JSON: a name, a handle, a short description,
// what it can do, its instructions, the model and tools it should run with, and a price. Nothing it says is taken as
// it is: every field is cut to its limit, checked the way every registration is checked, kept to the models and tools
// Studio may hand out, and the price is suggested from what similar agents on Axon charge, not from the writer.
//
// A build is a row: who started it, the sentence, the draft, and later its test rounds and score. It is its owner's
// alone until published.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { claudeModel } from "./providers";
import { semanticSearchAgents } from "./embeddings";
import { agentExists, categoryFromCapabilities } from "./agents";
import { canRegister } from "./reservedHandles";
import { validateAgentContent, validateAgentText } from "./agentContent";
import { parsePaymentAmount } from "./money";
import { getTier } from "./holderTier";
import { studioEnabled, buildsAllowed, studioModels, BUILD_BUDGET, LIMITS, AGENT_MODELS, STUDIO_TOOLS, clampPrice, PRICE_ETH, MAX_RUNNING_TOTAL, MAX_RUNNING_PER_WALLET, MAX_TWEAKS_PER_BUILD } from "./studioPolicy";
import { logger } from "./logger";

export interface Draft {
  name: string;
  handle: string;
  description: string;
  capabilities: string[];
  category: string;
  instructions: string;
  model: (typeof AGENT_MODELS)[number];
  tools: (typeof STUDIO_TOOLS)[number][];
  priceEth: number;
}

export type BuildStatus = "drafting" | "drafted" | "testing" | "improving" | "ready" | "published" | "failed" | "stopped";
export interface Build { id: string; wallet: string; sentence: string; status: BuildStatus; draft: Draft | null; score: number | null; agentId: string | null; error: string | null; createdAt: string; updatedAt: string }

// ── The writer ────────────────────────────────────────────────────────────────

export const WRITER_SYSTEM = `You design AI agents for Axon, a marketplace where people hire agents for real work and pay per task.
From one sentence describing an agent, write the complete agent as a single JSON object and nothing else:

{
  "name": "2 to 4 plain words, title case, what it does (not a person's name, never 'Axon' or 'Anthropic')",
  "handle": "the name in lowercase words joined by hyphens",
  "description": "one sentence a buyer reads in a list, at most 170 characters",
  "capabilities": ["2 to 5 short lowercase skills, like 'earnings analysis'"],
  "category": "Finance | Research | Development | Content | General, the one a buyer would look under",
  "instructions": "the agent's full system prompt, written to the agent as 'you'",
  "model": "claude-haiku-4-5 | claude-sonnet-5 | claude-opus-5-5",
  "tools": ["web_search and/or web_fetch, only if the work needs the live web, else []"]
}

The instructions are the product. Write them like the best specialist in the field briefing a new expert:
- what the agent is for and who hires it
- exactly what to deliver: structure, sections, length, format, with a short example of the output's shape
- how to handle missing or unclear input, and what never to do
- domain judgement: what good looks like in this field, common mistakes to avoid
At most 6000 characters. No placeholders. Nothing about payments, wallets or keys.

Model: claude-haiku-4-5 for short, simple, high-volume work; claude-sonnet-5 for most work; claude-opus-5-5 only for
deep reasoning where quality matters far more than cost.`;

/** The first JSON object in the writer's answer, whatever it put around it. */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/** Axon's listing categories, as the marketplace files agents. */
const CATEGORIES = ["Finance", "Research", "Development", "Content", "General"];

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+$/g, "").trim().slice(0, max) : "");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** A handle nobody holds: the writer's, or its name's, with -2, -3 … until one is free for this wallet. */
export function freeHandle(base: string, wallet: string): string {
  const root = slug(base) || "agent";
  for (let i = 1; i < 100; i++) {
    const h = i === 1 ? root : `${root}-${i}`;
    if (!agentExists(h) && canRegister(h, wallet)) return h;
  }
  return `${root}-${randomUUID().slice(0, 6)}`;
}

/** The writer's answer made into a draft Studio will stand behind, or the reason it cannot be. */
export function toDraft(raw: unknown, wallet: string, priceEth: number): Draft | string {
  if (!raw || typeof raw !== "object") return "Studio could not write an agent from that. Describe what it does, and for whom, another way.";
  const r = raw as Record<string, unknown>;
  const name = str(r.name, LIMITS.nameChars);
  const instructions = str(r.instructions, LIMITS.instructionsChars);
  if (name.length < 3) return "The draft had no name.";
  if (instructions.length < 80) return "The draft's instructions were too thin.";
  const capabilities = (Array.isArray(r.capabilities) ? r.capabilities : [])
    .map((c) => str(c, 40).toLowerCase()).filter((c) => c.length >= 2).slice(0, 5);
  if (!capabilities.length) return "The draft listed nothing it can do.";
  const handle = freeHandle(str(r.handle, 60) || name, wallet);
  const description = str(r.description, LIMITS.descriptionChars);
  const model = (AGENT_MODELS as readonly string[]).includes(String(r.model)) ? (r.model as Draft["model"]) : "claude-sonnet-5";
  const tools = [...new Set((Array.isArray(r.tools) ? r.tools : []).filter((t): t is Draft["tools"][number] => (STUDIO_TOOLS as readonly string[]).includes(String(t))))];
  const bad = validateAgentContent(name, handle, capabilities) ?? validateAgentText(`${description}\n${instructions}`);
  if (bad) return bad;
  // the writer picks from Axon's own categories; its skills decide when it picks none of them
  const category = CATEGORIES.includes(String(r.category)) ? String(r.category) : categoryFromCapabilities(capabilities);
  return { name, handle, description, capabilities, category, instructions, model, tools, priceEth: clampPrice(priceEth) };
}

/** What agents like this one charge on Axon: the middle price of the closest few, kept inside Studio's bounds. */
async function suggestPrice(sentence: string): Promise<number> {
  const similar = await semanticSearchAgents(sentence, { q: sentence, limit: 8 }).catch(() => null);
  const prices = (similar ?? [])
    .map((a) => (a.price ? parsePaymentAmount(a.price) : null))
    .filter((p): p is NonNullable<typeof p> => p !== null && p.currency === "ETH" && p.amount > 0)
    .map((p) => p.amount)
    .sort((a, b) => a - b);
  if (!prices.length) return PRICE_ETH.fallback;
  return clampPrice(prices[Math.floor(prices.length / 2)]);
}

// ── Builds ────────────────────────────────────────────────────────────────────

type Row = { id: string; wallet: string; sentence: string; status: BuildStatus; draft: string | null; score: number | null; agent_id: string | null; error: string | null; created_at: string; updated_at: string };
const toBuild = (r: Row): Build => ({ id: r.id, wallet: r.wallet, sentence: r.sentence, status: r.status, draft: r.draft ? (JSON.parse(r.draft) as Draft) : null, score: r.score, agentId: r.agent_id, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at });

export function getBuild(id: string): Build | null {
  const r = getDb().prepare("SELECT * FROM studio_builds WHERE id = ?").get(id) as Row | undefined;
  return r ? toBuild(r) : null;
}

export function buildsOf(wallet: string, limit = 50): Build[] {
  return (getDb().prepare("SELECT * FROM studio_builds WHERE wallet = ? ORDER BY created_at DESC LIMIT ?").all(wallet.toLowerCase(), limit) as Row[]).map(toBuild);
}

export function updateBuild(id: string, fields: Partial<{ status: BuildStatus; draft: Draft; score: number | null; agentId: string; error: string | null }>): void {
  const sets: string[] = ["updated_at = ?"];
  const vals: (string | number | null)[] = [new Date().toISOString()];
  if (fields.status) { sets.push("status = ?"); vals.push(fields.status); }
  if (fields.draft) { sets.push("draft = ?"); vals.push(JSON.stringify(fields.draft)); }
  if ("score" in fields) { sets.push("score = ?"); vals.push(fields.score ?? null); }
  if (fields.agentId) { sets.push("agent_id = ?"); vals.push(fields.agentId); }
  if ("error" in fields) { sets.push("error = ?"); vals.push(fields.error ?? null); }
  getDb().prepare(`UPDATE studio_builds SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

const RUNNING: BuildStatus[] = ["drafting", "testing", "improving"];

/** May this wallet start a build now: Studio on, under its day's limit, under its running limit, room across Axon.
 *  A remix is a build too, and counts the same. */
export async function mayStart(wallet: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!studioEnabled()) return { ok: false, reason: "Agent Studio is paused just now." };
  const db = getDb();
  const marks = RUNNING.map(() => "?").join(",");
  const total = (db.prepare(`SELECT COUNT(*) n FROM studio_builds WHERE status IN (${marks})`).get(...RUNNING) as { n: number }).n;
  if (total >= MAX_RUNNING_TOTAL) return { ok: false, reason: "Studio is busy building other agents. Try again in a minute." };
  const today = (db.prepare("SELECT COUNT(*) n FROM studio_builds WHERE wallet = ? AND created_at >= ?").get(wallet, new Date(Date.now() - 86_400_000).toISOString()) as { n: number }).n;
  const running = (db.prepare(`SELECT COUNT(*) n FROM studio_builds WHERE wallet = ? AND status IN (${marks})`).get(wallet, ...RUNNING) as { n: number }).n;
  const { tier } = await getTier(wallet);
  return buildsAllowed(tier.name, today, running);
}

/** May this wallet run a test now (a first test, or a retest after a change): Studio on, under its running limit, room
 *  across Axon. The day's limit was counted when the build was started. */
export function mayRun(wallet: string): { ok: true } | { ok: false; reason: string } {
  if (!studioEnabled()) return { ok: false, reason: "Agent Studio is paused just now." };
  const db = getDb();
  const marks = RUNNING.map(() => "?").join(",");
  const total = (db.prepare(`SELECT COUNT(*) n FROM studio_builds WHERE status IN (${marks})`).get(...RUNNING) as { n: number }).n;
  if (total >= MAX_RUNNING_TOTAL) return { ok: false, reason: "Studio is busy building other agents. Try again in a minute." };
  const running = (db.prepare(`SELECT COUNT(*) n FROM studio_builds WHERE wallet = ? AND status IN (${marks})`).get(wallet.toLowerCase(), ...RUNNING) as { n: number }).n;
  if (running >= MAX_RUNNING_PER_WALLET) return { ok: false, reason: `${MAX_RUNNING_PER_WALLET} builds are already running for this wallet. Wait for one to finish.` };
  return { ok: true };
}

/** The writer, swappable in tests. */
export type Writer = (system: string, prompt: string) => Promise<string>;
const realWriter: Writer = (system, prompt) => claudeModel(studioModels().writer).complete(system, prompt, BUILD_BUDGET.writerTokens);

/**
 * Start a build from a sentence and write its first draft. Returns the build (drafted, or failed with the reason), or
 * the reason none was started.
 */
export async function startDraft(wallet: string, sentence: string, writer: Writer = realWriter): Promise<Build | string> {
  const me = wallet.toLowerCase();
  const s = sentence.replace(/\s+/g, " ").trim();
  if (s.length < 12) return "Describe the agent in a sentence: what it does, and for whom.";
  if (s.length > LIMITS.sentenceChars) return `Keep it to one sentence, at most ${LIMITS.sentenceChars} characters.`;
  const bad = validateAgentText(s);
  if (bad) return bad;
  const allowed = await mayStart(me);
  if (!allowed.ok) return allowed.reason;

  const id = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO studio_builds (id, wallet, sentence, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, me, s, "drafting", now, now);
  try {
    const [raw, price] = await Promise.all([writer(WRITER_SYSTEM, `The agent, in one sentence:\n${s}`), suggestPrice(s)]);
    const draft = toDraft(extractJson(raw), me, price);
    if (typeof draft === "string") updateBuild(id, { status: "failed", error: draft });
    else updateBuild(id, { status: "drafted", draft, error: null });
  } catch (err) {
    logger.warn("studio.draft_failed", "The Studio writer failed", { reason: err instanceof Error ? err.message : String(err) });
    updateBuild(id, { status: "failed", error: "The writer did not answer. Try again in a moment." });
  }
  return getBuild(id)!;
}

// ── Tweaks: changes asked for in Studio's chat ────────────────────────────────

export const TWEAK_SYSTEM = `You edit an AI agent that is being built on Axon. You get the agent and one change its owner asked for.
Make that change and only that change, keeping everything else as it is. Answer in exactly two parts and nothing else:
first the agent's other fields as JSON in the same shape you were given, without "instructions"; then its instructions in
full (not a diff), changed or not, between <instructions> and </instructions>.`;

/** The writer for a change: room for the whole agent, instructions included, to come back. */
const tweakWriter: Writer = (system, prompt) => claudeModel(studioModels().writer).complete(system, prompt, BUILD_BUDGET.rewriteTokens);

/** A changed agent from the writer's two parts: the fields as JSON, the instructions between tags. Long instructions
 *  inside JSON were where changes failed (an unescaped line or a cut-off answer), so they travel on their own. */
export function parseTweak(raw: string): unknown {
  const tagged = raw.match(/<instructions>([\s\S]*?)(?:<\/instructions>|$)/i);
  const rest = tagged ? raw.replace(tagged[0], "") : raw;
  const fields = extractJson(rest) as Record<string, unknown> | null;
  if (!fields) return null;
  return tagged ? { ...fields, instructions: tagged[1].trim() } : fields;
}

export interface Tweak { at: string; request: string; ok: boolean; note: string | null }

export function tweaksOf(buildId: string): Tweak[] {
  const r = getDb().prepare("SELECT tweaks FROM studio_builds WHERE id = ?").get(buildId) as { tweaks: string | null } | undefined;
  return r?.tweaks ? (JSON.parse(r.tweaks) as Tweak[]) : [];
}

/**
 * Apply one change asked for in chat to a build's draft. The edited draft is checked like a new one; a build that was
 * tested goes back to drafted, so the change is tested before anything is listed. Returns the build, or why not.
 */
export async function tweakDraft(buildId: string, wallet: string, request: string, writer: Writer = tweakWriter): Promise<Build | string> {
  const b = getBuild(buildId);
  if (!b || b.wallet !== wallet.toLowerCase()) return "No such build.";
  if (!b.draft) return "This build has no draft to change yet.";
  if (b.status === "published") return "This agent is live, so this build cannot change any more. Start a new build to make a different version.";
  if (!["drafted", "ready", "stopped"].includes(b.status)) return `This build is ${b.status}. Wait for it to finish first.`;
  const ask = request.replace(/\s+/g, " ").trim();
  if (ask.length < 3) return "Say what to change.";
  if (ask.length > LIMITS.sentenceChars) return `Keep a change to ${LIMITS.sentenceChars} characters.`;
  const bad = validateAgentText(ask);
  if (bad) return bad;
  const log = tweaksOf(buildId);
  // only changes that were made count: a failed one costs the owner nothing
  if (log.filter((t) => t.ok).length >= MAX_TWEAKS_PER_BUILD) return `This build has had its ${MAX_TWEAKS_PER_BUILD} changes. Start a new build from the sentence that works.`;

  const save = (entry: Tweak) => getDb().prepare("UPDATE studio_builds SET tweaks = ?, updated_at = ? WHERE id = ?").run(JSON.stringify([...log, entry]), new Date().toISOString(), buildId);
  const { priceEth, handle, category, instructions, ...shown } = b.draft;
  let raw: string;
  try {
    raw = await writer(TWEAK_SYSTEM, `THE AGENT:\n${JSON.stringify({ ...shown, category }, null, 2)}\n\n<instructions>\n${instructions}\n</instructions>\n\nTHE CHANGE:\n${ask}`);
  } catch {
    save({ at: new Date().toISOString(), request: ask, ok: false, note: "The writer did not answer." });
    return "The writer did not answer. Try again in a moment.";
  }
  const parsed = parseTweak(raw);
  const next = parsed ? toDraft(parsed, b.wallet, priceEth) : "Try saying the change another way.";
  if (typeof next === "string") {
    logger.warn("studio.tweak_failed", "A Studio change could not be read", { buildId, reason: next, answerChars: raw.length, tagged: /<instructions>/i.test(raw), closed: /<\/instructions>/i.test(raw) });
    save({ at: new Date().toISOString(), request: ask, ok: false, note: next });
    return `That change could not be made: ${next}`;
  }
  // the handle stays the one it was given unless the name itself changed
  const kept: Draft = { ...next, handle: next.name === b.draft.name ? handle : next.handle };
  save({ at: new Date().toISOString(), request: ask, ok: true, note: null });
  // a tested build is tested again before it can be listed: its old rounds measured the old instructions
  updateBuild(buildId, { draft: kept, status: "drafted", score: null, error: null });
  return getBuild(buildId)!;
}

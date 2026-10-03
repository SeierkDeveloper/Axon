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
import { studioEnabled, buildsAllowed, studioModels, BUILD_BUDGET, LIMITS, AGENT_MODELS, STUDIO_TOOLS, clampPrice, PRICE_ETH, MAX_RUNNING_TOTAL } from "./studioPolicy";
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
  if (!raw || typeof raw !== "object") return "The writer did not return a draft.";
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
  return { name, handle, description, capabilities, category: categoryFromCapabilities(capabilities), instructions, model, tools, priceEth: clampPrice(priceEth) };
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

/** May this wallet start a build now: Studio on, under its day's limit, under its running limit, room across Axon. */
async function mayStart(wallet: string): Promise<{ ok: true } | { ok: false; reason: string }> {
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

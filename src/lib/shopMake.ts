// Agents that sell what they make: an agent that makes and lists products by itself.
//
// Its owner switches it on for one agent and says three things: what kind of products, at what price, and how often.
// From then on the agent is hired on that schedule, by its owner's wallet, to build something new of that kind. The
// job is an ordinary one: the same worker, the same build tool, the same rules for what a built page may be, the same
// receipt. When the job has built a page, the page is listed at the owner's price, marked as made by the agent on its
// own. A job that built nothing lists nothing.
//
// What holds it:
//
//   One run per slot. A run is claimed against (agent, slot) before its job is made, so two workers or a restart
//   cannot make two. The next slot is set before the job is made, so a crash moves on rather than repeating.
//
//   It cannot run away. An agent makes at most what its owner set for a day, and never more than AGENT_SHOP_MAKE_PER_DAY.
//   Every agent together makes at most AGENT_SHOP_MAKE_DAILY_MAX a day: each run is a build Axon pays the model for,
//   like a free hire. The network's own cap on builds a day (AGENT_SITES_DAILY_MAX) holds as well.
//
//   Only for its owner. An agent that changes hands stops: the new owner switches it on for themselves.
//
// The worker calls `runDueMakes` and `settleMakeRuns` once a minute while the shop is on.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { getAgentById } from "./agents";
import { getMcpServerByAgentId } from "./mcp";
import { agentBuilds, siteOfTask } from "./agentSites";
import { validateAgentText } from "./agentContent";
import { createTask, getTaskById } from "./tasks";
import { scrubSecrets } from "./scrubSecrets";
import { formatEth } from "./money";
import { SHOP, clip, listProduct, now, ownsAgent, readPrice, shopAgentOf, shopEnabled, shopLimits, type ShopAgent, type ShopLimits } from "./agentShop";

/** How often an agent may make something, in hours: the least, what is set when nothing is said, and the most. */
export const MAKE_EVERY = { min: 4, default: 24, max: 7 * 24 } as const;

export type MakeInput = { on: boolean; kind?: unknown; price?: unknown; everyHours?: unknown; perDay?: unknown };

/** Whether this agent can make products by itself at all: one Axon runs and can build. */
export function canMake(agentId: string): boolean {
  const agent = getAgentById(agentId);
  return Boolean(agent) && agentBuilds(agent!, { viaMcp: Boolean(getMcpServerByAgentId(agentId)) });
}

function ensureRow(agentId: string, wallet: string): void {
  getDb().prepare("INSERT INTO shop_agents (agent_id, owner_wallet, updated_at) VALUES (?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET owner_wallet = excluded.owner_wallet")
    .run(agentId, wallet.toLowerCase(), now());
}

/**
 * The owner switches making on or off for one agent, with what to make, its price, how often, and how many a day.
 * Switched on, the first run comes at the next tick. Off keeps what was set, for switching on again.
 */
export function setMaking(agentId: string, wallet: string, input: MakeInput, limits: ShopLimits = shopLimits()): { ok: true; shop: ShopAgent } | { ok: false; why: string } {
  if (!ownsAgent(agentId, wallet)) return { ok: false, why: "Only the agent's owner can do that." };
  const db = getDb();
  if (!input.on) {
    ensureRow(agentId, wallet);
    db.prepare("UPDATE shop_agents SET make_on = 0, make_next_at = NULL, updated_at = ? WHERE agent_id = ?").run(now(), agentId);
    return { ok: true, shop: shopAgentOf(agentId)! };
  }
  if (!canMake(agentId)) return { ok: false, why: "This agent cannot build pages, so it cannot make products." };
  const kind = clip(input.kind, SHOP.kindChars);
  if (kind.length < 10) return { ok: false, why: "Say in a sentence what kind of products it should make." };
  const bad = validateAgentText(kind);
  if (bad) return { ok: false, why: bad };
  const price = readPrice(input.price, limits);
  if (!price.ok) return price;
  const every = input.everyHours === undefined ? MAKE_EVERY.default : Number(input.everyHours);
  if (!Number.isInteger(every) || every < MAKE_EVERY.min || every > MAKE_EVERY.max) return { ok: false, why: `How often is every ${MAKE_EVERY.min} to ${MAKE_EVERY.max} hours.` };
  const perDay = input.perDay === undefined ? 1 : Number(input.perDay);
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > limits.makePerDayMax) return { ok: false, why: `An agent can make 1 to ${limits.makePerDayMax} products a day.` };
  ensureRow(agentId, wallet);
  db.prepare("UPDATE shop_agents SET make_on = 1, make_kind = ?, make_price_wei = ?, make_every_hours = ?, make_per_day = ?, make_next_at = COALESCE(make_next_at, ?), updated_at = ? WHERE agent_id = ?")
    .run(kind, price.wei.toString(), every, perDay, now(), now(), agentId);
  void syncToTurso();
  return { ok: true, shop: shopAgentOf(agentId)! };
}

/** What the agent is asked to do on a run: build one new thing of the kind its owner set, unlike what it made before. */
export function makeTask(kind: string, before: string[]): string {
  return [
    `Build a new web page or small app to sell in your shop on Axon. What to make: ${kind}`,
    before.length ? `Make something different from what you made before: ${before.map((t) => `"${t}"`).join(", ")}.` : "",
    "Make it finished and useful by itself, with a clear title of a few words. Once it is built, say in one or two plain sentences what it is and who it is for: that is how it is described for sale.",
  ].filter(Boolean).join("\n\n");
}

/** Runs counted against a day: every run that made a job. */
const runsSince = (sinceIso: string, agentId?: string): number =>
  (getDb().prepare(`SELECT COUNT(*) n FROM shop_make_runs WHERE status != 'skipped' AND created_at > ? ${agentId ? "AND agent_id = ?" : ""}`).get(...(agentId ? [sinceIso, agentId] : [sinceIso])) as { n: number }).n;

export interface MakeTick { due: number; started: number; skipped: number }

/** Start a run for every agent whose time has come. Safe to call from any number of workers at once. */
export function runDueMakes(nowMs = Date.now(), limits: ShopLimits = shopLimits()): MakeTick {
  const out: MakeTick = { due: 0, started: 0, skipped: 0 };
  if (!shopEnabled()) return out;
  const db = getDb(), at = new Date(nowMs).toISOString(), dayAgo = new Date(nowMs - 86_400_000).toISOString();
  const due = db.prepare("SELECT agent_id FROM shop_agents WHERE make_on = 1 AND make_next_at <= ? ORDER BY make_next_at LIMIT 20").all(at) as { agent_id: string }[];
  for (const { agent_id: agentId } of due) {
    const s = shopAgentOf(agentId);
    if (!s || !s.make.on || !s.make.nextAt || !s.make.kind || s.make.priceWei === null) continue;
    out.due++;
    // an agent that changed hands, or can no longer build, stops: nobody is billed for it and nothing is listed
    if (!ownsAgent(agentId, s.ownerWallet) || !canMake(agentId)) {
      db.prepare("UPDATE shop_agents SET make_on = 0, make_next_at = NULL, updated_at = ? WHERE agent_id = ?").run(at, agentId);
      logger.info("shop.make_stopped", "An agent stopped making products: it changed hands or cannot build", { agentId });
      out.skipped++;
      continue;
    }
    const next = new Date(nowMs + (s.make.everyHours ?? MAKE_EVERY.default) * 3_600_000).toISOString();
    // the network's day, then the agent's own: either one full waits for the next slot
    if (limits.makeDaily === 0 || runsSince(dayAgo) >= limits.makeDaily || runsSince(dayAgo, agentId) >= Math.min(s.make.perDay ?? 1, limits.makePerDayMax)) {
      db.prepare("UPDATE shop_agents SET make_next_at = ?, updated_at = ? WHERE agent_id = ?").run(next, at, agentId);
      out.skipped++;
      continue;
    }
    // one run per slot, claimed before the job exists; the next slot is set before the job is made
    const runId = `make_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const claimed = db.prepare("INSERT INTO shop_make_runs (run_id, agent_id, slot, status, created_at) VALUES (?, ?, ?, 'running', ?) ON CONFLICT (agent_id, slot) DO NOTHING").run(runId, agentId, s.make.nextAt, at).changes === 1;
    if (!claimed) continue;
    db.prepare("UPDATE shop_agents SET make_next_at = ?, updated_at = ? WHERE agent_id = ?").run(next, at, agentId);
    const before = (db.prepare("SELECT title FROM shop_products WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5").all(agentId) as { title: string }[]).map((r) => r.title);
    const task = createTask({ fromAgent: s.ownerWallet, toAgent: agentId, task: makeTask(s.make.kind, before), queueQueuedWebhook: false });
    db.prepare("UPDATE shop_make_runs SET task_id = ? WHERE run_id = ?").run(task.taskId, runId);
    logger.info("shop.make_started", "An agent set out to make a product on its own", { agentId, runId, taskId: task.taskId });
    out.started++;
  }
  if (out.started) void syncToTurso();
  return out;
}

/** The words a product made by the agent is listed with: what the agent said about it, plainly, or a line of its own. */
export function describeMade(output: string | null | undefined, title: string, agentName: string): string {
  // headings, code, links and marks of emphasis out: what is left is what the agent said, as sentences
  const plain = scrubSecrets(String(output ?? ""))
    .replace(/```[\s\S]*?```/g, " ").replace(/^#{1,6}\s.*$/gm, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [];
  const two = clip(sentences.slice(0, 2).join(" "), SHOP.descriptionChars);
  return two.length >= 10 && !validateAgentText(two) ? two : `${title}, made by ${agentName} on its own.`;
}

/**
 * Close the runs whose jobs have ended: a job that built a page has it listed at the owner's price, marked as made by
 * the agent; anything else is a run that made nothing. Runs whose jobs are still going are left for the next tick.
 */
export function settleMakeRuns(): { listed: number; failed: number } {
  const out = { listed: 0, failed: 0 };
  if (!shopEnabled()) return out;
  const db = getDb();
  const open = db.prepare("SELECT run_id, agent_id, task_id FROM shop_make_runs WHERE status = 'running' AND task_id IS NOT NULL ORDER BY created_at LIMIT 50").all() as { run_id: string; agent_id: string; task_id: string }[];
  const finish = (runId: string, status: "listed" | "failed", fields: { productId?: string; error?: string }) =>
    db.prepare("UPDATE shop_make_runs SET status = ?, product_id = ?, error = ?, finished_at = ? WHERE run_id = ?").run(status, fields.productId ?? null, fields.error?.slice(0, 300) ?? null, now(), runId);
  for (const run of open) {
    const task = getTaskById(run.task_id);
    if (!task) { finish(run.run_id, "failed", { error: "its job is gone" }); out.failed++; continue; }
    if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") continue;
    const s = shopAgentOf(run.agent_id);
    const site = task.status === "completed" ? siteOfTask(task.taskId) : null;
    if (!s || s.make.priceWei === null || !site || site.status !== "live" || site.version === 0) {
      finish(run.run_id, "failed", { error: task.status === "completed" ? "the job built nothing" : `the job ${task.status}` });
      out.failed++;
      continue;
    }
    const name = getAgentById(run.agent_id)?.name ?? "the agent";
    const listed = listProduct({ agentId: run.agent_id, wallet: s.ownerWallet, siteId: site.siteId, title: site.title, description: describeMade(task.output, site.title, name), price: formatEth(s.make.priceWei), madeBy: "agent" });
    if (listed.ok) {
      finish(run.run_id, "listed", { productId: listed.product.productId });
      logger.info("shop.made", "An agent made and listed a product on its own", { agentId: run.agent_id, productId: listed.product.productId, taskId: task.taskId });
      out.listed++;
    } else {
      finish(run.run_id, "failed", { error: listed.why });
      out.failed++;
    }
  }
  if (out.listed || out.failed) void syncToTurso();
  return out;
}

/** The latest runs of one agent, for its owner: when, what became of it, and the product it made. */
export function makeRunsOf(agentId: string, limit = 10): { runId: string; at: string; status: string; taskId: string | null; productId: string | null; error: string | null }[] {
  return (getDb().prepare("SELECT run_id, created_at, status, task_id, product_id, error FROM shop_make_runs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(agentId, limit) as Record<string, string | null>[])
    .map((r) => ({ runId: String(r.run_id), at: String(r.created_at), status: String(r.status), taskId: r.task_id, productId: r.product_id, error: r.error }));
}

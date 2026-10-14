// Autonomy, phase 3: the first actions. Agents and routing.
//
// What the network pass now does, not just reports:
//   - takes failing and unreachable agents out of routing (auto-routing, the planner, subcontracting, quorums skip
//     them; they stay listed and can be hired by name), within the caps in autonomyPolicy.ROUTING_PAUSE
//   - re-tests a paused agent every few hours, the cheapest real way: its endpoint for an agent that runs its own,
//     one tiny model call for a hosted one; after enough passes in a row it goes back into routing
//   - sends agents much slower than their peers less work, and gives them their full share back once they are not
//
// Every action runs only with `apply` and with actions enabled (AUTONOMY_ACTIONS), and only touches the routing
// columns of the agents table (migration 077). Nothing about an agent's listing, price, owner or money changes.

import { getDb } from "./db";
import { getAgentById } from "./agents";
import { runWithProvider } from "./providers";
import { verifyAgentEndpoint } from "./verification";
import { ROUTING_PAUSE, SLOW, actionsEnabled, pauseBudget, looksLikeOutage } from "./autonomyPolicy";
import type { Finding } from "./networkChecks";

const HOUR = 3_600_000;

/** One real test of an agent: true if it answers. */
export type Retest = (agentId: string) => Promise<boolean>;

/** The default test: the agent's own endpoint if it runs one, else one tiny call to its model. */
export const retestAgent: Retest = async (agentId) => {
  const agent = getAgentById(agentId);
  if (!agent) return false;
  const endpoint = (agent as { endpoint?: string }).endpoint;
  if (endpoint) {
    const r = await verifyAgentEndpoint(agentId, endpoint, {});
    return r.status !== "unreachable";
  }
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 30_000).unref());
    const out = await Promise.race([runWithProvider(agent, "Reply with the single word OK.", 16, "claude-haiku-4-5"), timeout]);
    return typeof out === "string" && out.trim().length > 0;
  } catch {
    return false;
  }
};

/** Agents the routing could pick: not build-time helpers and not gateway providers, which never route anyway. */
function activeAgentCount(db: ReturnType<typeof getDb>): number {
  return (db.prepare("SELECT COUNT(*) n FROM agents WHERE agent_id NOT LIKE 'build-%'").get() as { n: number }).n;
}

/**
 * Take failing and unreachable agents out of routing. Unreachable first (they cannot work at all), then failing;
 * at most the budget autonomyPolicy allows, and nothing at all when so many fail at once that it looks like an
 * outage rather than bad agents.
 */
export function pauseFailing(findings: Finding[], now = Date.now()): Finding[] {
  const db = getDb();
  const paused = new Set(
    (db.prepare("SELECT agent_id FROM agents WHERE routing_paused_at IS NOT NULL").all() as { agent_id: string }[]).map((r) => r.agent_id),
  );
  const candidates = [
    ...findings.filter((f) => f.kind === "agent-unreachable"),
    ...findings.filter((f) => f.kind === "agent-failing"),
  ].filter((f, i, all) => f.subject && !paused.has(f.subject) && all.findIndex((g) => g.subject === f.subject) === i);
  if (candidates.length === 0) return [];

  const active = activeAgentCount(db);
  const budget = pauseBudget(active, paused.size);
  if (budget === 0) return []; // nothing could be paused anyway: a small network, or the ceiling is reached
  if (looksLikeOutage(active, candidates.length + paused.size)) {
    return [{ kind: "outage", what: `${candidates.length + paused.size} of ${active} agents failing at once: treated as an outage, nobody paused` }];
  }
  const out: Finding[] = [];
  const at = new Date(now).toISOString();
  const stmt = db.prepare(
    "UPDATE agents SET routing_paused_at = ?, routing_pause_reason = ?, routing_retested_at = NULL, routing_passes = 0 WHERE agent_id = ? AND routing_paused_at IS NULL",
  );
  for (const f of candidates.slice(0, budget)) {
    if (stmt.run(at, f.what.slice(0, 200), f.subject).changes) {
      out.push({ kind: "agent-paused", subject: f.subject, what: "taken out of routing while it is re-tested" });
    }
  }
  return out;
}

/** Re-test paused agents that are due, and put back the ones that passed enough times in a row. */
export async function retestPaused(retest: Retest = retestAgent, now = Date.now()): Promise<Finding[]> {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT agent_id, routing_passes FROM agents
       WHERE routing_paused_at IS NOT NULL AND (routing_retested_at IS NULL OR routing_retested_at < ?)
         -- an agent paused for falling for an attack is re-tested by that attack (Autonomy 3), not by "does it answer"
         AND COALESCE(routing_pause_reason, '') NOT LIKE 'attack:%'
       ORDER BY routing_retested_at IS NOT NULL, routing_retested_at LIMIT ?`,
    )
    .all(new Date(now - ROUTING_PAUSE.retestEveryHours * HOUR).toISOString(), ROUTING_PAUSE.maxRetestsPerRun) as
    { agent_id: string; routing_passes: number }[];
  const out: Finding[] = [];
  const at = new Date(now).toISOString();
  for (const a of due) {
    const ok = await retest(a.agent_id).catch(() => false);
    const passes = ok ? a.routing_passes + 1 : 0;
    if (passes >= ROUTING_PAUSE.passesToRestore) {
      db.prepare(
        `UPDATE agents SET routing_paused_at = NULL, routing_pause_reason = NULL, routing_retested_at = ?, routing_passes = 0,
           routing_restored_at = ? WHERE agent_id = ?`,
      ).run(at, at, a.agent_id);
      out.push({ kind: "agent-restored", subject: a.agent_id, what: "back in routing after passing its re-tests" });
    } else {
      db.prepare("UPDATE agents SET routing_retested_at = ?, routing_passes = ? WHERE agent_id = ?").run(at, passes, a.agent_id);
      out.push({ kind: "agent-retested", subject: a.agent_id, what: ok ? "passed a re-test" : "failed a re-test" });
    }
  }
  return out;
}

/** Slow agents get a lower routing weight; one no longer slow gets its full weight back. */
export function reweightSlow(findings: Finding[]): Finding[] {
  const db = getDb();
  const slow = new Set(findings.filter((f) => f.kind === "slow-agent" && f.subject).map((f) => f.subject!));
  const out: Finding[] = [];
  const lowered = new Set(
    (db.prepare("SELECT agent_id FROM agents WHERE routing_weight < 1").all() as { agent_id: string }[]).map((r) => r.agent_id),
  );
  for (const id of slow) {
    if (lowered.has(id)) continue;
    if (db.prepare("UPDATE agents SET routing_weight = ? WHERE agent_id = ?").run(SLOW.routingWeight, id).changes) {
      out.push({ kind: "agent-reweighted", subject: id, what: "sent less work while it is much slower than its peers" });
    }
  }
  for (const id of lowered) {
    if (slow.has(id)) continue;
    db.prepare("UPDATE agents SET routing_weight = 1 WHERE agent_id = ?").run(id);
    out.push({ kind: "agent-reweighted", subject: id, what: "full share of work again" });
  }
  return out;
}

/**
 * The routing actions, in order: re-test first (so an agent put back this run is judged afresh), then pause, then
 * weights. Does nothing unless asked to apply and actions are enabled.
 */
export async function routingActions(findings: Finding[], opts: { apply: boolean; retest?: Retest; now?: number }): Promise<Finding[]> {
  if (!opts.apply || !actionsEnabled()) return [];
  const now = opts.now ?? Date.now();
  const retested = await retestPaused(opts.retest ?? retestAgent, now);
  // the failing list was read before the re-tests: an agent put back just now is judged on its next work, not this
  const restored = new Set(retested.filter((f) => f.kind === "agent-restored").map((f) => f.subject));
  const stillFailing = findings.filter((f) => !restored.has(f.subject));
  return [...retested, ...pauseFailing(stillFailing, now), ...reweightSlow(findings)];
}

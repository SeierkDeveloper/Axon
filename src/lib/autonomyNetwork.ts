// Tier 3: the pass over the network itself, rather than the code. It runs every hour.
//
// The codebase pass reads files and writes its log to git. This one reads live state, so its record lives in the
// database. The pass checks the whole network (networkChecks), acts within the caps in autonomyPolicy (routing in
// autonomyActions, upkeep in autonomyUpkeep), and re-prices only agents whose owner turned on auto_price.
//
// Who sees what: the admin page reads every pass in full. The public page and the public API read publicSummary and
// publicDay, which are counts of upkeep and nothing else: no agent, task or webhook named, no amounts, nothing about
// money or volumes.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { computeOptimization, applyOptimization } from "./selfOptimize";
import { runNetworkChecks } from "./networkChecks";
import { routingActions, type Retest } from "./autonomyActions";
import { upkeepActions, type Ping } from "./autonomyUpkeep";
import { isPublic, PRICING, type FindingKind } from "./autonomyPolicy";
import { parsePaymentAmount } from "./money";

export interface NetworkObservation {
  kind: FindingKind;
  /** The agent, task, webhook or retainer it is about, when there is one. */
  subject?: string;
  /** One line, in the terms a reader cares about. */
  what: string;
  /** Why it is worth knowing — a signal is useless without its meaning. */
  why?: string;
}

export interface NetworkChange {
  agentId: string;
  what: string;
}

export interface NetworkRun {
  runId: string;
  startedAt: string;
  finishedAt: string;
  observations: NetworkObservation[];
  changes: NetworkChange[];
  agentsSeen: number;
  /** How many checks the pass ran, and the names of any that could not run. Absent on passes before migration 079. */
  checksRun?: number;
  checksUnavailable?: string[];
}

/** Listed this long without finishing anything counts as dormant. */
const DORMANT_DAYS = 60;
/** At or below this many providers, a capability is thin enough to name. */
const THIN_SUPPLY = 1;
/** What a capability name may look like — matches how agents register them. */
const CAPABILITY_NAME = /^[a-z][a-z0-9]*(?:[ _-][a-z0-9]+)*$/;

/**
 * Capabilities buyers ask for that the marketplace barely serves.
 *
 * Demand comes from open tasks — someone posting a job and naming what it needs
 * is the clearest statement of demand the network has. Supply is the count of
 * agents offering it. The gap between the two is the most useful thing Axon can
 * tell a prospective builder: not "list an agent", but "list this one".
 */
function capabilityGaps(): NetworkObservation[] {
  const db = getDb();
  const supply = new Map<string, number>();
  for (const row of db.prepare("SELECT capability, COUNT(*) n FROM agent_capabilities GROUP BY capability").all() as
    { capability: string; n: number }[]) {
    supply.set(row.capability.toLowerCase(), row.n);
  }

  const demand = new Map<string, number>();
  for (const row of db.prepare("SELECT capabilities FROM open_tasks WHERE capabilities IS NOT NULL").all() as
    { capabilities: string }[]) {
    let caps: unknown;
    try {
      caps = JSON.parse(row.capabilities);
    } catch {
      caps = row.capabilities.split(",");
    }
    const list = Array.isArray(caps) ? caps : [caps];
    for (const c of list) {
      if (typeof c !== "string") continue;
      const key = c.trim().toLowerCase();
      // A capability is a name, and this is the one place unvalidated client
      // input reaches a public page. Malformed JSON falls back to a comma split,
      // so a body of `{{broken` arrived here as a capability and /autonomy
      // reported that nobody offers "{{broken" — a demand signal invented out of
      // a parse failure. Anything that isn't shaped like a name is not one.
      if (!CAPABILITY_NAME.test(key)) continue;
      demand.set(key, (demand.get(key) ?? 0) + 1);
    }
  }

  const out: NetworkObservation[] = [];
  for (const [cap, asks] of [...demand].sort((a, b) => b[1] - a[1])) {
    const have = supply.get(cap) ?? 0;
    if (have > THIN_SUPPLY) continue;
    out.push({
      kind: "capability-gap",
      what:
        have === 0
          ? `"${cap}" was asked for ${asks} time${asks === 1 ? "" : "s"} and no agent offers it`
          : `"${cap}" was asked for ${asks} time${asks === 1 ? "" : "s"} and only ${have} agent offers it`,
      why: "demand with no supply is the clearest thing the network can tell someone deciding what to build",
    });
  }
  return out;
}

/**
 * Listings that have not delivered anything in a long time.
 *
 * Reported, never delisted. An agent that is quiet may be seasonal, private, or
 * simply waiting; removing it on a timer would be the pass making a judgement
 * about someone else's business that a date cannot support.
 */
function dormantListings(): NetworkObservation[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - DORMANT_DAYS * 86400_000).toISOString();
  const rows = db.prepare(`
    SELECT a.agent_id, a.name, MAX(t.completed_at) AS last_done
    FROM agents a
    LEFT JOIN tasks t ON t.to_agent = a.agent_id AND t.status = 'completed'
    GROUP BY a.agent_id
    HAVING last_done IS NULL OR last_done < ?
    ORDER BY last_done IS NOT NULL, last_done ASC
  `).all(cutoff) as { agent_id: string; name: string; last_done: string | null }[];
  if (rows.length === 0) return [];

  const { n: total } = db.prepare("SELECT COUNT(*) n FROM agents").get() as { n: number };
  const neverRan = rows.filter((r) => !r.last_done).length;

  // One line, not one per agent. Measured on the live registry this was 32 rows
  // out of 46 agents, which as a list is noise and as a proportion is the actual
  // finding: most of the marketplace has never delivered anything.
  const sample = rows.slice(0, 3).map((r) => r.agent_id).join(", ");
  return [
    {
      kind: "dormant-listing",
      what: `${rows.length} of ${total} listings have not completed a job in ${DORMANT_DAYS} days (${neverRan} never have), e.g. ${sample}`,
      why: "listings nobody can get work out of make the marketplace look larger than it is",
    },
  ];
}

/**
 * Apply price self-optimization to the agents whose owners opted in.
 *
 * `computeOptimization` is deterministic and already lives in this codebase; the
 * only new thing here is running it without being asked each time — and that
 * only for `auto_price` agents.
 */
function applyAutoPricing(apply: boolean, now = Date.now()): NetworkChange[] {
  const db = getDb();
  // at most once a day per agent (autonomyPolicy.PRICING), however often the pass runs
  let opted: { agent_id: string }[];
  try {
    opted = db
      .prepare("SELECT agent_id FROM agents WHERE auto_price = 1 AND (price_auto_at IS NULL OR price_auto_at < ?)")
      .all(new Date(now - 24 * 3_600_000 / PRICING.perAgentPerDay).toISOString()) as { agent_id: string }[];
  } catch {
    opted = db.prepare("SELECT agent_id FROM agents WHERE auto_price = 1").all() as { agent_id: string }[]; // before 078
  }
  const changes: NetworkChange[] = [];
  for (const { agent_id } of opted) {
    const opt = computeOptimization(agent_id);
    if (!opt || opt.action === "hold" || !opt.suggestedPrice) continue;
    if (opt.suggestedPrice === opt.currentPrice) continue;
    // never a jump: a suggestion further than PRICING.maxStepShare from today's price is not applied
    const cur = opt.currentPrice ? parsePaymentAmount(opt.currentPrice)?.amount ?? 0 : 0;
    const next = parsePaymentAmount(opt.suggestedPrice)?.amount ?? 0;
    if (cur > 0 && Math.abs(next - cur) / cur > PRICING.maxStepShare + 1e-9) continue;
    if (apply) {
      applyOptimization(agent_id, opt.suggestedPrice);
      try { db.prepare("UPDATE agents SET price_auto_at = ? WHERE agent_id = ?").run(new Date(now).toISOString(), agent_id); } catch { /* before 078 */ }
    }
    changes.push({
      agentId: agent_id,
      what: `${opt.action === "raise" ? "raised" : "lowered"} price ${opt.currentPrice ?? "free"} → ${opt.suggestedPrice} (${opt.rationale})`,
    });
  }
  return changes;
}

/**
 * One pass over the network.
 *
 * `apply: false` computes everything and writes nothing, so the pass can be
 * inspected before it is trusted — the same split the codebase pass has between
 * checking and fixing.
 */
export function runNetworkPass(
  opts: { apply?: boolean; extra?: NetworkObservation[]; checks?: { run: number; unavailable: string[] } } = {},
): NetworkRun {
  const apply = opts.apply ?? false;
  const startedAt = new Date().toISOString();
  const db = getDb();

  const observations = [...capabilityGaps(), ...dormantListings(), ...(opts.extra ?? [])];
  const changes = applyAutoPricing(apply);
  const { n: agentsSeen } = db.prepare("SELECT COUNT(*) n FROM agents").get() as { n: number };

  const run: NetworkRun = {
    runId: randomUUID(),
    startedAt,
    finishedAt: new Date().toISOString(),
    observations,
    changes,
    agentsSeen,
    ...(opts.checks ? { checksRun: opts.checks.run, checksUnavailable: opts.checks.unavailable } : {}),
  };

  if (apply) {
    const base = [run.runId, run.startedAt, run.finishedAt, JSON.stringify(run.observations), JSON.stringify(run.changes), run.agentsSeen];
    try {
      db.prepare(`
        INSERT INTO autonomy_network_runs (run_id, started_at, finished_at, observations, changes, agents_seen, checks_run, checks_unavailable)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...base, run.checksRun ?? null, run.checksUnavailable ? JSON.stringify(run.checksUnavailable) : null);
    } catch {
      // before migration 079: the pass is still recorded, without its check counts
      db.prepare(`
        INSERT INTO autonomy_network_runs (run_id, started_at, finished_at, observations, changes, agents_seen)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(...base);
    }
    void syncToTurso();
  }
  return run;
}

/**
 * The most recent recorded network pass, or null before the first one.
 *
 * Returns null rather than throwing when the table is not there. /autonomy is
 * the page this whole thing is judged by, and on a deploy where migration 058
 * has not run yet the query raises `no such table` — which would take the page
 * down at exactly the moment someone came to look at it. The same rule the file
 * log follows: a missing record costs the section, never the page.
 */
type RunRow = {
  run_id: string; started_at: string; finished_at: string; observations: string; changes: string; agents_seen: number;
  checks_run?: number | null; checks_unavailable?: string | null;
};

function parseList<T>(s: string | null | undefined): T[] {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function fromRow(row: RunRow): NetworkRun {
  return {
    runId: row.run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    observations: parseList<NetworkObservation>(row.observations),
    changes: parseList<NetworkChange>(row.changes),
    agentsSeen: row.agents_seen,
    ...(row.checks_run != null ? { checksRun: row.checks_run, checksUnavailable: parseList<string>(row.checks_unavailable) } : {}),
  };
}

export function getLatestNetworkRun(): NetworkRun | null {
  let row: RunRow | undefined;
  try {
    row = getDb().prepare("SELECT * FROM autonomy_network_runs ORDER BY started_at DESC LIMIT 1").get() as RunRow | undefined;
  } catch {
    return null; // table not migrated yet
  }
  return row ? fromRow(row) : null;
}

/** The passes recorded in the last `hours`, newest first. Empty rather than throwing before the table exists. */
export function getNetworkRunsSince(hours: number, now = Date.now()): NetworkRun[] {
  try {
    const rows = getDb()
      .prepare("SELECT * FROM autonomy_network_runs WHERE started_at >= ? ORDER BY started_at DESC")
      .all(new Date(now - hours * 3_600_000).toISOString()) as RunRow[];
    return rows.map(fromRow);
  } catch {
    return [];
  }
}

/**
 * The whole pass: the phase 1 checks (report only), then the long-standing pass that observes and re-prices the
 * opted-in agents. A check that fails to run is named in the record rather than taking the pass down.
 */
export async function runFullNetworkPass(
  opts: { apply?: boolean; retest?: Retest; ping?: Ping; refresh?: (agentId: string) => Promise<boolean> } = {},
): Promise<NetworkRun & { checksUnavailable: string[] }> {
  const { findings, failed, ran } = await runNetworkChecks();
  // act on what the checks found, only when applying and with actions enabled: routing (phase 3), then upkeep (phase 4)
  const apply = opts.apply ?? false;
  const actions = [
    ...(await routingActions(findings, { apply, retest: opts.retest })),
    ...(await upkeepActions(findings, { apply, ping: opts.ping, refresh: opts.refresh })),
  ];
  const run = runNetworkPass({ apply: opts.apply, extra: [...findings, ...actions], checks: { run: ran, unavailable: failed } });
  return { ...run, checksUnavailable: failed };
}

// ── What the public sees: counts, never items ───────────────────────────────

/** The upkeep the public page counts, in the order it shows them. Each is a kind autonomyPolicy marks public. */
export const PUBLIC_UPKEEP = [
  "agent-retested",
  "agent-paused",
  "agent-restored",
  "task-freed",
  "webhook-paused",
  "webhook-restored",
  "description-refreshed",
  "price-adjusted",
] as const satisfies readonly FindingKind[];
export type PublicUpkeep = (typeof PUBLIC_UPKEEP)[number];

export interface PublicSummary {
  finishedAt: string;
  agentsSeen: number;
  checksRun: number | null;
  checksUnavailable: number;
  /** How many of each kind of upkeep the pass did. Nothing about which agent, task or webhook, nor any amount. */
  upkeep: Record<PublicUpkeep, number>;
}

function countUpkeep(runs: NetworkRun[]): Record<PublicUpkeep, number> {
  const counts = Object.fromEntries(PUBLIC_UPKEEP.map((k) => [k, 0])) as Record<PublicUpkeep, number>;
  for (const run of runs) {
    for (const o of run.observations) {
      if (isPublic(o.kind) && o.kind in counts) counts[o.kind as PublicUpkeep]++;
    }
    counts["price-adjusted"] += run.changes.length; // re-pricing is recorded as a change, counted as upkeep
  }
  return counts;
}

/** A pass as the public may see it: when, how much it looked at, and how many of each kind of upkeep. */
export function publicSummary(run: NetworkRun): PublicSummary {
  return {
    finishedAt: run.finishedAt,
    agentsSeen: run.agentsSeen,
    checksRun: run.checksRun ?? null,
    checksUnavailable: run.checksUnavailable?.length ?? 0,
    upkeep: countUpkeep([run]),
  };
}

export interface PublicDay {
  passes: number;
  /** One entry per hour, oldest first: whether a pass ran in it, and whether every check could run. */
  hours: { hour: string; ran: boolean; complete: boolean }[];
  upkeep: Record<PublicUpkeep, number>;
}

/** The last day as the public may see it: one slot per hour, and the upkeep totals. */
export function publicDay(runs: NetworkRun[], now = Date.now()): PublicDay {
  const HOUR = 3_600_000;
  const top = Math.floor(now / HOUR) * HOUR;
  const hours = Array.from({ length: 24 }, (_, i) => {
    const from = top - (23 - i) * HOUR;
    const inHour = runs.filter((r) => {
      const t = Date.parse(r.startedAt);
      return t >= from && t < from + HOUR;
    });
    return {
      hour: new Date(from).toISOString(),
      ran: inHour.length > 0,
      complete: inHour.length > 0 && inHour.every((r) => (r.checksUnavailable?.length ?? 0) === 0),
    };
  });
  return { passes: runs.length, hours, upkeep: countUpkeep(runs) };
}


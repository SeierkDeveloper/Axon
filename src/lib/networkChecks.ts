// Autonomy, phase 1: what the network pass checks, every run. Report only: nothing here changes anything.
//
// Each check reads live state and returns findings in one shape. What may be acted on later, and what each
// finding's audience is, comes from autonomyPolicy, so a check never decides a threshold of its own.

import { getDb } from "./db";
import { MODEL_LOOKS_USABLE } from "./modelHealth";
import { describedFrom } from "./agentDescription";
import { getBurnLive } from "./burnLive";
import { parsePaymentAmount } from "./money";
import {
  FAILING,
  STUCK,
  WEBHOOKS,
  SLOW,
  PRICE_OUTLIER_TIMES,
  DESCRIPTIONS,
  OWNER_WARNINGS,
  FEE_FLOW,
  PAGES,
  isFailing,
  type FindingKind,
} from "./autonomyPolicy";

export interface Finding {
  kind: FindingKind;
  /** The agent, task, webhook or retainer it is about, when there is one. */
  subject?: string;
  what: string;
}

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const capsOf = (raw: string | null): string[] => {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
};

/** Agents whose last day of finished work makes them failing (autonomyPolicy.FAILING). */
export function failingAgents(now = Date.now()): Finding[] {
  const rows = getDb()
    .prepare(
      `SELECT to_agent AS agent, status FROM tasks
       WHERE status IN ('completed', 'failed') AND completed_at >= ?
       ORDER BY to_agent, completed_at DESC`,
    )
    .all(iso(now - FAILING.windowHours * HOUR)) as { agent: string; status: string }[];
  const by = new Map<string, string[]>();
  for (const r of rows) (by.get(r.agent) ?? by.set(r.agent, []).get(r.agent)!).push(r.status);
  const out: Finding[] = [];
  for (const [agent, statuses] of by) {
    const succeeded = statuses.filter((s) => s === "completed").length;
    let failedInARow = 0;
    for (const s of statuses) {
      if (s !== "failed") break;
      failedInARow++;
    }
    if (isFailing({ finished: statuses.length, succeeded, failedInARow })) {
      out.push({ kind: "agent-failing", subject: agent, what: `${succeeded} of ${statuses.length} finished in the last day, ${failedInARow} failed in a row` });
    }
  }
  return out;
}

/** Agents that cannot work at all right now: a model the provider rejected, or an endpoint that stopped answering. */
export function unreachableAgents(): Finding[] {
  const rows = getDb()
    .prepare(
      `SELECT agent_id, model_error, verification_status FROM agents
       WHERE NOT ${MODEL_LOOKS_USABLE} OR verification_status = 'unreachable'`,
    )
    .all() as { agent_id: string; model_error: string | null; verification_status: string | null }[];
  return rows.map((r) => ({
    kind: "agent-unreachable" as const,
    subject: r.agent_id,
    what: r.verification_status === "unreachable" ? "its endpoint stopped answering" : `its model is rejected: ${(r.model_error ?? "").slice(0, 120)}`,
  }));
}

/** Work that stopped moving: running or waiting far longer than any task takes. */
export function stuckTasks(now = Date.now()): Finding[] {
  const rows = getDb()
    .prepare(
      `SELECT task_id, status, to_agent FROM tasks
       WHERE (status = 'running' AND started_at < ?) OR (status = 'queued' AND created_at < ?)
       ORDER BY created_at LIMIT 200`,
    )
    .all(iso(now - STUCK.runningMinutes * 60_000), iso(now - STUCK.queuedMinutes * 60_000)) as
    { task_id: string; status: string; to_agent: string }[];
  return rows.map((r) => ({ kind: "task-stuck" as const, subject: r.task_id, what: `${r.status} too long, for ${r.to_agent}` }));
}

/** Webhooks failing for long enough to switch off (autonomyPolicy.WEBHOOKS). */
export function failingWebhooks(now = Date.now()): Finding[] {
  const rows = getDb()
    .prepare(
      `SELECT webhook_id, agent_id, failure_count FROM webhooks
       WHERE status = 'active' AND failure_count >= ? AND (last_success_at IS NULL OR last_success_at < ?)`,
    )
    .all(WEBHOOKS.failuresToDisable, iso(now - WEBHOOKS.failingForHours * HOUR)) as
    { webhook_id: string; agent_id: string; failure_count: number }[];
  return rows.map((r) => ({ kind: "webhook-failing" as const, subject: r.webhook_id, what: `${r.failure_count} failures in a row, for ${r.agent_id}` }));
}

/** Agents much slower than others offering the same capability, over the last week. */
export function slowAgents(now = Date.now()): Finding[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT to_agent AS agent, (julianday(completed_at) - julianday(started_at)) * 86400000 AS ms FROM tasks
       WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at >= ?`,
    )
    .all(iso(now - 7 * 24 * HOUR)) as { agent: string; ms: number }[];
  const times = new Map<string, number[]>();
  for (const r of rows) if (r.ms > 0) (times.get(r.agent) ?? times.set(r.agent, []).get(r.agent)!).push(r.ms);
  const medians = new Map([...times].filter(([, t]) => t.length >= SLOW.minFinished).map(([a, t]) => [a, median(t)]));
  if (medians.size < 3) return [];
  const caps = new Map(
    (db.prepare("SELECT agent_id, capabilities FROM agents").all() as { agent_id: string; capabilities: string }[]).map((r) => [r.agent_id, capsOf(r.capabilities)]),
  );
  const out: Finding[] = [];
  for (const [agent, m] of medians) {
    const mine = caps.get(agent) ?? [];
    const peers = [...medians].filter(([a]) => a !== agent && (caps.get(a) ?? []).some((c) => mine.includes(c))).map(([, v]) => v);
    if (peers.length < 2) continue;
    const peer = median(peers);
    if (peer > 0 && m > peer * SLOW.times) {
      out.push({ kind: "slow-agent", subject: agent, what: `median ${Math.round(m / 1000)}s against ${Math.round(peer / 1000)}s for agents with the same skills` });
    }
  }
  return out;
}

/** Prices far from what agents with the same capability charge. */
export function priceOutliers(): Finding[] {
  const rows = getDb().prepare("SELECT agent_id, capabilities, price FROM agents WHERE price IS NOT NULL").all() as
    { agent_id: string; capabilities: string; price: string }[];
  const priced = rows
    .map((r) => ({ id: r.agent_id, caps: capsOf(r.capabilities), eth: parsePaymentAmount(r.price)?.amount ?? 0 }))
    .filter((r) => r.eth > 0);
  const out: Finding[] = [];
  for (const a of priced) {
    const peers = priced.filter((p) => p.id !== a.id && p.caps.some((c) => a.caps.includes(c))).map((p) => p.eth);
    if (peers.length < 3) continue;
    const m = median(peers);
    if (a.eth > m * PRICE_OUTLIER_TIMES || a.eth < m / PRICE_OUTLIER_TIMES) {
      out.push({ kind: "price-outlier", subject: a.id, what: `${a.eth} ETH against a median of ${m} ETH for the same skills` });
    }
  }
  return out;
}

/** Listings that are the same agent twice: the same name once spacing, case and numbering are set aside. */
export function duplicateListings(): Finding[] {
  const rows = getDb().prepare("SELECT agent_id, name FROM agents").all() as { agent_id: string; name: string }[];
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const key = r.name.toLowerCase().replace(/[^a-z]+/g, "");
    if (key.length < 4) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r.agent_id);
  }
  return [...groups.values()]
    .filter((ids) => ids.length > 1)
    .map((ids) => ({ kind: "duplicate-listing" as const, subject: ids[0], what: `${ids.length} listings share a name: ${ids.slice(0, 4).join(", ")}` }));
}

/** Descriptions written for an older version of the agent, long enough ago to redo. */
export function staleDescriptions(now = Date.now()): Finding[] {
  const rows = getDb()
    .prepare("SELECT agent_id, name, capabilities, described_from, described_at FROM agents WHERE description IS NOT NULL AND described_at < ?")
    .all(iso(now - DESCRIPTIONS.staleDays * 24 * HOUR)) as
    { agent_id: string; name: string; capabilities: string; described_from: string | null; described_at: string }[];
  return rows
    .filter((r) => r.described_from !== describedFrom({ name: r.name, capabilities: capsOf(r.capabilities) }))
    .map((r) => ({ kind: "stale-description" as const, subject: r.agent_id, what: `written ${r.described_at.slice(0, 10)}, before its skills changed` }));
}

/** Retainers ending soon, and allowance keys expiring soon, so their owners can be told in time. */
export function expiringSoon(now = Date.now()): Finding[] {
  const db = getDb();
  const soon = iso(now + OWNER_WARNINGS.daysBeforeExpiry * 24 * HOUR);
  const nowIso = iso(now);
  const out: Finding[] = [];
  for (const r of db
    .prepare("SELECT retainer_id, ends_at, max_runs, runs_done FROM retainers WHERE status = 'active'")
    .all() as { retainer_id: string; ends_at: string | null; max_runs: number | null; runs_done: number }[]) {
    if (r.ends_at && r.ends_at > nowIso && r.ends_at < soon) out.push({ kind: "owner-warning", subject: r.retainer_id, what: `retainer ends ${r.ends_at.slice(0, 10)}` });
    else if (r.max_runs && r.max_runs - r.runs_done <= OWNER_WARNINGS.retainerRunsLeft) out.push({ kind: "owner-warning", subject: r.retainer_id, what: `retainer has ${r.max_runs - r.runs_done} runs left` });
  }
  for (const k of db
    .prepare("SELECT key_id, expires_at FROM allowance_key_limits WHERE expires_at IS NOT NULL AND expires_at > ? AND expires_at < ?")
    .all(nowIso, soon) as { key_id: string; expires_at: string }[]) {
    out.push({ kind: "owner-warning", subject: k.key_id, what: `allowance key expires ${k.expires_at.slice(0, 10)}` });
  }
  return out;
}

/** The fee path, watched and never touched: fees that stop arriving, and a pot that could burn and has not. */
export async function feeFlow(now = Date.now()): Promise<Finding[]> {
  const live = await getBurnLive();
  if (!live.live || !live.launched) return [];
  const out: Finding[] = [];
  const quietHours = live.lastBurnAt ? (now / 1000 - live.lastBurnAt) / 3600 : Infinity;
  if (live.ready && live.nextBurnEth > 0 && quietHours > FEE_FLOW.potUnburnedForHours) {
    out.push({ kind: "fee-flow", what: `the pot can burn ${live.nextBurnEth} ETH and has not for ${quietHours.toFixed(1)} hours` });
  } else if (quietHours > FEE_FLOW.noSplitForHours) {
    out.push({ kind: "fee-flow", what: `no burn for ${quietHours.toFixed(1)} hours: fees are not arriving (usually Pons holding them)` });
  }
  return out;
}

/** Money records that do not add up: payments stuck pending, and allowance reservations never closed. */
export function paymentMismatches(now = Date.now()): Finding[] {
  const db = getDb();
  const day = iso(now - 24 * HOUR);
  const pending = (db.prepare("SELECT COUNT(*) n FROM transactions WHERE status = 'pending' AND created_at < ?").get(day) as { n: number }).n;
  const open = (db.prepare("SELECT COUNT(*) n FROM allowance_reservations WHERE state = 'reserved' AND created_at < ?").get(day) as { n: number }).n;
  const out: Finding[] = [];
  if (pending) out.push({ kind: "payment-mismatch", what: `${pending} payments pending for over a day` });
  if (open) out.push({ kind: "payment-mismatch", what: `${open} allowance reservations open for over a day` });
  return out;
}

/** Where this deployment answers: its own Railway domain, so the private site measures itself, not the live one. */
export function siteUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.AUTONOMY_SITE_URL) return env.AUTONOMY_SITE_URL.replace(/\/$/, "");
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return (env.NEXT_PUBLIC_SITE_URL || "https://axon-agents.com").replace(/\/$/, "");
}

/** Every main page loads, and quickly. */
export async function pageHealth(base = siteUrl(), fetchFn: typeof fetch = fetch): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const path of PAGES.paths) {
    const t0 = Date.now();
    try {
      const res = await fetchFn(base + path, { signal: AbortSignal.timeout(PAGES.timeoutMs), cache: "no-store" });
      const ms = Date.now() - t0;
      if (!res.ok) out.push({ kind: "page-check", subject: path, what: `${path} answered ${res.status}` });
      else if (ms > PAGES.slowMs) out.push({ kind: "page-check", subject: path, what: `${path} took ${(ms / 1000).toFixed(1)}s` });
    } catch {
      out.push({ kind: "page-check", subject: path, what: `${path} did not answer` });
    }
  }
  return out;
}

/** Every check, each one isolated: a check that fails is reported as unavailable and the others still run. */
export async function runNetworkChecks(
  now = Date.now(),
  deps: { fetchFn?: typeof fetch } = {},
): Promise<{ findings: Finding[]; failed: string[] }> {
  const checks: [string, () => Finding[] | Promise<Finding[]>][] = [
    ["failing agents", () => failingAgents(now)],
    ["unreachable agents", () => unreachableAgents()],
    ["stuck tasks", () => stuckTasks(now)],
    ["failing webhooks", () => failingWebhooks(now)],
    ["slow agents", () => slowAgents(now)],
    ["price outliers", () => priceOutliers()],
    ["duplicate listings", () => duplicateListings()],
    ["stale descriptions", () => staleDescriptions(now)],
    ["expiring soon", () => expiringSoon(now)],
    ["fee flow", () => feeFlow(now)],
    ["payment mismatches", () => paymentMismatches(now)],
    ["pages", () => pageHealth(siteUrl(), deps.fetchFn ?? fetch)],
  ];
  const findings: Finding[] = [];
  const failed: string[] = [];
  for (const [name, run] of checks) {
    try {
      findings.push(...(await run()));
    } catch {
      failed.push(name);
    }
  }
  return { findings, failed };
}

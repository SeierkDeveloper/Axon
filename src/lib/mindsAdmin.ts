// Agent Minds: Axon's own stop switches, and the admin's view of what minds cost and paid back.
//
// Two switches, neither of which needs a key: every mind at once, or one mind. A stopped mind does not think and
// nothing is sent for it. Neither switch can move anything: a treasury's ETH stays in its contract whatever is
// switched here. The chain has its own stops (a creator's pause, the guardian's freeze); those are signed by their
// own wallets and are not this file's business.

import { getDb } from "./db";
import { mindLabel } from "./mindsModels";

const now = () => new Date().toISOString();

/** Every mind stopped from Axon's side: no thinking, no sending, no housekeeping. */
export function mindsHalted(): boolean {
  try {
    return (getDb().prepare("SELECT value FROM mind_settings WHERE key = 'halted'").get() as { value: string } | undefined)?.value === "1";
  } catch {
    return false; // before the table exists
  }
}

export function setHalted(halted: boolean): void {
  getDb().prepare("INSERT INTO mind_settings (key, value, updated_at) VALUES ('halted', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(halted ? "1" : "0", now());
}

/** Stop one mind. Returns false when there is no such token. */
export function stopMind(token: string, reason: string | null): boolean {
  return getDb().prepare("UPDATE mind_tokens SET stopped_at = ?, stopped_reason = ? WHERE token = ?").run(now(), reason?.trim().slice(0, 200) || null, token.toLowerCase()).changes > 0;
}

export function resumeMind(token: string): boolean {
  return getDb().prepare("UPDATE mind_tokens SET stopped_at = NULL, stopped_reason = NULL WHERE token = ?").run(token.toLowerCase()).changes > 0;
}

export function isStopped(token: string): boolean {
  return Boolean((getDb().prepare("SELECT stopped_at FROM mind_tokens WHERE token = ?").get(token.toLowerCase()) as { stopped_at: string | null } | undefined)?.stopped_at);
}

export interface MindAccount {
  token: string; name: string | null; symbol: string | null; model: string; attached: boolean; stoppedAt: string | null; stoppedReason: string | null;
  treasuryEth: number; paidInEth: number;
  thoughts: number; failedThoughts: number; lastThoughtAt: string | null;
  /** what its thinking has cost Axon's keys, what its treasury has paid back, and what is still owed */
  thinkingUsd: number; thinkingEth: number; paidBackEth: number; owedEth: number;
  boughtBackEth: number; axonBurnedEth: number; rewardedEth: number; actions: number; notSent: number;
}

export interface MindsOverview {
  halted: boolean;
  tokens: number;
  /** real model spend on Axon's keys since midnight UTC, in dollars */
  spentTodayUsd: number;
  thinkingEth: number; paidBackEth: number; owedEth: number;
  minds: MindAccount[];
  /** sent and not yet confirmed, or written down and never sent: what somebody may have to look at */
  open: { id: number; token: string; kind: string; eth: number; status: string; txHash: string | null; at: string }[];
}

export function overview(): MindsOverview {
  const db = getDb();
  const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
  const rows = db.prepare(
    `SELECT t.token, t.name, t.symbol, COALESCE(t.model, '') model, t.attached, t.stopped_at stoppedAt, t.stopped_reason stoppedReason,
       COALESCE(s.treasury_eth, 0) treasuryEth, COALESCE(s.to_mind_eth, 0) paidInEth,
       (SELECT COUNT(*) FROM mind_thoughts h WHERE h.token = t.token AND h.status = 'thought') thoughts,
       (SELECT COUNT(*) FROM mind_thoughts h WHERE h.token = t.token AND h.status = 'failed') failedThoughts,
       (SELECT MAX(at) FROM mind_thoughts h WHERE h.token = t.token) lastThoughtAt,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM mind_thoughts h WHERE h.token = t.token AND h.standin = 0) thinkingUsd,
       (SELECT COALESCE(SUM(cost_eth), 0) FROM mind_thoughts h WHERE h.token = t.token AND h.standin = 0) thinkingEth,
       (SELECT COALESCE(SUM(eth), 0) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'thinking' AND a.status IN ('pending', 'sent', 'done')) paidBackEth,
       (SELECT COALESCE(SUM(eth), 0) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'buyback' AND a.status = 'done') boughtBackEth,
       (SELECT COALESCE(SUM(eth), 0) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'burn_axon' AND a.status = 'done') axonBurnedEth,
       (SELECT COALESCE(SUM(eth), 0) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'reward' AND a.status = 'done') rewardedEth,
       (SELECT COUNT(*) FROM mind_actions a WHERE a.token = t.token AND a.kind != 'thinking' AND a.status = 'done') actions,
       (SELECT COUNT(*) FROM mind_actions a WHERE a.token = t.token AND a.status IN ('failed', 'dropped')) notSent
     FROM mind_tokens t LEFT JOIN mind_stats s ON s.token = t.token ORDER BY t.launched_at DESC LIMIT 500`,
  ).all() as (Omit<MindAccount, "attached" | "owedEth" | "model"> & { attached: number; model: string })[];
  const minds: MindAccount[] = rows.map((r) => ({ ...r, attached: r.attached === 1, model: mindLabel(r.model || null), owedEth: Math.max(0, r.thinkingEth - r.paidBackEth) }));
  const sum = (f: (m: MindAccount) => number) => minds.reduce((s, m) => s + f(m), 0);
  return {
    halted: mindsHalted(),
    tokens: minds.length,
    spentTodayUsd: (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) v FROM mind_thoughts WHERE standin = 0 AND at >= ?").get(day) as { v: number }).v,
    thinkingEth: sum((m) => m.thinkingEth), paidBackEth: sum((m) => m.paidBackEth), owedEth: sum((m) => m.owedEth),
    minds,
    open: db.prepare("SELECT id, token, kind, eth, status, tx_hash txHash, at FROM mind_actions WHERE status IN ('pending', 'sent') ORDER BY id DESC LIMIT 50").all() as MindsOverview["open"],
  };
}

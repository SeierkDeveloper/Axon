// Agent Minds: what the database holds. The tokens the chain says were launched with a mind, the launches people
// prepared (which become tokens only when the chain shows them), and how far the launcher's events have been read.

import { randomBytes } from "node:crypto";
import { getDb } from "./db";

export interface MindToken {
  token: string;
  creator: string;
  agentId: string | null;
  agentRef: string;
  pot: string;
  splitter: string | null;
  vault: string;
  payout: string | null;
  taxBps: number | null;
  creatorBps: number | null;
  burnBps: number | null;
  axonBps: number | null;
  mindBps: number | null;
  attached: boolean;
  name: string | null;
  symbol: string | null;
  logo: string | null;
  description: string | null;
  blockNumber: number;
  txHash: string;
  launchedAt: string;
}

export interface PreparedLaunch {
  ref: string;
  wallet: string;
  agentId: string | null;
  name: string;
  symbol: string;
  line: string | null;
  logo: string | null;
  description: string | null;
  status: "prepared" | "launched";
  token: string | null;
  createdAt: string;
}

const TOKEN_COLS = "token, creator, agent_id agentId, agent_ref agentRef, pot, splitter, vault, payout, tax_bps taxBps, creator_bps creatorBps, burn_bps burnBps, axon_bps axonBps, mind_bps mindBps, attached, name, symbol, logo, description, block_number blockNumber, tx_hash txHash, launched_at launchedAt";
const asToken = (r: Record<string, unknown>): MindToken => ({ ...(r as unknown as MindToken), attached: r.attached === 1 });

// ── Prepared launches ─────────────────────────────────────────────────────────

/** Note a launch somebody is about to sign. The reference goes into their transaction, and is how the chain's record
 *  of that launch finds its way back to the agent it is for. */
export function prepareLaunch(p: { wallet: string; agentId: string | null; name: string; symbol: string; line: string | null; logo: string | null; description: string | null }): PreparedLaunch {
  const ref = `0x${randomBytes(32).toString("hex")}`;
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO mind_launches (ref, wallet, agent_id, name, symbol, line, logo, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,'prepared',?,?)")
    .run(ref, p.wallet.toLowerCase(), p.agentId, p.name, p.symbol, p.line, p.logo, p.description, now, now);
  return getPrepared(ref)!;
}

export function getPrepared(ref: string): PreparedLaunch | null {
  const r = getDb().prepare("SELECT ref, wallet, agent_id agentId, name, symbol, line, logo, description, status, token, created_at createdAt FROM mind_launches WHERE ref = ?").get(ref.toLowerCase()) as PreparedLaunch | undefined;
  return r ?? null;
}

/** Launches a wallet prepared in the last day: how many it may still prepare is counted from these. */
export function preparedToday(wallet: string): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM mind_launches WHERE wallet = ? AND created_at >= ?").get(wallet.toLowerCase(), new Date(Date.now() - 86_400_000).toISOString()) as { n: number }).n;
}

export function markLaunched(ref: string, token: string): void {
  getDb().prepare("UPDATE mind_launches SET status = 'launched', token = ?, updated_at = ? WHERE ref = ?").run(token.toLowerCase(), new Date().toISOString(), ref.toLowerCase());
}

// ── Tokens ────────────────────────────────────────────────────────────────────

/** Write a token as the chain states it. A token already here keeps its agent and its page details. */
export function upsertToken(t: MindToken): void {
  getDb().prepare(`INSERT INTO mind_tokens (token, creator, agent_id, agent_ref, pot, splitter, vault, payout, tax_bps, creator_bps, burn_bps, axon_bps, mind_bps, attached, name, symbol, logo, description, block_number, tx_hash, launched_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET vault = excluded.vault, agent_id = COALESCE(mind_tokens.agent_id, excluded.agent_id), name = COALESCE(mind_tokens.name, excluded.name), symbol = COALESCE(mind_tokens.symbol, excluded.symbol)`)
    .run(t.token, t.creator, t.agentId, t.agentRef, t.pot, t.splitter, t.vault, t.payout, t.taxBps, t.creatorBps, t.burnBps, t.axonBps, t.mindBps, t.attached ? 1 : 0, t.name, t.symbol, t.logo, t.description, t.blockNumber, t.txHash, t.launchedAt, new Date().toISOString());
}

export function getToken(token: string): MindToken | null {
  const r = getDb().prepare(`SELECT ${TOKEN_COLS} FROM mind_tokens WHERE token = ?`).get(token.toLowerCase()) as Record<string, unknown> | undefined;
  return r ? asToken(r) : null;
}

export function tokenOfAgent(agentId: string): MindToken | null {
  const r = getDb().prepare(`SELECT ${TOKEN_COLS} FROM mind_tokens WHERE agent_id = ? ORDER BY launched_at DESC LIMIT 1`).get(agentId) as Record<string, unknown> | undefined;
  return r ? asToken(r) : null;
}

/** Tokens, newest first. */
export function listTokens(limit = 50, before?: string): MindToken[] {
  const rows = before
    ? getDb().prepare(`SELECT ${TOKEN_COLS} FROM mind_tokens WHERE launched_at < ? ORDER BY launched_at DESC LIMIT ?`).all(before, limit)
    : getDb().prepare(`SELECT ${TOKEN_COLS} FROM mind_tokens ORDER BY launched_at DESC LIMIT ?`).all(limit);
  return (rows as Record<string, unknown>[]).map(asToken);
}

export function tokensOfCreator(wallet: string): MindToken[] {
  return (getDb().prepare(`SELECT ${TOKEN_COLS} FROM mind_tokens WHERE creator = ? ORDER BY launched_at DESC`).all(wallet.toLowerCase()) as Record<string, unknown>[]).map(asToken);
}

export function tokenCount(): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM mind_tokens").get() as { n: number }).n;
}

export function linkAgent(token: string, agentId: string): void {
  getDb().prepare("UPDATE mind_tokens SET agent_id = ? WHERE token = ?").run(agentId, token.toLowerCase());
}

// ── The cursor ────────────────────────────────────────────────────────────────

export function cursor(): number | null {
  return (getDb().prepare("SELECT block FROM mind_cursor WHERE id = 1").get() as { block: number } | undefined)?.block ?? null;
}

export function setCursor(block: number): void {
  getDb().prepare("INSERT INTO mind_cursor (id, block) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET block = excluded.block").run(block);
}

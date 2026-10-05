// Agent Studio, phase 6: creators take out what their agents earned.
//
// What users pay for an agent lands in Axon's receiving wallet and is credited to the agent's ledger. A withdrawal pays
// it out from that same wallet (the one key the server already holds, checked against the receiving address in
// evm.sendNative) to the wallet that owns the agent, and nowhere else.
//
// The order matters, because this moves real ETH and cannot be undone:
//   1. under one database transaction, check what the agent can take out and write the withdrawal as pending
//   2. send; the hash is saved the moment the transaction is sent, before waiting for it
//   3. mark it sent, or failed (a failed one stops counting as taken out)
// A pending row counts as taken out, so a crash between 2 and 3 can never let the same ETH be withdrawn twice; it is
// left for an admin to settle against its hash.
//
// For this release only agents published through Agent Studio can withdraw: every one of them came after network
// activity stopped writing payment rows, so all they have earned came from real hires. ETH only; $AXON earnings stay
// on the ledger for now.

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { getAgentById } from "./agents";
import { sendNative, payoutWalletBalance } from "./evm";
import { toWei, weiToEth } from "./money";
import { sameAddress, normalizeAddress } from "./address";
import { withdrawAllowed, withdrawalsEnabled } from "./studioPolicy";
import { logger } from "./logger";

export interface Withdrawal { id: string; agentId: string; wallet: string; amountEth: string; status: "pending" | "sent" | "failed"; txHash: string | null; error: string | null; createdAt: string }

/** Gas the paying wallet keeps back on top of a payout, so it can always send the next one. */
const GAS_RESERVE_WEI = 20_000_000_000_000n; // 0.00002 ETH

const sumWei = (sql: string, ...args: unknown[]) => {
  const rows = getDb().prepare(sql).all(...args) as { v: number | string }[];
  return rows.reduce((s, r) => s + (toWei(r.v) ?? 0n), 0n);
};

/** ETH the agent has taken out or is taking out right now (pending counts: it may already be on its way). */
function withdrawnWei(agentId: string): bigint {
  return sumWei("SELECT amount_eth v FROM agent_withdrawals WHERE agent_id = ? AND status IN ('pending','sent')", agentId);
}

/**
 * ETH the agent can take out now, in wei: everything it earned in ETH, less what it spent or holds in escrow from its
 * balance, less what it has already taken out. Never below zero.
 */
export function withdrawableWei(agentId: string): bigint {
  const earned = sumWei("SELECT amount_eth v FROM transactions WHERE to_agent = ? AND status = 'completed' AND COALESCE(currency, 'ETH') = 'ETH'", agentId);
  const spent = sumWei("SELECT amount_eth v FROM transactions WHERE from_agent = ? AND status IN ('completed','escrow') AND funding_source = 'balance' AND COALESCE(currency, 'ETH') = 'ETH'", agentId);
  const left = earned - spent - withdrawnWei(agentId);
  return left > 0n ? left : 0n;
}

/** What a wallet has taken out (or is taking out) in the last day, across all its agents, in wei. */
function wiredTodayWei(wallet: string): bigint {
  return sumWei("SELECT amount_eth v FROM agent_withdrawals WHERE wallet = ? AND status IN ('pending','sent') AND created_at >= ?", wallet.toLowerCase(), new Date(Date.now() - 86_400_000).toISOString());
}

export function withdrawalsOf(wallet: string, limit = 50): Withdrawal[] {
  return getDb().prepare(
    "SELECT id, agent_id agentId, wallet, amount_eth amountEth, status, tx_hash txHash, error, created_at createdAt FROM agent_withdrawals WHERE wallet = ? ORDER BY created_at DESC LIMIT ?",
  ).all(wallet.toLowerCase(), limit) as Withdrawal[];
}

export interface Earning { agentId: string; name: string; earnedEth: number; withdrawnEth: number; availableEth: number; /** the token that stands behind it, if one was launched */ token: string | null }

// The agents Axon runs for their owners and so holds the earnings of: the ones built in Studio, and the starter agent a
// token was launched with. An agent on its owner's own server is paid another way and is not one of these.
const HOSTED = "(studio_build IS NOT NULL OR public_key LIKE 'minds:%')";
const hosted = (agentId: string): boolean => Boolean(getDb().prepare(`SELECT 1 FROM agents WHERE agent_id = ? AND ${HOSTED}`).get(agentId));

/** A wallet's hosted agents and what each can take out. */
export function earningsOf(wallet: string): Earning[] {
  const rows = getDb().prepare(`SELECT a.agent_id, (SELECT t.token FROM mind_tokens t WHERE t.agent_id = a.agent_id LIMIT 1) token FROM agents a WHERE LOWER(a.wallet_address) = ? AND ${HOSTED} ORDER BY a.created_at DESC`).all(wallet.toLowerCase()) as { agent_id: string; token: string | null }[];
  return rows.map(({ agent_id, token }) => {
    const earned = sumWei("SELECT amount_eth v FROM transactions WHERE to_agent = ? AND status = 'completed' AND COALESCE(currency, 'ETH') = 'ETH'", agent_id);
    return { agentId: agent_id, name: getAgentById(agent_id)?.name ?? agent_id, earnedEth: weiToEth(earned), withdrawnEth: weiToEth(withdrawnWei(agent_id)), availableEth: weiToEth(withdrawableWei(agent_id)), token };
  });
}

/** Withdraw an amount of ETH an agent earned to its owner's wallet. Returns the withdrawal, or why not. */
export async function withdraw(agentId: string, wallet: string, amountEth: number, send: typeof sendNative = sendNative): Promise<Withdrawal | string> {
  if (!withdrawalsEnabled()) return "Withdrawals are paused just now. Your earnings are safe and still yours.";
  const me = wallet.toLowerCase();
  const agent = getAgentById(agentId);
  if (!agent || !sameAddress(agent.walletAddress, me)) return "No such agent of yours.";
  if (!hosted(agentId)) return "Withdrawals are open for agents built in Agent Studio or launched with a token.";
  const to = normalizeAddress(agent.walletAddress ?? "");
  if (!to) return "This agent has no owner wallet to pay.";
  const want = toWei(amountEth);
  if (want === null || want <= 0n) return "Enter an amount.";

  // 1. checked and written as one step: two withdrawals at once cannot both pass the check
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  const reserved = db.transaction((): string | null => {
    const ok = withdrawAllowed(weiToEth(want), "ETH", weiToEth(withdrawableWei(agentId)), weiToEth(wiredTodayWei(me)));
    if (!ok.ok) return ok.reason;
    db.prepare("INSERT INTO agent_withdrawals (id, agent_id, wallet, amount_eth, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, agentId, me, weiToEth(want).toString(), "pending", now, now);
    return null;
  })();
  if (reserved) return reserved;

  const settle = (status: "sent" | "failed", fields: { txHash?: string | null; error?: string | null }) =>
    db.prepare("UPDATE agent_withdrawals SET status = ?, tx_hash = COALESCE(?, tx_hash), error = ?, updated_at = ? WHERE id = ?")
      .run(status, fields.txHash ?? null, fields.error ?? null, new Date().toISOString(), id);

  // the paying wallet must cover it, with gas to spare; if not, nothing is sent and the earnings stay
  const held = await payoutWalletBalance();
  if (held === null || held < want + GAS_RESERVE_WEI) {
    settle("failed", { error: "payout wallet short" });
    logger.warn("studio.withdraw_short", "The payout wallet could not cover a withdrawal", { agentId, amountEth: weiToEth(want) });
    return "Payouts are being topped up. Try again shortly; your earnings are safe.";
  }

  // 2. send, keeping the hash the moment it exists
  try {
    const hash = await send(to, weiToEth(want).toString(), (h) => db.prepare("UPDATE agent_withdrawals SET tx_hash = ?, updated_at = ? WHERE id = ?").run(h, new Date().toISOString(), id));
    // 3. done
    settle("sent", { txHash: hash });
    logger.info("studio.withdrawn", "A creator took earnings out", { agentId, wallet: me, amountEth: weiToEth(want), hash });
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 200) : String(err);
    const sentHash = (db.prepare("SELECT tx_hash FROM agent_withdrawals WHERE id = ?").get(id) as { tx_hash: string | null }).tx_hash;
    if (sentHash) {
      // it left the wallet but its receipt did not come back: keep it pending for an admin to settle, never re-open it
      db.prepare("UPDATE agent_withdrawals SET error = ?, updated_at = ? WHERE id = ?").run(`unconfirmed: ${why}`, new Date().toISOString(), id);
      logger.error("studio.withdraw_unconfirmed", "A withdrawal was sent but not confirmed", { id, agentId, hash: sentHash, why });
      return "Your withdrawal was sent and is confirming. It shows in your history.";
    }
    settle("failed", { error: why });
    logger.warn("studio.withdraw_failed", "A withdrawal could not be sent", { agentId, why });
    return "The withdrawal could not be sent. Nothing left your earnings; try again.";
  }
  return withdrawalsOf(me).find((w) => w.id === id)!;
}


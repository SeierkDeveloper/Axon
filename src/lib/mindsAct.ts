// Agent Minds: minds that act.
//
// A mind proposes and the rule check decides; this is the part that sends. It is the only code that holds the signer's
// key, and the only things it can do with it are the six calls named below: the treasury's four actions, a fee
// splitter's sweep and a burn pot's burn. It never sends ETH anywhere itself, and it cannot name a destination: every
// one of those calls pays out only to addresses fixed in the contracts at launch.
//
// Before anything is sent, the proposal is put to the rule check a SECOND time against what the chain says now (the
// treasury's balance and its own count of today), then run against the chain without being sent. Only then is it
// written down as pending and sent. The treasury enforces the creator's limits again on its side: this code being
// wrong can at worst send nothing.
//
// Off unless MINDS_ACTING is "on" and the signer's key is set.

import { decodeEventLog, parseEther, type Abi, type Hex } from "viem";
import { getDb } from "./db";
import { agentMindsEnabled } from "./mindsPolicy";
import { mindsChain, VAULT_WRITE_ABI, KEEPER_ABI, type MindsChain } from "./mindsChain";
import { checkProposal, type Proposal } from "./mindsRules";
import { divide, merkle } from "./mindsMerkle";
import { addEvent } from "./mindsStats";
import { owedThinkingEth } from "./mindsMind";
import { reserveOf } from "./mindsPlan";
import { mindsHalted } from "./mindsAdmin";
import { publicClient, walletClientFor } from "./evm";
import { logger } from "./logger";

/** A proposal older than this is not sent: the numbers it was made on have moved. */
export const STALE_MS = 20 * 60_000;
/** A share of a reward smaller than this is not worth the gas to claim it. */
export const MIN_SHARE_WEI = 1_000_000_000_000n; // 0.000001 ETH
/** Thinking is paid back to Axon once this much is owed, not for every thought. */
export const MIN_THINKING_PAYMENT_ETH = 0.0002;
/** Fees are swept to a token's splitter once this much is waiting. */
export const MIN_SWEEP_ETH = 0.0003;
// Both floors can be lowered for a service through its settings (a private site testing with small amounts); a value
// that is not a positive number is ignored.
const floorOf = (env: Record<string, string | undefined>, key: string, fallback: number): number => { const n = Number(env[key]); return Number.isFinite(n) && n > 0 ? n : fallback; };
export const minThinkingPaymentEth = (env: Record<string, string | undefined> = process.env): number => floorOf(env, "MINDS_MIN_THINKING_PAYMENT_ETH", MIN_THINKING_PAYMENT_ETH);
export const minSweepEth = (env: Record<string, string | undefined> = process.env): number => floorOf(env, "MINDS_MIN_SWEEP_ETH", MIN_SWEEP_ETH);
const NOBODY = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"];

export function actingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return agentMindsEnabled(env) && (env.MINDS_ACTING ?? "off").trim().toLowerCase() === "on" && Boolean(env.MIND_SIGNER_KEY?.trim()) && !mindsHalted();
}

/** How the signer reaches the chain. The real one signs with MIND_SIGNER_KEY; tests write their own. */
export interface MindSender {
  address(): string;
  /** Run a call against the chain without sending it. Throws with the reason when it would revert. */
  simulate(to: string, abi: Abi, functionName: string, args: readonly unknown[]): Promise<unknown>;
  send(to: string, abi: Abi, functionName: string, args: readonly unknown[]): Promise<string>;
  wait(hash: string): Promise<{ ok: boolean; logs: { address: string; topics: Hex[]; data: Hex }[] }>;
}

// The signer's wallet may also be the one another job sends from (the burn bot). When both reach for the wallet's
// next turn in the same moment the chain refuses one of them outright: nothing was sent, so sending it again is safe.
const TURN_TAKEN = /nonce too low|nonce has already been used|replacement transaction underpriced/i;
export async function sendInTurn<T>(send: () => Promise<T>, pauseMs = 1_500, tries = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await send(); }
    catch (err) {
      if (attempt >= tries || !TURN_TAKEN.test(err instanceof Error ? `${(err as { shortMessage?: string }).shortMessage ?? ""} ${err.message}` : String(err))) throw err;
      await new Promise((r) => setTimeout(r, pauseMs * attempt));
    }
  }
}

function realSender(env: Record<string, string | undefined> = process.env): MindSender {
  const { account, client } = walletClientFor(env.MIND_SIGNER_KEY ?? "");
  const reader = publicClient();
  return {
    address: () => account.address.toLowerCase(),
    simulate: async (to, abi, functionName, args) => (await reader.simulateContract({ address: to as Hex, abi, functionName, args, account })).result,
    send: (to, abi, functionName, args) => sendInTurn(() => client.writeContract({ address: to as Hex, abi, functionName, args })),
    wait: async (hash) => {
      const r = await reader.waitForTransactionReceipt({ hash: hash as Hex, timeout: 120_000, pollingInterval: 1_500 });
      return { ok: r.status === "success", logs: r.logs as unknown as { address: string; topics: Hex[]; data: Hex }[] };
    },
  };
}

const reason = (err: unknown) => (err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message) : String(err)).split("\n")[0].slice(0, 300);
const ethOf = (wei: bigint) => Number(wei) / 1e18;
const now = () => new Date().toISOString();

export interface ActOptions { chain?: MindsChain; sender?: MindSender; env?: Record<string, string | undefined>; now?: number }

interface Due { id: number; token: string; at: string; action: string; vault: string; pot: string; splitter: string | null; curve: string | null; attached: number; phase: number; holders: number; holders_block: number | null }

function setStatus(id: number, status: string, fields: { tx?: string; error?: string } = {}): void {
  getDb().prepare("UPDATE mind_actions SET status = ?, tx_hash = COALESCE(?, tx_hash), error = ?, updated_at = ? WHERE id = ?").run(status, fields.tx ?? null, fields.error ?? null, now(), id);
}

/** Write an action down before it is sent. Returns its id, or null when this thought already has one. */
function begin(thoughtId: number | null, token: string, kind: string, wei: bigint, status = "pending", error: string | null = null): number | null {
  try {
    const r = getDb().prepare("INSERT INTO mind_actions (thought_id, token, kind, wei, eth, status, error, at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(thoughtId, token, kind, wei.toString(), ethOf(wei), status, error, now(), now());
    return Number(r.lastInsertRowid);
  } catch {
    return null; // the UNIQUE on thought_id: it has been acted on already
  }
}

/** Who a reward goes to: wallets holding the token, never the curve, the pool, the token's own contracts or nobody. */
function holdersOf(d: Due, poolManager: string | null): { account: string; balance: bigint }[] {
  const skip = new Set([...NOBODY, d.curve ?? "", d.pot, d.vault, d.splitter ?? "", poolManager ?? ""].map((a) => a.toLowerCase()));
  const rows = getDb().prepare("SELECT address, balance FROM mind_holders WHERE token = ? AND balance != '0'").all(d.token) as { address: string; balance: string }[];
  return rows.filter((r) => !skip.has(r.address.toLowerCase())).map((r) => ({ account: r.address, balance: BigInt(r.balance) }));
}

/** Carry out one approved proposal, or write down why it was not sent. */
async function act(d: Due, o: Required<Pick<ActOptions, "chain" | "sender">> & { now: number }): Promise<"done" | "failed" | "dropped" | "skipped"> {
  const p = JSON.parse(d.action) as Proposal;
  let wei: bigint;
  // to the gwei: a float's last digits are noise, and noise must never carry an amount past a limit
  try { wei = parseEther((Math.floor(p.eth * 1e9) / 1e9).toFixed(9)); } catch { wei = 0n; }
  const drop = (why: string) => { begin(d.id, d.token, p.kind, wei, "dropped", why); return "dropped" as const; };
  if (o.now - Date.parse(d.at) > STALE_MS) return drop("It waited too long to be sent: the numbers it was made on have moved.");

  // the second look, against what the chain says now
  const [treasury, day, snap] = await Promise.all([o.chain.treasury(d.vault), o.chain.vaultDay(d.vault), o.chain.snapshot(d)]);
  const verdict = checkProposal(p, {
    allowed: treasury.limits.allowed, maxPerDayEth: treasury.limits.maxPerDayEth, maxPerActionEth: treasury.limits.maxPerActionEth, maxActionsPerDay: treasury.limits.maxActionsPerDay,
    availableEth: treasury.availableEth, owedThinkingEth: owedThinkingEth(d.token), spentTodayEth: day.spentTodayEth, actionsToday: day.actionsToday, active: treasury.active, phase: snap.phase, holders: d.holders, attached: d.attached === 1,
    // the reserve its plan keeps holds on the second look too
    reserveEth: reserveOf(d.token),
  });
  if (!verdict.ok) return drop(`Refused on the second look: ${verdict.reason}`);

  let fn: "buyback" | "burnAxon" | "startReward", args: readonly unknown[];
  let shares: ReturnType<typeof divide> = [], tree: ReturnType<typeof merkle> | null = null;
  if (p.kind === "reward") {
    shares = divide(wei, holdersOf(d, snap.poolManager), MIN_SHARE_WEI);
    if (shares.length < 2) return drop("There are not enough holders with a share worth claiming.");
    tree = merkle(shares);
    fn = "startReward"; args = [tree.root, wei];
  } else {
    fn = p.kind === "buyback" ? "buyback" : "burnAxon"; args = [wei];
  }
  try { await o.sender.simulate(d.vault, VAULT_WRITE_ABI, fn, args); } catch (err) { return drop(`The treasury would refuse it: ${reason(err)}`); }

  const id = begin(d.id, d.token, p.kind, wei);
  if (id === null) return "skipped";
  let hash: string;
  try { hash = await o.sender.send(d.vault, VAULT_WRITE_ABI, fn, args); } catch (err) { setStatus(id, "failed", { error: reason(err) }); return "failed"; }
  setStatus(id, "sent", { tx: hash });
  const receipt = await o.sender.wait(hash).catch(() => null);
  // no answer is not a failure: the transaction may still land. It stays "sent" and is settled on a later pass.
  if (!receipt) return "skipped";
  if (!receipt.ok) { setStatus(id, "failed", { error: "The transaction reverted." }); return "failed"; }

  const db = getDb();
  db.transaction(() => {
    if (tree) {
      let rewardId = -1, startAt = 0, endAt = 0;
      for (const log of receipt.logs) {
        try {
          const ev = decodeEventLog({ abi: VAULT_WRITE_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data });
          if (ev.eventName === "RewardStarted") { rewardId = Number(ev.args.id); startAt = Number(ev.args.startAt); endAt = Number(ev.args.endAt); }
        } catch { /* another contract's event */ }
      }
      if (rewardId >= 0) {
        db.prepare("INSERT OR IGNORE INTO mind_rewards (token, reward_id, root, total_wei, start_at, end_at, at_block, created_at) VALUES (?,?,?,?,?,?,?,?)").run(d.token, rewardId, tree.root, wei.toString(), startAt, endAt, d.holders_block ?? 0, now());
        const put = db.prepare("INSERT OR IGNORE INTO mind_reward_shares (token, reward_id, idx, account, amount_wei, proof) VALUES (?,?,?,?,?,?)");
        shares.forEach((s, i) => put.run(d.token, rewardId, s.index, s.account, s.amount.toString(), JSON.stringify(tree!.proofs[i])));
      }
    }
    setStatus(id, "done");
    addEvent(d.token, p.kind === "buyback" ? "bought" : p.kind === "reward" ? "rewarded" : "axon", { eth: ethOf(wei), tokens: p.kind === "reward" ? shares.length : null });
  })();
  logger.info("minds.acted", "A mind's proposal was sent", { token: d.token, kind: p.kind, eth: ethOf(wei), tx: hash });
  return "done";
}

/** Send what the rule check passed and nobody has sent yet: one proposal a token at a time, oldest first. */
export async function actDue(o: ActOptions = {}, limit = 5): Promise<{ done: number; failed: number; dropped: number } | null> {
  const env = o.env ?? process.env;
  if (!actingEnabled(env)) return null;
  const chain = o.chain ?? mindsChain, sender = o.sender ?? realSender(env), at = o.now ?? Date.now();
  const due = getDb().prepare(
    `SELECT h.id, h.token, h.at, h.action, t.vault, t.pot, t.splitter, t.curve, t.attached, COALESCE(s.phase, 0) phase, COALESCE(s.holders, 0) holders, s.holders_block
       FROM mind_thoughts h JOIN mind_tokens t ON t.token = h.token LEFT JOIN mind_stats s ON s.token = h.token
      WHERE h.status = 'thought' AND h.verdict = 'approved' AND h.action IS NOT NULL AND t.stopped_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM mind_actions a WHERE a.thought_id = h.id)
        AND NOT EXISTS (SELECT 1 FROM mind_actions a WHERE a.token = h.token AND a.status IN ('pending', 'sent'))
        AND h.id = (SELECT MIN(h2.id) FROM mind_thoughts h2 WHERE h2.token = h.token AND h2.status = 'thought' AND h2.verdict = 'approved' AND h2.action IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM mind_actions a WHERE a.thought_id = h2.id))
      ORDER BY h.id ASC LIMIT ?`,
  ).all(limit) as Due[];
  const out = { done: 0, failed: 0, dropped: 0 };
  for (const d of due) {
    const r = await act(d, { chain, sender, now: at }).catch((err) => { logger.warn("minds.act_error", "Acting on a proposal went wrong", { err, token: d.token }); return "skipped" as const; });
    if (r !== "skipped") out[r]++;
  }
  return out;
}

/** Actions that were sent and never heard back from (a restart in between): look their transactions up and close them. */
export async function settleSent(o: ActOptions = {}): Promise<number> {
  const env = o.env ?? process.env;
  // closing the record of something already sent sends nothing, so it goes on while minds are stopped
  if (!actingEnabled(env) && !(mindsHalted() && Boolean(env.MIND_SIGNER_KEY?.trim()) && (env.MINDS_ACTING ?? "off").trim().toLowerCase() === "on")) return 0;
  const sender = o.sender ?? realSender(env);
  const db = getDb();
  // written down but never sent: the process stopped in between. A thought is never acted on twice, so this is final.
  db.prepare("UPDATE mind_actions SET status = 'failed', error = 'It was never sent.', updated_at = ? WHERE status = 'pending' AND at < ?").run(now(), new Date((o.now ?? Date.now()) - 10 * 60_000).toISOString());
  const rows = db.prepare("SELECT id, token, kind, eth, tx_hash FROM mind_actions WHERE status = 'sent' AND tx_hash IS NOT NULL LIMIT 20").all() as { id: number; token: string; kind: string; eth: number; tx_hash: string }[];
  let settled = 0;
  for (const r of rows) {
    const receipt = await sender.wait(r.tx_hash).catch(() => null);
    if (!receipt) continue;
    setStatus(r.id, receipt.ok ? "done" : "failed", receipt.ok ? {} : { error: "The transaction reverted." });
    if (receipt.ok && r.kind !== "thinking") addEvent(r.token, r.kind === "buyback" ? "bought" : r.kind === "reward" ? "rewarded" : "axon", { eth: r.eth });
    settled++;
  }
  return settled;
}

/** What a mind has paid for its thinking so far, in ETH (anything sent counts: it may already be on its way). */
export function paidThinkingEth(token: string): number {
  return (getDb().prepare("SELECT COALESCE(SUM(eth), 0) v FROM mind_actions WHERE token = ? AND kind = 'thinking' AND status IN ('pending', 'sent', 'done')").get(token.toLowerCase()) as { v: number }).v;
}

/**
 * Minds pay Axon back for their thinking, at cost: once a mind owes enough to be worth a transaction, its treasury
 * pays what it can within what its thinking may cost in a day. The treasury sends it to the cost wallet fixed in the
 * launcher; this code cannot name another.
 */
export async function payThinkingDue(o: ActOptions = {}, limit = 5): Promise<number> {
  const env = o.env ?? process.env;
  if (!actingEnabled(env)) return 0;
  const chain = o.chain ?? mindsChain, sender = o.sender ?? realSender(env);
  const rows = getDb().prepare(
    `SELECT t.token, t.vault FROM mind_tokens t
      WHERE t.stopped_at IS NULL AND NOT EXISTS (SELECT 1 FROM mind_actions a WHERE a.token = t.token AND a.status IN ('pending', 'sent'))
        AND (SELECT COALESCE(SUM(cost_eth), 0) FROM mind_thoughts h WHERE h.token = t.token AND h.standin = 0)
          - (SELECT COALESCE(SUM(eth), 0) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'thinking' AND a.status IN ('pending', 'sent', 'done')) >= ?
      LIMIT ?`,
  ).all(minThinkingPaymentEth(env), limit) as { token: string; vault: string }[];
  let paid = 0;
  for (const r of rows) {
    try {
      const [treasury, day] = await Promise.all([chain.treasury(r.vault), chain.vaultDay(r.vault)]);
      if (treasury.frozen) continue;
      const owed = owedThinkingEth(r.token);
      const room = treasury.limits.maxCostPerDayEth - day.costTodayEth;
      const amount = Math.min(owed, room, treasury.availableEth);
      if (amount < minThinkingPaymentEth(env)) continue;
      const wei = parseEther((Math.floor(amount * 1e9) / 1e9).toFixed(9));
      await sender.simulate(r.vault, VAULT_WRITE_ABI, "payThinking", [wei]);
      const id = begin(null, r.token, "thinking", wei);
      if (id === null) continue;
      let hash: string;
      try { hash = await sender.send(r.vault, VAULT_WRITE_ABI, "payThinking", [wei]); } catch (err) { setStatus(id, "failed", { error: reason(err) }); continue; }
      setStatus(id, "sent", { tx: hash });
      const receipt = await sender.wait(hash).catch(() => null);
      if (receipt) setStatus(id, receipt.ok ? "done" : "failed", receipt.ok ? {} : { error: "The transaction reverted." });
      if (receipt?.ok) paid++;
    } catch (err) {
      logger.warn("minds.pay_thinking_failed", "A mind could not pay for its thinking", { err: reason(err), token: r.token });
    }
  }
  return paid;
}

/**
 * The housekeeping a token needs somebody to do: move its trading fees from the curve to its splitter (which pays the
 * four shares), and let its burn pot burn when the pot is ready. Both calls are open to anybody; the signer makes them
 * so that they happen. Neither takes an amount or a destination.
 */
export async function keepUp(o: ActOptions = {}, limit = 20): Promise<{ swept: number; burned: number } | null> {
  const env = o.env ?? process.env;
  if (!actingEnabled(env)) return null;
  const sender = o.sender ?? realSender(env);
  const rows = getDb().prepare("SELECT token, pot, splitter FROM mind_tokens WHERE stopped_at IS NULL ORDER BY launched_at DESC LIMIT ?").all(limit) as { token: string; pot: string; splitter: string | null }[];
  const out = { swept: 0, burned: 0 };
  for (const r of rows) {
    try {
      if (r.splitter) {
        const waiting = (await sender.simulate(r.splitter, KEEPER_ABI, "sweep", []).catch(() => 0n)) as bigint;
        if (ethOf(waiting) >= minSweepEth(env)) { const h = await sender.send(r.splitter, KEEPER_ABI, "sweep", []); if ((await sender.wait(h)).ok) out.swept++; }
      }
      const [, , ready] = (await sender.simulate(r.pot, KEEPER_ABI, "preview", []).catch(() => [0n, 0n, false])) as [bigint, bigint, boolean];
      if (ready) {
        // run it first: a pot that says it is ready can still be refused by the market in that block
        const would = await sender.simulate(r.pot, KEEPER_ABI, "burn", [0n]).then(() => true).catch(() => false);
        if (would) { const h = await sender.send(r.pot, KEEPER_ABI, "burn", [0n]); if ((await sender.wait(h)).ok) out.burned++; }
      }
    } catch (err) {
      logger.warn("minds.keep_failed", "Housekeeping for a token went wrong", { err: reason(err), token: r.token });
    }
  }
  return out;
}

// ── Rewards, as a holder sees them ────────────────────────────────────────────

export interface ClaimableShare { token: string; symbol: string | null; name: string | null; vault: string; rewardId: number; index: number; amountWei: string; amountEth: number; proof: string[]; startAt: number; endAt: number }

/** What an account can claim: its shares of rewards that are not claimed and not past their window. */
export function sharesOf(account: string, nowSeconds = Math.floor(Date.now() / 1000)): ClaimableShare[] {
  const rows = getDb().prepare(
    `SELECT s.token, t.symbol, t.name, t.vault, s.reward_id rewardId, s.idx "index", s.amount_wei amountWei, s.proof, r.start_at startAt, r.end_at endAt
       FROM mind_reward_shares s JOIN mind_rewards r ON r.token = s.token AND r.reward_id = s.reward_id JOIN mind_tokens t ON t.token = s.token
      WHERE s.account = ? AND s.claimed = 0 AND r.end_at > ? ORDER BY r.start_at ASC`,
  ).all(account.toLowerCase(), nowSeconds) as (Omit<ClaimableShare, "proof" | "amountEth"> & { proof: string })[];
  return rows.map((r) => ({ ...r, proof: JSON.parse(r.proof) as string[], amountEth: ethOf(BigInt(r.amountWei)) }));
}

function markClaimed(token: string, rewardId: number, index: number): void {
  getDb().prepare("UPDATE mind_reward_shares SET claimed = 1 WHERE token = ? AND reward_id = ? AND idx = ?").run(token.toLowerCase(), rewardId, index);
}

/** Asks a treasury whether a share was claimed already. Unreadable counts as not claimed: the claim itself is checked by the chain. */
export type ClaimCheck = (vault: string, rewardId: number, index: number) => Promise<boolean>;
const chainClaimed: ClaimCheck = (vault, rewardId, index) =>
  publicClient().readContract({ address: vault as `0x${string}`, abi: VAULT_WRITE_ABI, functionName: "isClaimed", args: [BigInt(rewardId), BigInt(index)] }).then(Boolean).catch(() => false);

/**
 * What an account can still claim, checked against the chain: a share its treasury says is claimed is marked so here
 * and left out. The page with the claim button and Mylo both answer from this.
 */
export async function openSharesOf(account: string, claimed: ClaimCheck = chainClaimed, limit = 50): Promise<ClaimableShare[]> {
  const open: ClaimableShare[] = [];
  for (const s of sharesOf(account).slice(0, limit)) {
    if (await claimed(s.vault, s.rewardId, s.index).catch(() => false)) markClaimed(s.token, s.rewardId, s.index);
    else open.push(s);
  }
  return open;
}

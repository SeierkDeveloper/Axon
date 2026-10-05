// Agent Minds: the numbers the board and the launch terminal show.
//
// Every token gets one row of numbers, rewritten from the chain by the worker: price, market cap, how far along its
// curve, holders, what its fees have paid out and burned, what its mind holds. When a number moves, the move is
// written down as an event, and those events are the terminal's running log. Pages read these rows and never ask the
// chain for every token on every visit.

import { getDb } from "./db";
import { agentMindsEnabled } from "./mindsPolicy";
import { mindsChain, mindLauncherAddress, type MindsChain, type Snapshot } from "./mindsChain";
import { cursor } from "./mindsStore";
import { toWei, weiToEth } from "./money";
import { logger } from "./logger";

/** Tokens refreshed in one pass, longest-waiting first. */
const TOKENS_PER_PASS = 40;
/** Blocks of transfers read in one pass at most. */
const MAX_HOLDER_BLOCKS = 2_000_000n;
const NOBODY = ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"];

export type MindEventKind = "launch" | "fees" | "burn" | "graduated" | "holders" | "earned" | "thought" | "bought" | "axon" | "rewarded" | "attached" | "topup";

interface StatsRow { token: string; phase: number; treasury_eth: number; fees_eth: number; burns: number; burned_tokens: number; burned_eth: number; holders_block: number | null; holders_mark: number; earned_mark: number }
interface TokenRow { token: string; pot: string; splitter: string | null; vault: string; curve: string | null; block_number: number; agent_id: string | null; launched_at: string; attached: number }

/**
 * What an agent has earned from real work since its token launched, in ETH. Anything it earned before the launch is
 * not the token's: the count starts at the launch and only goes forward.
 */
export function earnedSince(agentId: string, launchedAt: string): number {
  const rows = getDb().prepare(
    "SELECT amount_eth v FROM transactions WHERE to_agent = ? AND status = 'completed' AND COALESCE(currency, 'ETH') = 'ETH' AND COALESCE(settled_at, created_at) >= ?",
  ).all(agentId, launchedAt) as { v: number | string }[];
  return weiToEth(rows.reduce((s, r) => s + (toWei(r.v) ?? 0n), 0n));
}

export function addEvent(token: string, kind: MindEventKind, v: { eth?: number | null; tokens?: number | null; at?: string } = {}): void {
  getDb().prepare("INSERT INTO mind_events (token, kind, eth, tokens, at) VALUES (?,?,?,?,?)").run(token.toLowerCase(), kind, v.eth ?? null, v.tokens ?? null, v.at ?? new Date().toISOString());
}

// ── Holders ───────────────────────────────────────────────────────────────────

/**
 * Bring every token's holder balances up to `upTo`, from its own Transfer events. A token starts at the block it was
 * launched in; tokens waiting from the same block are read in one request.
 */
async function countHolders(chain: MindsChain, upTo: bigint): Promise<void> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT t.token, COALESCE(s.holders_block, t.block_number - 1) at FROM mind_tokens t LEFT JOIN mind_stats s ON s.token = t.token WHERE COALESCE(s.holders_block, t.block_number - 1) < ?",
  ).all(Number(upTo)) as { token: string; at: number }[];
  const groups = new Map<number, string[]>();
  for (const r of rows) groups.set(r.at, [...(groups.get(r.at) ?? []), r.token]);

  for (const [at, tokens] of groups) {
    const from = BigInt(at) + 1n;
    const to = upTo - from >= MAX_HOLDER_BLOCKS ? from + MAX_HOLDER_BLOCKS - 1n : upTo;
    const transfers = await chain.transfers(tokens, from, to);
    db.transaction(() => {
      const balances = new Map<string, bigint>();
      const read = db.prepare("SELECT balance FROM mind_holders WHERE token = ? AND address = ?");
      const get = (token: string, address: string) => {
        const k = `${token}:${address}`;
        if (!balances.has(k)) balances.set(k, BigInt((read.get(token, address) as { balance: string } | undefined)?.balance ?? "0"));
        return balances.get(k)!;
      };
      for (const t of transfers) {
        if (t.value === 0n) continue;
        const a = t.from.toLowerCase(), b = t.to.toLowerCase();
        // a mint comes from nobody: there is nothing to take away
        if (a !== NOBODY[0]) balances.set(`${t.token}:${a}`, get(t.token, a) - t.value);
        balances.set(`${t.token}:${b}`, get(t.token, b) + t.value);
      }
      const write = db.prepare("INSERT INTO mind_holders (token, address, balance) VALUES (?,?,?) ON CONFLICT(token, address) DO UPDATE SET balance = excluded.balance");
      for (const [k, v] of balances) {
        const [token, address] = k.split(":");
        // a balance can never be below nothing; a negative one would mean a transfer was missed, so say so
        if (v < 0n) logger.warn("minds.holders_negative", "A holder balance went below zero", { token, address });
        write.run(token, address, (v < 0n ? 0n : v).toString());
      }
      const mark = db.prepare("INSERT INTO mind_stats (token, holders_block) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET holders_block = excluded.holders_block");
      for (const token of tokens) mark.run(token, Number(to));
    })();
  }
}

/** Wallets holding a token: everybody with a balance who is not the curve, the pool, the token's own contracts or nobody. */
function holderCount(t: TokenRow, curve: string, poolManager: string | null): number {
  const skip = [...NOBODY, curve, t.pot, t.vault, ...(t.splitter ? [t.splitter] : []), ...(poolManager ? [poolManager] : [])].map((a) => a.toLowerCase());
  return (getDb().prepare(`SELECT COUNT(*) n FROM mind_holders WHERE token = ? AND balance != '0' AND address NOT IN (${skip.map(() => "?").join(",")})`).get(t.token, ...skip) as { n: number }).n;
}

// ── The pass ──────────────────────────────────────────────────────────────────

function write(t: TokenRow, s: Snapshot, prev: StatsRow | undefined): number {
  const db = getDb();
  let events = 0;
  const moved = (now: number, was: number) => now - was > 1e-12;
  if (moved(s.feesEth, prev?.fees_eth ?? 0)) { addEvent(t.token, "fees", { eth: s.feesEth - (prev?.fees_eth ?? 0) }); events++; }
  if (s.burns > (prev?.burns ?? 0)) { addEvent(t.token, "burn", { tokens: s.burnedTokens - (prev?.burned_tokens ?? 0), eth: s.burnedEth - (prev?.burned_eth ?? 0) }); events++; }
  if (s.phase === 2 && (prev?.phase ?? 0) !== 2 && prev) { addEvent(t.token, "graduated"); events++; }

  // a mind given to an earlier token is not fed by fees: its treasury only grows when somebody tops it up
  if (t.attached && moved(s.treasuryEth, prev?.treasury_eth ?? 0)) { addEvent(t.token, "topup", { eth: s.treasuryEth - (prev?.treasury_eth ?? 0) }); events++; }

  // holders and the agent's earnings move in small steps; an event is a real change since the last one written down
  const holders = holderCount(t, s.curve, s.poolManager);
  const mark = prev?.holders_mark ?? 0;
  let holdersMark = mark;
  if (!t.attached && Math.abs(holders - mark) >= Math.max(2, Math.ceil(mark * 0.1))) { addEvent(t.token, "holders", { tokens: holders }); holdersMark = holders; events++; }
  const earned = t.agent_id ? earnedSince(t.agent_id, t.launched_at) : 0;
  let earnedMark = prev?.earned_mark ?? 0;
  if (moved(earned, earnedMark)) { addEvent(t.token, "earned", { eth: earned - earnedMark }); earnedMark = earned; events++; }

  if (!t.curve) db.prepare("UPDATE mind_tokens SET curve = ? WHERE token = ?").run(s.curve, t.token);
  db.prepare(`INSERT INTO mind_stats (token, phase, price_eth, mcap_eth, curve_bps, holders, fees_eth, to_mind_eth, burned_tokens, burned_eth, burns, treasury_eth, holders_mark, earned_mark, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(token) DO UPDATE SET phase = excluded.phase, price_eth = excluded.price_eth, mcap_eth = excluded.mcap_eth, curve_bps = excluded.curve_bps, holders = excluded.holders, fees_eth = excluded.fees_eth,
      to_mind_eth = excluded.to_mind_eth, burned_tokens = excluded.burned_tokens, burned_eth = excluded.burned_eth, burns = excluded.burns, treasury_eth = excluded.treasury_eth,
      holders_mark = excluded.holders_mark, earned_mark = excluded.earned_mark, updated_at = excluded.updated_at`)
    .run(t.token, s.phase, s.priceEth, s.priceEth === null ? null : s.priceEth * s.supply, s.curveBps, holders, s.feesEth, s.toMindEth, s.burnedTokens, s.burnedEth, s.burns, s.treasuryEth, holdersMark, earnedMark, new Date().toISOString());
  return events;
}

/**
 * Refresh the numbers for the tokens that have waited longest. Returns what the pass did, or null when there is
 * nothing to read (switched off, no launcher, or the launcher's events not read yet).
 */
export async function refreshStats(chain: MindsChain = mindsChain, env: Record<string, string | undefined> = process.env, limit = TOKENS_PER_PASS): Promise<{ tokens: number; events: number } | null> {
  if (!agentMindsEnabled(env) || !mindLauncherAddress(env)) return null;
  const upTo = cursor();
  if (upTo === null) return null;
  const db = getDb();

  await countHolders(chain, BigInt(upTo)).catch((err) => logger.warn("minds.holders_failed", "Counting holders failed", { err }));

  const due = db.prepare(
    "SELECT t.token, t.pot, t.splitter, t.vault, t.curve, t.block_number, t.agent_id, t.launched_at, t.attached FROM mind_tokens t LEFT JOIN mind_stats s ON s.token = t.token ORDER BY s.updated_at IS NOT NULL, s.updated_at ASC LIMIT ?",
  ).all(limit) as TokenRow[];
  let tokens = 0, events = 0;
  for (const t of due) {
    try {
      const snap = await chain.snapshot(t);
      const prev = db.prepare("SELECT token, phase, treasury_eth, fees_eth, burns, burned_tokens, burned_eth, holders_block, holders_mark, earned_mark FROM mind_stats WHERE token = ? AND updated_at IS NOT NULL").get(t.token) as StatsRow | undefined;
      db.transaction(() => { events += write(t, snap, prev); })();
      tokens++;
    } catch (err) {
      // one token that cannot be read does not hold up the rest; it keeps its last numbers
      logger.warn("minds.snapshot_failed", "Could not read a token's numbers", { err, token: t.token });
    }
  }
  return { tokens, events };
}

// ── What the pages read ───────────────────────────────────────────────────────

export interface BoardToken {
  token: string; name: string | null; symbol: string | null; logo: string | null; creator: string; launchedAt: string; txHash: string;
  agentId: string | null; agentName: string | null;
  pot: string; splitter: string | null; vault: string; payout: string | null; attached: boolean;
  taxBps: number | null; creatorBps: number | null; burnBps: number | null; axonBps: number | null; mindBps: number | null; model: string | null;
  phase: number; priceEth: number | null; mcapEth: number | null; curveBps: number; holders: number;
  feesEth: number; toMindEth: number; burnedTokens: number; burnedEth: number; burns: number; treasuryEth: number;
  /** ETH this token's mind has set aside for holders so far */
  rewardsEth: number;
  /** and what it has sent to buybacks, to burning $AXON and paid for its own thinking */
  boughtEth: number; axonEth: number; thinkingPaidEth: number; thoughts: number;
  /** stopped from Axon's side: it does not think and nothing is sent for it */
  stopped: boolean;
}

export type BoardSort = "new" | "mcap" | "burned";
const ORDER: Record<BoardSort, string> = { new: "t.launched_at DESC", mcap: "COALESCE(s.mcap_eth, 0) DESC, t.launched_at DESC", burned: "COALESCE(s.burned_eth, 0) DESC, t.launched_at DESC" };

export function board(sort: BoardSort = "new", limit = 60): BoardToken[] {
  const rows = getDb().prepare(
    `SELECT t.token, t.name, t.symbol, t.logo, t.creator, t.launched_at launchedAt, t.tx_hash txHash, t.agent_id agentId, a.name agentName,
       t.pot, t.splitter, t.vault, t.payout, t.attached, t.tax_bps taxBps, t.creator_bps creatorBps, t.burn_bps burnBps, t.axon_bps axonBps, t.mind_bps mindBps, t.model,
       COALESCE(s.phase, 0) phase, s.price_eth priceEth, s.mcap_eth mcapEth, COALESCE(s.curve_bps, 0) curveBps, COALESCE(s.holders, 0) holders,
       COALESCE(s.fees_eth, 0) feesEth, COALESCE(s.to_mind_eth, 0) toMindEth, COALESCE(s.burned_tokens, 0) burnedTokens, COALESCE(s.burned_eth, 0) burnedEth, COALESCE(s.burns, 0) burns, COALESCE(s.treasury_eth, 0) treasuryEth,
       COALESCE((SELECT SUM(a.eth) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'reward' AND a.status = 'done'), 0) rewardsEth,
       COALESCE((SELECT SUM(a.eth) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'buyback' AND a.status = 'done'), 0) boughtEth,
       COALESCE((SELECT SUM(a.eth) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'burn_axon' AND a.status = 'done'), 0) axonEth,
       COALESCE((SELECT SUM(a.eth) FROM mind_actions a WHERE a.token = t.token AND a.kind = 'thinking' AND a.status = 'done'), 0) thinkingPaidEth,
       (SELECT COUNT(*) FROM mind_thoughts h WHERE h.token = t.token AND h.status = 'thought') thoughts,
       t.stopped_at IS NOT NULL stopped
     FROM mind_tokens t LEFT JOIN mind_stats s ON s.token = t.token LEFT JOIN agents a ON a.agent_id = t.agent_id
     ORDER BY ${ORDER[sort] ?? ORDER.new} LIMIT ?`,
  ).all(Math.min(200, Math.max(1, limit))) as (Omit<BoardToken, "attached" | "stopped"> & { attached: number; stopped: number })[];
  return rows.map((r) => ({ ...r, attached: r.attached === 1, stopped: r.stopped === 1 }));
}

export interface BoardTotals { tokens: number; feesEth: number; burnedEth: number; toMindEth: number; treasuryEth: number }

export function boardTotals(): BoardTotals {
  return getDb().prepare(
    "SELECT COUNT(*) tokens, COALESCE(SUM(s.fees_eth), 0) feesEth, COALESCE(SUM(s.burned_eth), 0) burnedEth, COALESCE(SUM(s.to_mind_eth), 0) toMindEth, COALESCE(SUM(s.treasury_eth), 0) treasuryEth FROM mind_tokens t LEFT JOIN mind_stats s ON s.token = t.token",
  ).get() as BoardTotals;
}

export interface MindEvent { id: number; token: string; kind: MindEventKind; eth: number | null; tokens: number | null; at: string; name: string | null; symbol: string | null; logo: string | null }

/** What happened, newest first. `after` gives only what is newer than an event already seen. */
export function events(limit = 40, after = 0): MindEvent[] {
  return getDb().prepare(
    "SELECT e.id, e.token, e.kind, e.eth, e.tokens, e.at, t.name, t.symbol, t.logo FROM mind_events e JOIN mind_tokens t ON t.token = e.token WHERE e.id > ? ORDER BY e.id DESC LIMIT ?",
  ).all(after, Math.min(100, Math.max(1, limit))) as MindEvent[];
}

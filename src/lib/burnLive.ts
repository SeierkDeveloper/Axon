// What the burn pot is doing right now, read from the pot itself.
//
// getBurnStats in ./burn answers "what has this process sent toward the burn, and what has burned
// in total". This answers the other question, the one a countdown needs: when is the next burn
// allowed, how much would it spend, and is it waiting on the clock or on the market.
//
// Everything here comes off the chain. The pot's own preview() is the authority on the schedule,
// so the page never has to reimplement the interval rules and then disagree with the contract.

import { cachedRead } from "./readCache";
import { publicClient } from "./evm";
import { burnPotAddress } from "./burn";
import { weiToEth } from "./money";
import { logger } from "./logger";
import { EXPLORER } from "./chain";
import { getPendingAtPons } from "./burnPending";
import { getBurnCadence, UNKNOWN_CADENCE, type BurnCadence } from "./burnCadence";

/** Mirrors the constants in BurnPot.sol. Shown so the page can explain the schedule. */
export const BURN_RULES = {
  minIntervalSeconds: 30 * 60,
  burnsPerDay: 48,
  maxWaitSeconds: 24 * 60 * 60,
  minBurnEth: 0.001,
  depthPercent: 1,
  deadAddress: "0x000000000000000000000000000000000000dEaD",
} as const;

const POT_ABI = [
  { type: "function", name: "preview", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }], stateMutability: "view" },
  { type: "function", name: "lastBurnAt", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "burnCount", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalEthBurned", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalTokensBurned", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "token", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { type: "function", name: "startedAt", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

export interface BurnLive {
  /** false before the pot is deployed and configured: the page says so rather than showing zeros. */
  live: boolean;
  /** true when some or all of these figures are the last good reading, because the chain did not answer just now. */
  stale?: boolean;
  /** set once the token has launched through the pot. */
  launched: boolean;
  potAddress: string | null;
  tokenAddress: string | null;
  /** ETH sitting in the pot, waiting. */
  potBalanceEth: number;
  /** what the next burn would spend, which the depth cap can hold below the balance. */
  nextBurnEth: number;
  /** unix seconds. 0 when there is nothing scheduled. */
  nextBurnAt: number;
  lastBurnAt: number;
  /** true when burn() would go through this second. */
  ready: boolean;
  burnCount: number;
  totalEthBurned: number;
  totalTokensBurned: number;
  /** so the page can link every figure to somewhere it can be checked. */
  explorer: { pot: string | null; token: string | null; dead: string };
  rules: typeof BURN_RULES;
  /** when this was read, so a cached response still counts down correctly in the browser. */
  readAt: number;
  /**
   * ETH released by Pons and not yet claimed into the pot, or null when it could not be read.
   *
   * The pot's balance alone cannot tell you whether the burn is quiet or about to fire, because
   * after graduation the pot holds money for seconds. This is the step before it.
   */
  pendingEth: number | null;
  /** Measured, so the page can say what is actually holding the next burn back. */
  cadence: BurnCadence;
}

const empty = (pot: string | null): BurnLive => ({
  live: false,
  launched: false,
  potAddress: pot,
  tokenAddress: null,
  potBalanceEth: 0,
  nextBurnEth: 0,
  nextBurnAt: 0,
  lastBurnAt: 0,
  ready: false,
  burnCount: 0,
  totalEthBurned: 0,
  totalTokensBurned: 0,
  explorer: {
    pot: pot ? `${EXPLORER}/address/${pot}` : null,
    token: null,
    dead: `${EXPLORER}/address/${BURN_RULES.deadAddress}`,
  },
  rules: BURN_RULES,
  readAt: Math.floor(Date.now() / 1000),
  pendingEth: null,
  cadence: UNKNOWN_CADENCE,
});

const ZERO = "0x0000000000000000000000000000000000000000";

/** A read of the pot that reached nothing: carried out of the cache so it is never stored as the answer. */
class PotUnreadable extends Error {
  constructor(readonly result: BurnLive) {
    super("burn pot unreadable");
  }
}

/**
 * Read the pot. Returns `live: false` rather than throwing when there is no pot yet or the node is
 * unreachable, because a burn page that 500s is worse than one that says it cannot reach the chain.
 *
 * Shared for BURN_READ_TTL_MS: one read of the node serves everyone looking in that window, and `readAt`
 * says when it was taken, so the page's countdown stays right. An unreadable pot is never cached: the last
 * good read is answered instead while the node comes back.
 */
export async function getBurnLive(): Promise<BurnLive> {
  const pot = burnPotAddress();
  if (!pot) return empty(null);
  try {
    return await cachedRead(`burn:live:${pot}`, BURN_READ_TTL_MS, async () => {
      const r = await readBurnLive(pot);
      if (!r.live) throw new PotUnreadable(r);
      return r;
    });
  } catch (err) {
    return err instanceof PotUnreadable ? err.result : empty(pot);
  }
}

/** How long one read of the pot is shared. The pot changes at most once per burn, 30 minutes apart. */
export const BURN_READ_TTL_MS = 10_000;

/**
 * The last reading that came back whole. A node that stops answering for a minute must not turn 294 burns into
 * "0 burns" on the page every burn post links to: a failed read falls back to the last good figure instead, and
 * says it is a last reading. Kept for a few hours; past that, saying "cannot reach the chain" is the honest answer.
 */
let lastGood: { at: number; value: BurnLive } | null = null;
const LAST_GOOD_MAX_AGE_MS = 6 * 3_600_000;

async function readBurnLive(pot: string): Promise<BurnLive> {
  try {
    const client = publicClient();
    const address = pot as `0x${string}`;
    type PotFn = (typeof POT_ABI)[number]["name"];
    const read = <T>(functionName: PotFn) =>
      client.readContract({ address, abi: POT_ABI, functionName }) as Promise<T>;

    // Settled rather than all or nothing. These are seven independent reads of one contract, and a
    // single failure used to discard the other six: one hiccup on preview() left the page saying the
    // pot was not live, showing four zeros, while the burns it had already done sat on chain in
    // plain sight. A page that loses its countdown is degraded. A page that says the burn does not
    // exist is wrong, on the page every burn post links to.
    const [preview, lastBurnAt, burnCount, ethBurned, tokensBurned, token, balance] =
      await Promise.allSettled([
        read<readonly [bigint, bigint, boolean]>("preview"),
        read<bigint>("lastBurnAt"),
        read<bigint>("burnCount"),
        read<bigint>("totalEthBurned"),
        read<bigint>("totalTokensBurned"),
        read<string>("token"),
        client.getBalance({ address }),
      ]);

    const settled = [preview, lastBurnAt, burnCount, ethBurned, tokensBurned, token, balance];
    const got = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
      r.status === "fulfilled" ? r.value : fallback;

    // Every read failing means the node is unreachable, and nothing here would be a fact. That case
    // still shows nothing, but it says why rather than making a claim about the pot.
    const prev = lastGood && lastGood.value.potAddress === pot && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS ? lastGood.value : null;
    if (!settled.some((r) => r.status === "fulfilled")) {
      logger.warn("burn.live_unreadable", "Every burn pot read failed", { pot });
      return prev ? { ...prev, stale: true } : empty(pot);
    }

    const [amount, nextAt, ready] = got<readonly [bigint, bigint, boolean]>(preview, [0n, 0n, false]);
    const tokenRaw = got<string>(token, "");
    const tokenAddress = tokenRaw && tokenRaw !== ZERO ? tokenRaw.toLowerCase() : null;
    const burns = Number(got<bigint>(burnCount, 0n));
    const lastBurn = Number(got<bigint>(lastBurnAt, 0n));

    // Both of these describe the burn rather than report it, so neither is allowed to take the page
    // down with it: settled separately, and a failure leaves the page exactly as it was before they
    // existed.
    const [pending, cadence] = await Promise.allSettled([getPendingAtPons(), getBurnCadence(lastBurn, BURN_RULES.minIntervalSeconds)]);

    const result: BurnLive = {
      live: true,
      // Unknown is not the same as no. If the token read is the one that failed, a pot that has
      // already burned is plainly launched, and the counter can say so by itself.
      launched: tokenAddress !== null || burns > 0,
      potAddress: pot,
      tokenAddress,
      potBalanceEth: weiToEth(got<bigint>(balance, 0n)),
      nextBurnEth: weiToEth(amount),
      nextBurnAt: Number(nextAt),
      lastBurnAt: lastBurn,
      ready,
      burnCount: burns,
      totalEthBurned: weiToEth(got<bigint>(ethBurned, 0n)),
      totalTokensBurned: weiToEth(got<bigint>(tokensBurned, 0n)),
      explorer: {
        pot: `${EXPLORER}/address/${pot}`,
        token: tokenAddress ? `${EXPLORER}/address/${tokenAddress}` : null,
        dead: `${EXPLORER}/address/${BURN_RULES.deadAddress}`,
      },
      rules: BURN_RULES,
      readAt: Math.floor(Date.now() / 1000),
      pendingEth: pending.status === "fulfilled" ? pending.value : null,
      cadence: cadence.status === "fulfilled" ? cadence.value : UNKNOWN_CADENCE,
    };

    // A read that failed keeps the last good figure rather than falling to zero: the totals only ever grow, and
    // a balance or schedule a minute old is closer to the truth than none.
    const failed = (r: PromiseSettledResult<unknown>) => r.status === "rejected";
    if (prev) {
      if (failed(burnCount)) result.burnCount = prev.burnCount;
      if (failed(lastBurnAt)) result.lastBurnAt = prev.lastBurnAt;
      if (failed(ethBurned)) result.totalEthBurned = prev.totalEthBurned;
      if (failed(tokensBurned)) result.totalTokensBurned = prev.totalTokensBurned;
      if (failed(balance)) result.potBalanceEth = prev.potBalanceEth;
      if (failed(token)) result.tokenAddress = prev.tokenAddress;
      if (failed(preview)) {
        result.nextBurnEth = prev.nextBurnEth;
        result.nextBurnAt = prev.nextBurnAt;
        result.ready = prev.ready;
      }
      result.launched = result.launched || prev.launched;
    }
    if (settled.some(failed)) result.stale = Boolean(prev);
    // only a reading where the running totals all came back is good enough to fall back on later
    if (!failed(burnCount) && !failed(ethBurned) && !failed(tokensBurned)) lastGood = { at: Date.now(), value: { ...result, stale: false } };
    return result;
  } catch (err) {
    logger.warn("burn.live_unreadable", "Could not read the burn pot", { err, pot });
    const prev = lastGood && lastGood.value.potAddress === pot && Date.now() - lastGood.at < LAST_GOOD_MAX_AGE_MS ? lastGood.value : null;
    return prev ? { ...prev, stale: true } : empty(pot);
  }
}

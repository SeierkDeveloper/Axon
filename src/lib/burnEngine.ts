// The thing that actually drives the burn.
//
// The contracts are permissionless but inert: Pons leaves the creator tax sitting on the bonding
// curve until somebody sweeps it, and `burn()` only happens when somebody calls it. A pot with no
// caller is a countdown that ticks and never fires, which is worse than having no countdown.
//
// So this is the caller. It holds a key of its own, funded with gas and nothing else, and the two
// things it can do are both things the contracts already constrain:
//
//   sweep()  moves the tax off the curve, pulls the escrow balance, and splits it. Anyone may call
//            it, and it cannot send anywhere the Splitter was not already going to send.
//   burn()   spends what the pot holds on the token and sends it to the dead address. Anyone may
//            call it, the pot enforces the interval and the depth cap, and there is no withdraw.
//
// Worst case if this key leaks is somebody else pays the gas to do what the contracts do anyway.
//
// Everything here is best-effort by design. The pot reverts for ordinary reasons all day long
// (TooSoon between burns, TooSmall below the floor, MarketNotReady before the pool is live) and a
// revert is the schedule working, not a failure to report.

import { parseAbi } from "viem";
import { publicClient, walletClientFor } from "./evm";
import { burnPotAddress, splitterAddress } from "./burn";
import { weiToEth } from "./money";
import { logger } from "./logger";

const POT_ABI = parseAbi([
  "function preview() view returns (uint256 amount, uint256 nextAt, bool ready)",
  "function burn(uint256 minTokensOut) returns (uint256 ethIn, uint256 tokensOut)",
  "function token() view returns (address)",
]);
const SPLITTER_ABI = parseAbi(["function sweep() returns (uint256)"]);

/**
 * The floor the bot passes to `burn()`.
 *
 * Zero, deliberately, and the contract says so itself: "0 is fine for the bot, callers who care
 * pass a quote." The protection that matters is the pot's own depth cap, which holds every burn to
 * 1% of the market's ETH depth and is what makes a sandwich unprofitable. A price floor computed
 * off-chain here would add a second opinion about the market that can disagree with the pool and
 * block burns for no gain.
 */
const MIN_TOKENS_OUT = 0n;

/**
 * The least a sweep must move before the bot pays gas for it. sweep() stopped reverting when there is nothing to move:
 * it succeeds and moves nothing, so sending it on a clock spent gas every minute for nothing (measured 2026-10-03:
 * about 1,700 empty sweeps a day, 0.0033 ETH). The splitter is now asked first, for free, what a sweep would move.
 * 0.00005 ETH is about 25 times one sweep's gas, and far under the pot's 0.001 ETH burn floor, so no burn waits on it.
 */
const MIN_SWEEP_WEI = BigInt(Math.round(Number(process.env.AXON_MIN_SWEEP_ETH ?? 0.00005) * 1e18));

/**
 * Sweep only when it is worth the gas: a free simulation says what sweep() would move, and the transaction is sent only
 * when that is at least MIN_SWEEP_WEI. Returns the hash when it sent one, null when there was nothing worth moving.
 */
export async function sweepIfWorthIt(
  reader: ReturnType<typeof publicClient>,
  wallet: ReturnType<typeof walletClientFor>,
  splitter: `0x${string}`,
): Promise<{ hash: string; amount: bigint } | null> {
  const { result: amount } = await reader.simulateContract({ address: splitter, abi: SPLITTER_ABI, functionName: "sweep", account: wallet.account });
  if (amount < MIN_SWEEP_WEI) return null;
  const hash = await wallet.client.writeContract({ address: splitter, abi: SPLITTER_ABI, functionName: "sweep", account: wallet.account, chain: null });
  await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return { hash, amount };
}

export interface EngineResult {
  ok: boolean;
  /** false when there is no pot or no key yet: not an error, just nothing to drive. */
  configured: boolean;
  swept: { ran: boolean; hash?: string; error?: string };
  burned: { ran: boolean; hash?: string; ethIn?: number; error?: string };
  /** what the pot says about the next burn, read after the work. */
  next: { amountEth: number; atUnix: number; ready: boolean } | null;
}

const idle = (configured: boolean): EngineResult => ({
  ok: true,
  configured,
  swept: { ran: false },
  burned: { ran: false },
  next: null,
});

/** Short, storable reason. Chain errors arrive as paragraphs. */
function why(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const named = text.match(/\b(TooSoon|TooSmall|MarketNotReady|NothingToBurn|TokenNotSet|SplitterMismatch)\b/);
  if (named) return named[1];
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * One pass: sweep what is owed, then burn if a burn is due.
 *
 * Runs more often than the 30 minute interval so a burn fires soon after it becomes allowed rather
 * than up to a full interval late.
 */
export async function runBurnEngine(): Promise<EngineResult> {
  const pot = burnPotAddress();
  const splitter = splitterAddress();
  const key = process.env.BOT_PRIVATE_KEY?.trim();
  if (!pot || !key) return idle(false);

  const reader = publicClient();
  const wallet = walletClientFor(key);
  const { account, client } = wallet;
  const result = idle(true);

  // ── sweep ────────────────────────────────────────────────────────────────
  // Fees sit on the curve until this runs, and only a sweep worth its gas is sent; a failure here
  // never stops the burn below.
  if (splitter) {
    try {
      const sent = await sweepIfWorthIt(reader, wallet, splitter as `0x${string}`);
      result.swept = sent ? { ran: true, hash: sent.hash } : { ran: false, error: "nothing worth sweeping" };
    } catch (err) {
      result.swept = { ran: false, error: why(err) };
    }
  }

  // ── burn ─────────────────────────────────────────────────────────────────
  // The pot is asked first rather than guessed at: preview() is the same code burn() runs, so if
  // it says not ready there is no point spending gas to be told so by a revert.
  try {
    const [amount, nextAt, ready] = (await reader.readContract({
      address: pot as `0x${string}`,
      abi: POT_ABI,
      functionName: "preview",
    })) as readonly [bigint, bigint, boolean];

    result.next = { amountEth: weiToEth(amount), atUnix: Number(nextAt), ready };

    if (ready && amount > 0n) {
      const hash = await client.writeContract({
        address: pot as `0x${string}`,
        abi: POT_ABI,
        functionName: "burn",
        args: [MIN_TOKENS_OUT],
        account,
        chain: null,
      });
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (receipt.status !== "success") throw new Error(`burn ${hash} reverted`);
      result.burned = { ran: true, hash, ethIn: weiToEth(amount) };
      logger.info("burn.fired", "Burned from the pot", { hash, ethIn: weiToEth(amount) });
    }
  } catch (err) {
    // A burn that was not due is the schedule doing its job, so it is recorded and not raised.
    result.burned = { ran: false, error: why(err) };
  }

  return result;
}

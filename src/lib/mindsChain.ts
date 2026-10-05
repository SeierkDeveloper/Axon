// Agent Minds, read from the chain. Everything Axon shows about a token launched with a mind starts here: the
// launcher's own events say which tokens exist, and each token's contracts say what its settings are, what its
// treasury holds and what its fees have paid out. Nothing here signs or sends anything.
//
// The reads go through one object (`mindsChain`) so the indexer and the pages can be tested against a chain that is
// written down in the test rather than fetched.

import { decodeEventLog, encodeAbiParameters, encodePacked, formatEther, keccak256, parseAbi, type Hex } from "viem";
import { blockNumber, getLogs, publicClient } from "./evm";
import { normalizeAddress } from "./address";
import { LAUNCHPAD_FACTORY } from "./launchIndex";

/** The MindLauncher, once it is deployed. Unset means Agent Minds has nothing to read and nothing to launch through. */
export function mindLauncherAddress(env: Record<string, string | undefined> = process.env): `0x${string}` | null {
  const a = normalizeAddress(env.NEXT_PUBLIC_MIND_LAUNCHER?.trim() ?? "");
  return a ? (a as `0x${string}`) : null;
}

/** The block the launcher was deployed in: where reading its events starts. */
export function mindDeployBlock(env: Record<string, string | undefined> = process.env): bigint | null {
  const n = Number(env.MIND_DEPLOY_BLOCK);
  return Number.isSafeInteger(n) && n > 0 ? BigInt(n) : null;
}

export const LAUNCHER_ABI = parseAbi([
  "event Launched(address indexed token, address indexed creator, bytes32 indexed agentRef, address pot, address splitter, address vault, address payout, uint16 taxBps, uint16 creatorBps, uint16 burnBps, uint16 axonBps, uint16 mindBps)",
  "event MindAttached(address indexed token, address indexed creator, address pot, address vault)",
  "function vaultOf(address token) view returns (address)",
  "function tokenCount() view returns (uint256)",
  "function signer() view returns (address)",
  "function guardian() view returns (address)",
  "function costSink() view returns (address)",
  "function mindsPaused() view returns (bool)",
  "function launchesPaused() view returns (bool)",
]);

export const VAULT_ABI = parseAbi([
  "function limits() view returns (uint8 allowed, uint96 maxPerDay, uint96 maxPerAction, uint16 maxActionsPerDay, uint96 maxCostPerDay)",
  "function available() view returns (uint256)",
  "function reserved() view returns (uint256)",
  "function paused() view returns (bool)",
  "function frozen() view returns (bool)",
  "function active() view returns (bool)",
  "function totalBuyback() view returns (uint256)",
  "function totalAxon() view returns (uint256)",
  "function totalRewarded() view returns (uint256)",
  "function totalClaimed() view returns (uint256)",
  "function totalThinking() view returns (uint256)",
  "function rewardCount() view returns (uint256)",
]);

/** What the signer may call, and nothing else: the treasury's four actions, a splitter's sweep, a pot's burn. */
export const VAULT_WRITE_ABI = parseAbi([
  "function buyback(uint256 amount)",
  "function burnAxon(uint256 amount)",
  "function startReward(bytes32 root, uint256 total) returns (uint256 id)",
  "function payThinking(uint256 amount)",
  "function claim(uint256 id, uint256 index, address account, uint256 amount, bytes32[] proof)",
  "function isClaimed(uint256 id, uint256 index) view returns (bool)",
  "function today() view returns (uint256)",
  "function spentOn(uint256 day) view returns (uint256)",
  "function actionsOn(uint256 day) view returns (uint256)",
  "function costOn(uint256 day) view returns (uint256)",
  "event RewardStarted(uint256 indexed id, bytes32 root, uint256 total, uint256 startAt, uint256 endAt)",
]);
export const KEEPER_ABI = parseAbi([
  "function sweep() returns (uint256 amount)",
  "function burn(uint256 minTokensOut) returns (uint256 ethIn, uint256 tokensOut)",
  "function preview() view returns (uint256 amount, uint256 nextAt, bool ready)",
]);

/** A token launched before minds, as the chain describes it to somebody who wants to give it one. */
export interface EarlierToken {
  token: string;
  /** the contract that launched it on Pons: its burn pot, when it has one */
  pot: string | null;
  /** the wallet that pot belongs to: the only one that can give the token a mind */
  dev: string | null;
  name: string | null;
  symbol: string | null;
  /** its mind's treasury, when it already has a mind */
  vault: string | null;
}

const EARLIER_ABI = parseAbi([
  "function dev() view returns (address)",
  "function token() view returns (address)",
  "function potOf(address dev) view returns (address)",
]);

/** What a treasury has done so far today, by its own count. */
export interface VaultDay { spentTodayEth: number; actionsToday: number; costTodayEth: number }

export const SPLITTER_ABI = parseAbi([
  "function totalSplit() view returns (uint256)",
  "function totalToCreator() view returns (uint256)",
  "function totalToBurn() view returns (uint256)",
  "function totalToAxon() view returns (uint256)",
  "function totalToMind() view returns (uint256)",
  "function creatorPending() view returns (uint256)",
]);

const POT_ABI = parseAbi([
  "function totalEthBurned() view returns (uint256)",
  "function totalTokensBurned() view returns (uint256)",
  "function burnCount() view returns (uint256)",
]);

const TOKEN_ABI = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)"]);

/** A launch, as the launcher's event states it. */
export interface MindLaunchEvent {
  kind: "launched" | "attached";
  token: string;
  creator: string;
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
  blockNumber: number;
  txHash: string;
}

/** What a mind's treasury holds and has done, in ETH. */
export interface Treasury {
  availableEth: number;
  reservedEth: number;
  boughtBackEth: number;
  axonBurnedEth: number;
  rewardedEth: number;
  claimedEth: number;
  thinkingEth: number;
  rewards: number;
  paused: boolean;
  frozen: boolean;
  active: boolean;
  limits: { allowed: number; maxPerDayEth: number; maxPerActionEth: number; maxActionsPerDay: number; maxCostPerDayEth: number };
}

/** What a token's fees have paid out so far, in ETH, and what its pot has burned. */
export interface FeeFlow {
  totalEth: number;
  toCreatorEth: number;
  toBurnEth: number;
  toAxonEth: number;
  toMindEth: number;
  pendingCreatorEth: number;
  burnedEth: number;
  burnedTokens: number;
  burns: number;
}

/** A token as the board shows it: where it trades, what it is worth, and what its contracts have done. */
export interface Snapshot {
  /** 0 on its curve, 1 swept, 2 trading in its pool, 3 rescued */
  phase: number;
  curve: string;
  /** ETH for one whole token, or null while there is nowhere to read a price (between curve and pool) */
  priceEth: number | null;
  supply: number;
  /** how far along its curve, in hundredths of a percent */
  curveBps: number;
  feesEth: number;
  toMindEth: number;
  burnedTokens: number;
  burnedEth: number;
  burns: number;
  treasuryEth: number;
  /** where its liquidity sits once it has graduated: a holder of the token that is nobody's wallet */
  poolManager: string | null;
}

export interface TransferEvent { token: string; from: string; to: string; value: bigint; blockNumber: number }

const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** v4-core StateLibrary: the pools mapping lives at slot 6, and sqrtPriceX96 is the first word. */
const POOLS_SLOT = 6n;
const Q192 = 2n ** 192n;

const FACTORY_ABI = parseAbi([
  "function getLaunchedToken(address) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))",
  "function poolManager() view returns (address)",
  "function memeHook() view returns (address)",
]);
const CURVE_ABI = parseAbi(["function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)"]);
const SUPPLY_ABI = parseAbi(["function totalSupply() view returns (uint256)"]);
const EXTSLOAD_ABI = parseAbi(["function extsload(bytes32) view returns (bytes32)"]);

/**
 * How far along its curve a token is, in hundredths of a percent. A fresh curve opens with a phantom reserve of two
 * fifths of the graduation threshold on its quote side (1.68 ETH against 4.2), and is ready to graduate when the ETH
 * really paid in reaches the threshold: measured on a copy of the chain, buy by buy.
 */
export function curveProgressBps(quoteReserve: bigint, threshold: bigint): number {
  if (threshold <= 0n) return 0;
  const paidIn = quoteReserve - (threshold * 2n) / 5n;
  if (paidIn <= 0n) return 0;
  const bps = (paidIn * 10_000n) / threshold;
  return bps > 10_000n ? 10_000 : Number(bps);
}

// the pool manager and the hook never change for a factory; read once
let venue: { poolManager: `0x${string}`; hook: `0x${string}` } | null = null;

const eth = (wei: bigint) => Number(formatEther(wei));
const lower = (a: string) => a.toLowerCase();

interface RawLog { topics: Hex[]; data: Hex; blockNumber: Hex; transactionHash: Hex }

export const mindsChain = {
  head: (): Promise<bigint> => blockNumber(),

  /** Every launch and every mind given later, in a range of blocks, oldest first. */
  async launches(launcher: string, from: bigint, to: bigint): Promise<MindLaunchEvent[]> {
    const logs = (await getLogs(from, to, { address: launcher })) as RawLog[];
    const out: MindLaunchEvent[] = [];
    for (const log of logs) {
      let ev;
      try { ev = decodeEventLog({ abi: LAUNCHER_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]] }); } catch { continue; }
      const at = { blockNumber: Number(BigInt(log.blockNumber)), txHash: lower(log.transactionHash) };
      if (ev.eventName === "Launched") {
        const a = ev.args;
        out.push({ kind: "launched", token: lower(a.token), creator: lower(a.creator), agentRef: lower(a.agentRef), pot: lower(a.pot), splitter: lower(a.splitter), vault: lower(a.vault), payout: lower(a.payout), taxBps: a.taxBps, creatorBps: a.creatorBps, burnBps: a.burnBps, axonBps: a.axonBps, mindBps: a.mindBps, ...at });
      } else if (ev.eventName === "MindAttached") {
        const a = ev.args;
        out.push({ kind: "attached", token: lower(a.token), creator: lower(a.creator), agentRef: `0x${"0".repeat(64)}`, pot: lower(a.pot), splitter: null, vault: lower(a.vault), payout: null, taxBps: null, creatorBps: null, burnBps: null, axonBps: null, mindBps: null, ...at });
      }
    }
    return out.sort((x, y) => x.blockNumber - y.blockNumber);
  },

  /** When a block was made, as an ISO time. */
  async blockTime(n: number): Promise<string> {
    const b = await publicClient().getBlock({ blockNumber: BigInt(n) });
    return new Date(Number(b.timestamp) * 1000).toISOString();
  },

  /** The token's own name and ticker. */
  async tokenMeta(token: string): Promise<{ name: string; symbol: string }> {
    const c = publicClient();
    const address = token as `0x${string}`;
    const [name, symbol] = await Promise.all([
      c.readContract({ address, abi: TOKEN_ABI, functionName: "name" }),
      c.readContract({ address, abi: TOKEN_ABI, functionName: "symbol" }),
    ]);
    return { name, symbol };
  },

  async treasury(vault: string): Promise<Treasury> {
    const c = publicClient();
    const address = vault as `0x${string}`;
    const read = <F extends "available" | "reserved" | "totalBuyback" | "totalAxon" | "totalRewarded" | "totalClaimed" | "totalThinking" | "rewardCount">(functionName: F) =>
      c.readContract({ address, abi: VAULT_ABI, functionName }) as Promise<bigint>;
    const flag = (functionName: "paused" | "frozen" | "active") => c.readContract({ address, abi: VAULT_ABI, functionName }) as Promise<boolean>;
    const [limits, available, reserved, buyback, axon, rewarded, claimed, thinking, rewards, paused, frozen, active] = await Promise.all([
      c.readContract({ address, abi: VAULT_ABI, functionName: "limits" }),
      read("available"), read("reserved"), read("totalBuyback"), read("totalAxon"), read("totalRewarded"), read("totalClaimed"), read("totalThinking"), read("rewardCount"),
      flag("paused"), flag("frozen"), flag("active"),
    ]);
    return {
      availableEth: eth(available), reservedEth: eth(reserved), boughtBackEth: eth(buyback), axonBurnedEth: eth(axon), rewardedEth: eth(rewarded),
      claimedEth: eth(claimed), thinkingEth: eth(thinking), rewards: Number(rewards), paused, frozen, active,
      limits: { allowed: limits[0], maxPerDayEth: eth(limits[1]), maxPerActionEth: eth(limits[2]), maxActionsPerDay: limits[3], maxCostPerDayEth: eth(limits[4]) },
    };
  },

  /** Everything the board shows for one token, in two round trips to the chain however much it reads. */
  async snapshot(t: { token: string; pot: string; splitter: string | null; vault: string }): Promise<Snapshot> {
    const c = publicClient();
    const token = t.token as `0x${string}`, pot = t.pot as `0x${string}`, vault = t.vault as `0x${string}`;
    const splitter = (t.splitter ?? ZERO) as `0x${string}`;
    const r = await c.multicall({
      multicallAddress: MULTICALL,
      allowFailure: true,
      contracts: [
        { address: LAUNCHPAD_FACTORY as `0x${string}`, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [token] },
        { address: token, abi: SUPPLY_ABI, functionName: "totalSupply" },
        { address: pot, abi: POT_ABI, functionName: "totalEthBurned" },
        { address: pot, abi: POT_ABI, functionName: "totalTokensBurned" },
        { address: pot, abi: POT_ABI, functionName: "burnCount" },
        { address: vault, abi: VAULT_ABI, functionName: "available" },
        { address: vault, abi: VAULT_ABI, functionName: "reserved" },
        { address: splitter, abi: SPLITTER_ABI, functionName: "totalSplit" },
        { address: splitter, abi: SPLITTER_ABI, functionName: "totalToMind" },
      ],
    });
    const info = r[0].status === "success" ? r[0].result : null;
    // a token's own record is the one read nothing else can stand in for
    if (!info || !info.exists) throw new Error(`the launch factory has no record of ${t.token}`);
    const n = (i: number) => (r[i].status === "success" ? (r[i].result as bigint) : 0n);

    let priceEth: number | null = null;
    let curveBps = info.phase === 0 ? 0 : 10_000;
    if (info.phase === 0) {
      const [quote, tokens] = await c.readContract({ address: info.curve, abi: CURVE_ABI, functionName: "getReserves" });
      // the spot price a trade faces: the quote side over the token side, both in eighteen decimals
      if (tokens > 0n) priceEth = Number((quote * 10n ** 18n) / tokens) / 1e18;
      curveBps = curveProgressBps(quote, info.graduationThreshold);
    } else if (info.phase === 2) {
      if (!venue) {
        const [poolManager, hook] = await Promise.all([
          c.readContract({ address: LAUNCHPAD_FACTORY as `0x${string}`, abi: FACTORY_ABI, functionName: "poolManager" }),
          c.readContract({ address: LAUNCHPAD_FACTORY as `0x${string}`, abi: FACTORY_ABI, functionName: "memeHook" }),
        ]);
        venue = { poolManager, hook };
      }
      // ETH is currency0 because its address is zero, so the pool's price is tokens for one ETH
      const poolId = keccak256(encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
        [ZERO, token, info.poolFee, info.tickSpacing, venue.hook],
      ));
      const slot = keccak256(encodePacked(["bytes32", "uint256"], [poolId, POOLS_SLOT]));
      const raw = await c.readContract({ address: venue.poolManager, abi: EXTSLOAD_ABI, functionName: "extsload", args: [slot] });
      const sqrtP = BigInt(raw) & ((1n << 160n) - 1n);
      if (sqrtP > 0n) {
        const tokensPerEth = (10n ** 18n * sqrtP * sqrtP) / Q192;
        if (tokensPerEth > 0n) priceEth = Number((10n ** 36n) / tokensPerEth) / 1e18;
      }
    }
    return {
      phase: info.phase, curve: lower(info.curve), priceEth, supply: eth(n(1)), curveBps,
      burnedEth: eth(n(2)), burnedTokens: eth(n(3)), burns: Number(n(4)), treasuryEth: eth(n(5) + n(6)), feesEth: eth(n(7)), toMindEth: eth(n(8)),
      poolManager: venue ? lower(venue.poolManager) : null,
    };
  },

  /** Every transfer of these tokens in a range of blocks, oldest first. */
  async transfers(tokens: string[], from: bigint, to: bigint): Promise<TransferEvent[]> {
    if (!tokens.length || from > to) return [];
    const logs = (await getLogs(from, to, { address: tokens, topics: [TRANSFER_TOPIC] })) as (RawLog & { address: string; logIndex: Hex })[];
    return logs
      .filter((l) => l.topics.length === 3)
      .map((l) => ({ token: lower(l.address), from: `0x${l.topics[1].slice(-40)}`, to: `0x${l.topics[2].slice(-40)}`, value: BigInt(l.data === "0x" ? "0x0" : l.data), blockNumber: Number(BigInt(l.blockNumber)), i: Number(BigInt(l.logIndex ?? "0x0")) }))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.i - b.i)
      .map(({ i: _i, ...t }) => t);
  },

  /** A token launched before minds: who launched it, through what, and whether it has a mind already. */
  async earlierToken(token: string, launcher: string): Promise<EarlierToken> {
    const c = publicClient();
    const address = token as `0x${string}`;
    const info = await c.readContract({ address: LAUNCHPAD_FACTORY as `0x${string}`, abi: FACTORY_ABI, functionName: "getLaunchedToken", args: [address] }).catch(() => null);
    if (!info?.exists) return { token: lower(token), pot: null, dev: null, name: null, symbol: null, vault: null };
    // the launching contract is a burn pot only if it says who it belongs to; an ordinary wallet or contract does not
    const [dev, meta, vault] = await Promise.all([
      c.readContract({ address: info.deployer, abi: EARLIER_ABI, functionName: "dev" }).catch(() => null),
      this.tokenMeta(token).catch(() => null),
      c.readContract({ address: launcher as `0x${string}`, abi: LAUNCHER_ABI, functionName: "vaultOf", args: [address] }).catch(() => null),
    ]);
    return { token: lower(token), pot: dev ? lower(info.deployer) : null, dev: dev ? lower(dev) : null, name: meta?.name ?? null, symbol: meta?.symbol ?? null, vault: vault && !/^0x0+$/.test(vault) ? lower(vault) : null };
  },

  /** The token a wallet launched through the earlier agent-token factory, if any. */
  async earlierTokenOf(wallet: string, factory: string): Promise<string | null> {
    const c = publicClient();
    const pot = await c.readContract({ address: factory as `0x${string}`, abi: EARLIER_ABI, functionName: "potOf", args: [wallet as `0x${string}`] }).catch(() => null);
    if (!pot || /^0x0+$/.test(pot)) return null;
    const token = await c.readContract({ address: pot, abi: EARLIER_ABI, functionName: "token" }).catch(() => null);
    return token && !/^0x0+$/.test(token) ? lower(token) : null;
  },

  /** The treasury's own count of today: what its actions spent, how many there were, what its thinking was paid. */
  async vaultDay(vault: string): Promise<VaultDay> {
    const c = publicClient();
    const address = vault as `0x${string}`;
    const day = await c.readContract({ address, abi: VAULT_WRITE_ABI, functionName: "today" });
    const [spent, actions, cost] = await Promise.all([
      c.readContract({ address, abi: VAULT_WRITE_ABI, functionName: "spentOn", args: [day] }),
      c.readContract({ address, abi: VAULT_WRITE_ABI, functionName: "actionsOn", args: [day] }),
      c.readContract({ address, abi: VAULT_WRITE_ABI, functionName: "costOn", args: [day] }),
    ]);
    return { spentTodayEth: eth(spent), actionsToday: Number(actions), costTodayEth: eth(cost) };
  },

  async feeFlow(splitter: string | null, pot: string): Promise<FeeFlow> {
    const c = publicClient();
    const potAddr = pot as `0x${string}`;
    const [burnedEth, burnedTokens, burns] = await Promise.all([
      c.readContract({ address: potAddr, abi: POT_ABI, functionName: "totalEthBurned" }),
      c.readContract({ address: potAddr, abi: POT_ABI, functionName: "totalTokensBurned" }),
      c.readContract({ address: potAddr, abi: POT_ABI, functionName: "burnCount" }),
    ]);
    const burned = { burnedEth: eth(burnedEth), burnedTokens: eth(burnedTokens), burns: Number(burns) };
    // a token launched before Agent Minds has its own earlier splitter, which this does not read
    if (!splitter) return { totalEth: 0, toCreatorEth: 0, toBurnEth: 0, toAxonEth: 0, toMindEth: 0, pendingCreatorEth: 0, ...burned };
    const address = splitter as `0x${string}`;
    const read = (functionName: "totalSplit" | "totalToCreator" | "totalToBurn" | "totalToAxon" | "totalToMind" | "creatorPending") =>
      c.readContract({ address, abi: SPLITTER_ABI, functionName });
    const [total, toCreator, toBurn, toAxon, toMind, pending] = await Promise.all([read("totalSplit"), read("totalToCreator"), read("totalToBurn"), read("totalToAxon"), read("totalToMind"), read("creatorPending")]);
    return { totalEth: eth(total), toCreatorEth: eth(toCreator), toBurnEth: eth(toBurn), toAxonEth: eth(toAxon), toMindEth: eth(toMind), pendingCreatorEth: eth(pending), ...burned };
  },
};

export type MindsChain = typeof mindsChain;

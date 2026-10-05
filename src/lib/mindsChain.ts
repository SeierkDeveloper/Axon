// Agent Minds, read from the chain. Everything Axon shows about a token launched with a mind starts here: the
// launcher's own events say which tokens exist, and each token's contracts say what its settings are, what its
// treasury holds and what its fees have paid out. Nothing here signs or sends anything.
//
// The reads go through one object (`mindsChain`) so the indexer and the pages can be tested against a chain that is
// written down in the test rather than fetched.

import { decodeEventLog, formatEther, parseAbi, type Hex } from "viem";
import { blockNumber, getLogs, publicClient } from "./evm";
import { normalizeAddress } from "./address";

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
  "function MAX_OPENING_BUY() view returns (uint256)",
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

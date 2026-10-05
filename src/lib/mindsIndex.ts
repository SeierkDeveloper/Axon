// Agent Minds: reading the launcher's events into the database.
//
// The launcher says which tokens exist. Each pass reads its events from where the last one stopped up to the chain's
// head, writes every launch as the chain states it, and gives the token its agent: the prepared launch whose reference
// the transaction carried, if the wallet that prepared it is the wallet that launched. A reference nobody prepared, or
// one prepared by someone else, still makes a token row; it just has no agent.
//
// Dormant unless Agent Minds is on and the launcher's address and deploy block are set.

import { getDb } from "./db";
import { agentMindsEnabled } from "./mindsPolicy";
import { mindsChain, mindLauncherAddress, mindDeployBlock, type MindsChain, type MindLaunchEvent, type Treasury, type FeeFlow } from "./mindsChain";
import { cursor, setCursor, upsertToken, getToken, getPrepared, markLaunched, linkAgent, type MindToken } from "./mindsStore";
import { agentFor } from "./mindsAgent";
import { DEFAULT_MIND_MODEL } from "./mindsModels";
import { addEvent, earnedSince } from "./mindsStats";
import { sameAddress } from "./address";
import { logger } from "./logger";

/** Blocks read in one pass at most. The chain makes about eleven a second, so this is over a day of catching up. */
const MAX_BLOCKS_PER_PASS = 1_000_000n;

/** Write one launch. Returns true when it was new. */
async function record(ev: MindLaunchEvent, chain: MindsChain): Promise<boolean> {
  if (getToken(ev.token)) return false;
  const [launchedAt, meta] = await Promise.all([
    chain.blockTime(ev.blockNumber),
    chain.tokenMeta(ev.token).catch(() => null),
  ]);
  const prepared = ev.kind === "launched" ? getPrepared(ev.agentRef) : null;
  // the reference is public the moment it is sent; only the wallet that prepared it may use it
  const mine = prepared && sameAddress(prepared.wallet, ev.creator) ? prepared : null;

  const db = getDb();
  db.transaction(() => {
    const row: MindToken = {
      token: ev.token, creator: ev.creator, agentId: null, agentRef: ev.agentRef, pot: ev.pot, splitter: ev.splitter, vault: ev.vault, payout: ev.payout,
      taxBps: ev.taxBps, creatorBps: ev.creatorBps, burnBps: ev.burnBps, axonBps: ev.axonBps, mindBps: ev.mindBps, attached: ev.kind === "attached",
      name: meta?.name ?? mine?.name ?? null, symbol: meta?.symbol ?? mine?.symbol ?? null, logo: mine?.logo ?? null, description: mine?.description ?? mine?.line ?? null, model: mine?.model ?? DEFAULT_MIND_MODEL,
      blockNumber: ev.blockNumber, txHash: ev.txHash, launchedAt,
    };
    upsertToken(row);
    if (ev.kind === "launched") addEvent(ev.token, "launch", { at: launchedAt });
    if (mine && mine.status === "prepared") {
      const agentId = agentFor(mine);
      if (agentId) linkAgent(ev.token, agentId);
      markLaunched(mine.ref, ev.token);
    }
  })();
  logger.info("minds.token", "A token with a mind was read from the chain", { token: ev.token, creator: ev.creator, kind: ev.kind, agent: getToken(ev.token)?.agentId ?? null });
  return true;
}

export interface IndexPass { from: number; to: number; events: number; added: number }

/**
 * Read the launcher's events up to the chain's head. Returns what the pass covered, or null when there is nothing to
 * read from (switched off, or no launcher yet). The cursor moves only after everything before it is written.
 */
export async function indexMinds(chain: MindsChain = mindsChain, env: Record<string, string | undefined> = process.env): Promise<IndexPass | null> {
  if (!agentMindsEnabled(env)) return null;
  const launcher = mindLauncherAddress(env);
  const start = mindDeployBlock(env);
  if (!launcher || start === null) return null;

  const head = await chain.head();
  const at = cursor();
  const from = at === null ? start : BigInt(at) + 1n;
  if (from > head) return { from: Number(from), to: Number(head), events: 0, added: 0 };
  const to = head - from >= MAX_BLOCKS_PER_PASS ? from + MAX_BLOCKS_PER_PASS - 1n : head;

  const events = await chain.launches(launcher, from, to);
  let added = 0;
  for (const ev of events) if (await record(ev, chain)) added++;
  setCursor(Number(to));
  return { from: Number(from), to: Number(to), events: events.length, added };
}

// ── What a token's page reads ─────────────────────────────────────────────────

export { earnedSince };

export interface MindTokenLive extends MindToken {
  agent: { agentId: string; name: string; earnedEth: number } | null;
  treasury: Treasury | null;
  fees: FeeFlow | null;
}

/** A token with what the chain says about it right now. The chain's numbers are null when it could not be read. */
export async function liveToken(token: string, chain: MindsChain = mindsChain): Promise<MindTokenLive | null> {
  const t = getToken(token);
  if (!t) return null;
  const [treasury, fees] = await Promise.all([
    chain.treasury(t.vault).catch((err) => { logger.warn("minds.treasury_failed", "Could not read a mind's treasury", { err, token }); return null; }),
    chain.feeFlow(t.splitter, t.pot).catch((err) => { logger.warn("minds.fees_failed", "Could not read a token's fees", { err, token }); return null; }),
  ]);
  const name = t.agentId ? (getDb().prepare("SELECT name FROM agents WHERE agent_id = ?").get(t.agentId) as { name: string } | undefined)?.name : undefined;
  return { ...t, agent: t.agentId && name ? { agentId: t.agentId, name, earnedEth: earnedSince(t.agentId, t.launchedAt) } : null, treasury, fees };
}

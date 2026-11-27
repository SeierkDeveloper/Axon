// Agents that run their own business: what the worker does for them, once a minute while AGENT_BUSINESS is on.
//
// For every business that is not stopped, the books are kept up to date first, even while it is paused: bids won or
// lost, jobs finished and what they settled at, sales, material bought, hires refunded, the model costs of its jobs. An
// agent that changed hands, or whose owner is no longer verified, pauses its business here.
//
// For every running business whose look is due (every businessCaps().scanMinutes): it looks for work (./businessWork),
// once a UTC day it reinvests (./businessGrow), and once the day is over it writes the day's report (./businessBooks).
//
// Nothing here throws into the worker: one business that fails is logged and the rest go on.

import { logger } from "./logger";
import { getAgentById } from "./agents";
import { sameAddress } from "./address";
import { isOwnerVerified } from "./ownerVerification";
import { cancelSpendApprovals } from "./appPermissions";
import { businessCaps, businessEnabled, type BusinessCaps } from "./businessPolicy";
import { dayOf, dueBusinesses, getBusiness, openBusinesses, pauseItself, scheduleNext, type Business, type StartHooks } from "./business";
import { findWork, followWork, realJudge, repriceModelCosts, type Judge } from "./businessWork";
import { syncHires } from "./businessHire";
import { reinvest, restoreModel, shopHooks, syncJobModelCosts, syncShop } from "./businessGrow";
import { realWriter, writeReport, type Writer } from "./businessBooks";

/** Everything an owner's start, pause, resume and stop does beyond the store: the shop, the model, waiting requests. */
export function controlHooks(): StartHooks & { restoreModel: (b: Business) => void; cancelAsks: (b: Business) => void } {
  return { ...shopHooks(), restoreModel, cancelAsks: (b) => { cancelSpendApprovals(b.ownerWallet, b.agentId); } };
}

export interface TickDeps { judge?: Judge; writer?: Writer; price?: () => Promise<number | null>; caps?: BusinessCaps }
export interface Tick { kept: number; paused: number; looked: number; bids: number; reports: number }

/** Keep one business's books. Pauses it when its agent is no longer its owner's to run. */
async function keepBooks(b: Business, nowMs: number, deps: TickDeps = {}): Promise<Business> {
  const agent = getAgentById(b.agentId);
  if (b.status === "active") {
    const why = !agent ? "Its agent is gone" : !agent.walletAddress || !sameAddress(agent.walletAddress, b.ownerWallet) ? "Its agent changed hands" : !isOwnerVerified(b.agentId) ? "Its owner is no longer signed in with a wallet" : null;
    if (why) b = pauseItself(b, why, shopHooks());
  }
  followWork(b, nowMs);
  syncShop(b);
  syncHires(b);
  await syncJobModelCosts(b, deps.price);
  await repriceModelCosts(b.businessId, deps.price);
  return getBusiness(b.businessId) ?? b;
}

export async function runBusinessTick(nowMs = Date.now(), deps: TickDeps = {}): Promise<Tick> {
  const out: Tick = { kept: 0, paused: 0, looked: 0, bids: 0, reports: 0 };
  if (!businessEnabled()) return out;
  const caps = deps.caps ?? businessCaps();
  for (const b of openBusinesses()) {
    try {
      const kept = await keepBooks(b, nowMs, deps);
      out.kept++;
      if (b.status === "active" && kept.status !== "active") out.paused++;
      // the report for yesterday, once it is over, for a business that was running then
      const yesterday = dayOf(nowMs - 86_400_000);
      if (await writeReport(kept, yesterday, nowMs, deps.writer ?? realWriter, caps, deps.price)) out.reports++;
    } catch (err) {
      logger.warn("business.books_failed", "Keeping a business's books failed", { businessId: b.businessId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const b of dueBusinesses(nowMs)) {
    try {
      scheduleNext(b.businessId, nowMs, caps); // set first, so a crash moves on rather than looking again at once
      const r = await findWork(b, nowMs, deps.judge ?? realJudge, caps);
      out.looked += r.looked;
      out.bids += r.bid;
      await reinvest(getBusiness(b.businessId) ?? b, nowMs, deps.price);
    } catch (err) {
      logger.warn("business.scan_failed", "A business's look for work failed", { businessId: b.businessId, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

// Carrying out what the owner approved.
//
// The agent that asked is usually long done by the time the owner says yes, so Axon carries the request out itself:
// at once when the owner approves (the approvals route), and again from the apps tick for anything approved that could
// not go out yet. Only an app that knows how to carry something out is handled here (Slack, so far); a request for any
// other app stays approved.
//
// Exactly once: takeApproved hands the payload over a single time. A refusal for good (a channel that is gone, a
// revoked token) fails the request and says why. A busy or unreachable app puts it back to approved, and the tick
// tries again until the request runs out, 24 hours after it was asked.

import { logger } from "./logger";
import { approvedWaiting, markFailed, returnApproved, takeApproved, type Approval } from "./appPermissions";
import { settleAction } from "./appActivity";
import { deliverSlack, type Delivered } from "./slackTool";
import type { SlackDeps } from "./slackApi";

type Env = Record<string, string | undefined>;
type Deliver = (approval: Approval, payload: unknown, o: { env?: Env; deps?: SlackDeps }) => Promise<Delivered>;

const DELIVER: Record<string, Deliver> = { slack: deliverSlack };

export const canCarryOut = (appId: string): boolean => appId in DELIVER;

export interface CarriedOut {
  /** posted: it went out. later: it is tried again. failed: it will not go out. none: nothing was done here. */
  outcome: "posted" | "later" | "failed" | "none";
  message: string;
  link?: string | null;
}

/** Carry out one approved request, once. */
export async function carryOut(approval: Approval, o: { env?: Env; deps?: SlackDeps; now?: number } = {}): Promise<CarriedOut> {
  const deliver = DELIVER[approval.appId];
  if (!deliver) return { outcome: "none", message: "Approved." };
  const taken = takeApproved(approval.approvalId, { ownerWallet: approval.ownerWallet, agentId: approval.agentId, appId: approval.appId }, o.now);
  if (!taken) return { outcome: "none", message: "This was carried out already, or it ran out." };
  const done = await deliver(taken.approval, taken.payload, o);
  if (done.ok) {
    settleAction(approval.approvalId, { status: "posted", link: done.link, error: null });
    return { outcome: "posted", message: done.message, link: done.link };
  }
  if (done.transient && returnApproved(approval.approvalId)) {
    settleAction(approval.approvalId, { status: "approved", error: `${done.message} Axon tries again in a few minutes.`, receipt: false });
    return { outcome: "later", message: `${done.message} Axon tries again in a few minutes.` };
  }
  markFailed(approval.approvalId);
  settleAction(approval.approvalId, { status: "failed", error: done.message });
  return { outcome: "failed", message: done.message };
}

/** The apps tick: what was approved and could not go out yet, tried again. Returns how many went out. */
export async function carryOutWaiting(o: { env?: Env; deps?: SlackDeps; now?: number } = {}): Promise<number> {
  let posted = 0;
  for (const a of approvedWaiting(20, o.now).filter((x) => canCarryOut(x.appId))) {
    try {
      if ((await carryOut(a, o)).outcome === "posted") posted++;
    } catch (err) {
      logger.error("apps.carry_out_failed", "Carrying out an approved request failed", { err, approvalId: a.approvalId });
    }
  }
  return posted;
}

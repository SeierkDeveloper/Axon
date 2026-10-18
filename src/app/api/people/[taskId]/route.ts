import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { sameAddress } from "@/lib/address";
import { applyVerdict, askSecondLook, cancelPeopleTask, getPeopleTask, giveUpPeopleTask, moderate, ownerDecides, ownerView, publicView, takePeopleTask, takerView, type StepResult } from "@/lib/people";
import { payNow } from "@/lib/peoplePay";
import { logger } from "@/lib/logger";
import { callerOf, noStore, signInFirst, walletOf } from "@/lib/peopleHttp";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ taskId: string }> };

// GET /api/people/:taskId: one task. Anybody sees what is on the board; the person who holds it also sees their proofs and
// every answer about them; the owner sees everything, each proof included.
export async function GET(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    const c = callerOf(req);
    if ("response" in c) return c.response;
    const t = getPeopleTask((await params).taskId);
    const wallet = walletOf(c.caller);
    if (!t) return apiError("NOT_FOUND", "There is no such task.", 404);
    if (c.caller.kind === "moderator" || (wallet && sameAddress(wallet, t.ownerWallet))) return NextResponse.json({ task: ownerView(t) }, { headers: noStore });
    if (t.hiddenAt && !(wallet && sameAddress(wallet, t.takerWallet))) return apiError("NOT_FOUND", "There is no such task.", 404);
    return NextResponse.json({ task: wallet ? takerView(t, wallet) : publicView(t) }, { headers: noStore });
  });
}

// PATCH /api/people/:taskId { action }:
//   take, give_up, second_look                     the person
//   cancel, accept, reject { failedCheck, reason }   the agent's owner (reject only when a proof waits for them)
//   hide, show, block_agent, block_taker { reason }  a moderator
export async function PATCH(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    const c = callerOf(req);
    if ("response" in c) return c.response;
    const { taskId } = await params;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    const action = typeof body.action === "string" ? body.action : "";
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : "";

    if (c.caller.kind === "moderator") {
      if (!["hide", "show", "block_agent", "block_taker", "accept"].includes(action)) return apiError("VALIDATION_ERROR", "Say hide, show, block_agent, block_taker or accept.", 400);
      if (action === "accept") {
        const t = getPeopleTask(taskId);
        if (!t) return apiError("NOT_FOUND", "There is no such task.", 404);
        const r = applyVerdict(taskId, { verdict: "accept", reason: reason || "Accepted by a moderator", by: "moderator" });
        if (!r.ok) return apiError("CONFLICT", r.why, 409);
        void payNow(taskId).catch((err) => logger.warn("people.pay_now_failed", "Paying right after an accept failed; the worker tries again", { taskId, err }));
        return NextResponse.json({ task: ownerView(r.task) }, { headers: noStore });
      }
      const r = moderate(taskId, action as "hide" | "show" | "block_agent" | "block_taker", reason);
      if (!r.ok) return apiError("NOT_FOUND", r.why, 404);
      return NextResponse.json({ task: ownerView(r.task) }, { headers: noStore });
    }

    const wallet = walletOf(c.caller);
    if (!wallet) return signInFirst();
    const rl = checkRateLimit(`people-act:${wallet}`, 60, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    let r: StepResult;
    switch (action) {
      case "take": r = takePeopleTask(taskId, wallet); break;
      case "give_up": r = giveUpPeopleTask(taskId, wallet); break;
      case "second_look": r = askSecondLook(taskId, wallet); break;
      case "cancel": r = cancelPeopleTask(taskId, wallet); break;
      case "accept":
      case "reject": r = ownerDecides(taskId, wallet, { decision: action, failedCheck: body.failedCheck, reason: body.reason }); break;
      default: return apiError("VALIDATION_ERROR", "Say take, give_up, second_look, cancel, accept or reject.", 400);
    }
    if (!r.ok) return apiError(/no such|do not have/i.test(r.why) ? "NOT_FOUND" : /sign in/i.test(r.why) ? "AUTH_REQUIRED" : "CONFLICT", r.why, /no such|do not have/i.test(r.why) ? 404 : /sign in/i.test(r.why) ? 401 : 409);
    // an accept pays at once; the worker tries again if this does not get through
    if (action === "accept") void payNow(taskId).catch((err) => logger.warn("people.pay_now_failed", "Paying right after an accept failed; the worker tries again", { taskId, err }));
    const t = r.task;
    return NextResponse.json({ task: sameAddress(wallet, t.ownerWallet) ? ownerView(t) : takerView(t, wallet) }, { headers: noStore });
  });
}

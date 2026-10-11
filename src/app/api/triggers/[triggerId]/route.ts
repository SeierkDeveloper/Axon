import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { deleteTrigger, fireUrl, reachedAt, listTriggerRuns, ownTrigger, pauseTrigger, resumeTrigger, rotateSecret, triggerJson, triggersEnabled, TriggerError } from "@/lib/triggers";
import { chainHead } from "@/lib/triggerChain";
import { lookAt } from "@/lib/triggerPage";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";
type Params = { params: Promise<{ triggerId: string }> };

const refuse = (err: unknown) => {
  if (err instanceof TriggerError) return apiError(err.status === 404 ? "NOT_FOUND" : err.status === 409 ? "CONFLICT" : "VALIDATION_ERROR", err.message, err.status);
  throw err;
};

// GET /api/triggers/:id: the trigger and its latest runs, each with how its job ended and what it said.
export async function GET(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    if (!triggersEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    try {
      const { triggerId } = await params;
      const t = ownTrigger(triggerId, auth.user.walletAddress);
      const runs = listTriggerRuns(triggerId, auth.user.walletAddress, 20).map((r) => ({ ...r, receiptUrl: r.taskId ? `/r/${r.taskId}` : null }));
      return NextResponse.json({ trigger: { ...triggerJson(t), ...(t.kind === "inbound" ? { url: fireUrl(t.triggerId, reachedAt(req.headers)) } : {}) }, runs }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return refuse(err);
    }
  });
}

// PATCH /api/triggers/:id { action: "pause" | "resume" | "rotate" | "look" }
export async function PATCH(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    if (!triggersEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
    try {
      const { triggerId } = await params;
      const wallet = auth.user.walletAddress;
      if (body?.action === "pause") return NextResponse.json({ trigger: triggerJson(pauseTrigger(triggerId, wallet)) });
      if (body?.action === "resume") {
        const t = ownTrigger(triggerId, wallet);
        return NextResponse.json({ trigger: triggerJson(resumeTrigger(triggerId, wallet, t.kind === "chain" ? { headBlock: (await chainHead()) ?? undefined } : {})) });
      }
      if (body?.action === "rotate") {
        const { trigger, secret } = rotateSecret(triggerId, wallet);
        return NextResponse.json({ trigger: { ...triggerJson(trigger), url: fireUrl(trigger.triggerId, reachedAt(req.headers)) }, secret, note: "The old secret no longer works. This one is shown once." }, { headers: { "Cache-Control": "no-store" } });
      }
      // look: read a watched page now, without waiting for its next turn
      if (body?.action === "look") {
        const t = ownTrigger(triggerId, wallet);
        if (t.kind !== "page") return apiError("VALIDATION_ERROR", "Only a trigger that watches a page can be asked to look now.", 400);
        if (t.status !== "active") return apiError("CONFLICT", "The trigger is paused. Resume it first.", 409);
        const rl = checkRateLimit(`trigger-look:${t.triggerId}`, 6, 3_600_000);
        if (!rl.allowed) return tooManyRequests(rl);
        const result = await lookAt(t);
        return NextResponse.json({ trigger: triggerJson(ownTrigger(triggerId, wallet)), look: result });
      }
      return apiError("VALIDATION_ERROR", 'action is "pause", "resume", "rotate" or "look"', 400);
    } catch (err) {
      return refuse(err);
    }
  });
}

// DELETE /api/triggers/:id
export async function DELETE(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    if (!triggersEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    try {
      deleteTrigger((await params).triggerId, auth.user.walletAddress);
      return NextResponse.json({ deleted: true });
    } catch (err) {
      return refuse(err);
    }
  });
}

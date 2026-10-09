import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { deleteTrigger, fireUrl, reachedAt, listTriggerRuns, ownTrigger, pauseTrigger, resumeTrigger, rotateSecret, triggerJson, triggersEnabled, TriggerError } from "@/lib/triggers";
import { chainHead } from "@/lib/triggerChain";

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

// PATCH /api/triggers/:id { action: "pause" | "resume" | "rotate" }
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
      return apiError("VALIDATION_ERROR", 'action is "pause", "resume" or "rotate"', 400);
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

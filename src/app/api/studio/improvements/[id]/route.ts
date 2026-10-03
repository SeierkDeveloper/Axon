import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { decideImprovement } from "@/lib/studioImprove";

export const runtime = "nodejs";

// POST /api/studio/improvements/:id { apply: true | false }: the owner applies a better version Axon proposed for their
// live agent (it becomes the agent's instructions and score) or dismisses it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { apply?: unknown } | null;
    if (typeof body?.apply !== "boolean") return apiError("VALIDATION_ERROR", "apply: true to apply it, false to dismiss it", 400);
    const r = decideImprovement(id, auth.user.walletAddress, body.apply);
    if (typeof r === "string") return apiError(r === "No such proposal." ? "NOT_FOUND" : "CONFLICT", r, r === "No such proposal." ? 404 : 409);
    return NextResponse.json({ ok: true });
  });
}

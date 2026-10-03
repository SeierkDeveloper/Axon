import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { publishBuild } from "@/lib/studioPublish";

export const runtime = "nodejs";

// POST /api/studio/builds/:id/publish { priceEth? }: put a tested build live as an agent on Axon, at the owner's price per
// task (the suggested one when none is given). Only a build that scored 6 or more can be published.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { priceEth?: unknown };
    const price = body.priceEth === undefined ? undefined : Number(body.priceEth);
    const r = publishBuild(id, auth.user.walletAddress, price);
    if (typeof r === "string") return apiError(r === "No such build." ? "NOT_FOUND" : "VALIDATION_ERROR", r, r === "No such build." ? 404 : 400);
    return NextResponse.json({ ok: true, agentId: r.agentId, url: `/agents/${r.agentId}` }, { status: 201 });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { remixAgent } from "@/lib/studioPublish";

export const runtime = "nodejs";

// POST /api/studio/remix { agentId }: copy a live Agent Studio agent into a new build of your own, to change and test.
// Once published, the remix pays the agent it came from 10% of every hire.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const body = (await req.json().catch(() => null)) as { agentId?: unknown } | null;
    if (typeof body?.agentId !== "string") return apiError("VALIDATION_ERROR", "agentId: the agent to remix", 400);
    const r = remixAgent(body.agentId, auth.user.walletAddress);
    if (typeof r === "string") return apiError("VALIDATION_ERROR", r, 400);
    return NextResponse.json({ build: r }, { status: 201 });
  });
}

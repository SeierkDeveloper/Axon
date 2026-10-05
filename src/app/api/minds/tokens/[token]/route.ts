import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { liveToken } from "@/lib/mindsIndex";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";

// GET /api/minds/tokens/:token: one token with what the chain says right now: its settings, its mind's treasury, what
// its fees have paid out, and what its agent has earned from work since the launch.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const token = normalizeAddress((await ctx.params).token);
    if (!token) return apiError("VALIDATION_ERROR", "That is not a token address", 400);
    const t = await liveToken(token);
    if (!t) return apiError("NOT_FOUND", "No token with a mind at that address", 404);
    return NextResponse.json(t, { headers: { "Cache-Control": "public, max-age=10" } });
  });
}

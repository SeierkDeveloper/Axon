import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { listTokens, tokenCount } from "@/lib/mindsStore";

export const runtime = "nodejs";

// GET /api/minds/tokens: the tokens launched with a mind, newest first, as read from the chain. ?before=<launchedAt>
// pages back; ?limit= up to 100.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const q = req.nextUrl.searchParams;
    const limit = Math.min(100, Math.max(1, Number(q.get("limit")) || 50));
    const before = q.get("before") ?? undefined;
    return NextResponse.json({ total: tokenCount(), tokens: listTokens(limit, before) }, { headers: { "Cache-Control": "public, max-age=10" } });
  });
}

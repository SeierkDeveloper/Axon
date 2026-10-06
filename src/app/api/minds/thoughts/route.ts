import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { thoughts } from "@/lib/mindsMind";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";

// GET /api/minds/thoughts?token=0x…&limit=: what minds have thought, newest first: one token's journal, or every
// mind's when no token is named. Public: a mind thinks in the open. What a thought cost is not part of the answer.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const q = req.nextUrl.searchParams;
    const raw = q.get("token");
    const token = raw ? normalizeAddress(raw) : null;
    if (raw && !token) return apiError("VALIDATION_ERROR", "That is not a token address", 400);
    const list = thoughts(token, Number(q.get("limit")) || 10).map((t) => ({
      id: t.id, token: t.token, name: t.name, symbol: t.symbol, logo: t.logo, at: t.at, modelLabel: t.modelLabel, source: t.source, thought: t.thought, action: t.action, verdict: t.verdict, verdictReason: t.verdictReason, sent: t.sent,
    }));
    return NextResponse.json({ thoughts: list }, { headers: { "Cache-Control": "public, max-age=5" } });
  });
}

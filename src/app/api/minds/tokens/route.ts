import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { board, boardTotals, events, type BoardSort } from "@/lib/mindsStats";
import { ethUsd } from "@/lib/ethPrice";

export const runtime = "nodejs";

// GET /api/minds/tokens?sort=new|mcap|burned: every token launched with a mind, with the numbers the worker last read
// from the chain, the totals across all of them, and what happened lately. One request feeds the whole terminal.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const q = req.nextUrl.searchParams;
    const sort = (["new", "mcap", "burned"] as const).find((s) => s === q.get("sort")) ?? ("new" as BoardSort);
    const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 60));
    return NextResponse.json(
      { totals: boardTotals(), ethUsd: await ethUsd(), tokens: board(sort, limit), events: events(40) },
      { headers: { "Cache-Control": "public, max-age=3" } },
    );
  });
}

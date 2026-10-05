import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { board, boardToken, boardTotals, events, PAGE_SIZE, type BoardSort } from "@/lib/mindsStats";
import { normalizeAddress } from "@/lib/address";
import { ethUsd } from "@/lib/ethPrice";

export const runtime = "nodejs";

// GET /api/minds/tokens?sort=new|mcap|burned&page=1: the tokens launched with a mind, a page at a time, with the numbers
// the worker last read from the chain, the totals across all of them, and what happened lately. `open` names a token
// to send along whichever page it is on. One request feeds the whole terminal.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const q = req.nextUrl.searchParams;
    const sort = (["new", "mcap", "burned"] as const).find((s) => s === q.get("sort")) ?? ("new" as BoardSort);
    const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || PAGE_SIZE));
    const totals = boardTotals();
    const pages = Math.max(1, Math.ceil(totals.tokens / limit));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(q.get("page")) || 1)));
    const open = normalizeAddress(q.get("open") ?? "");
    return NextResponse.json(
      { totals, ethUsd: await ethUsd(), tokens: board(sort, limit, (page - 1) * limit), page, pages, opened: open ? boardToken(open) : null, events: events(40) },
      { headers: { "Cache-Control": "public, max-age=3" } },
    );
  });
}

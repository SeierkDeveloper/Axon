import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { normalizeAddress } from "@/lib/address";
import { holdLimit } from "@/lib/peoplePolicy";
import { recordOf, topPeople } from "@/lib/people";
import { callerOf } from "@/lib/peopleHttp";

export const runtime = "nodejs";

// GET /api/people/record: the public record of the people with the most accepted tasks. With ?wallet=0x..., one person's
// record: tasks accepted, rejected for good, given up, ETH earned, and how many tasks they may hold at once.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const c = callerOf(req);
    if ("response" in c) return c.response;
    const raw = req.nextUrl.searchParams.get("wallet");
    const view = (w: string) => {
      const r = recordOf(w);
      return { wallet: r.short, done: r.done, rejected: r.rejected, gaveUp: r.gaveUp, earned: r.earned, since: r.since, last: r.last, mayHold: holdLimit(r.done) };
    };
    if (raw !== null) {
      const w = normalizeAddress(raw);
      if (!w) return apiError("VALIDATION_ERROR", "Give a wallet address.", 400);
      return NextResponse.json({ record: view(w) }, { headers: { "Cache-Control": "public, max-age=30" } });
    }
    return NextResponse.json({ people: topPeople().map((r) => view(r.wallet)) }, { headers: { "Cache-Control": "public, max-age=30" } });
  });
}

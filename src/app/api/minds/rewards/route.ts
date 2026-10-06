import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { openSharesOf } from "@/lib/mindsAct";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";

// GET /api/minds/rewards?account=0x…: what a wallet can claim from the rewards minds have set aside: each share with
// the proof its treasury checks. Public: a share and its proof are only of use to the wallet they pay, and the claim
// itself is that wallet's own transaction. Shares the chain says are claimed already are left out.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const account = normalizeAddress(req.nextUrl.searchParams.get("account") ?? "");
    if (!account) return apiError("VALIDATION_ERROR", "That is not a wallet address", 400);
    const open = await openSharesOf(account);
    return NextResponse.json({ shares: open }, { headers: { "Cache-Control": "no-store" } });
  });
}

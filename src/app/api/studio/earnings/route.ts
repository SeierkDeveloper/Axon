import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { earningsOf, withdrawalsOf } from "@/lib/studioWithdraw";
import { proposalsOf } from "@/lib/studioImprove";
import { WITHDRAW, withdrawalsEnabled } from "@/lib/studioPolicy";
import { shopEnabled } from "@/lib/agentShop";
import { salesOfOwner } from "@/lib/shopSales";

export const runtime = "nodejs";

// GET /api/studio/earnings: the signed-in wallet's Studio agents, what each earned and can take out, and its withdrawals.
// While the shop is on, also what its agents sold (that ETH is already part of what each earned).
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const wallet = auth.user.walletAddress;
    if (!wallet) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    return NextResponse.json(
      { agents: earningsOf(wallet), withdrawals: withdrawalsOf(wallet), proposals: proposalsOf(wallet), rules: { minEth: WITHDRAW.minEth, maxPerDayEth: WITHDRAW.maxPerDayEth }, open: withdrawalsEnabled(), ...(shopEnabled() ? { sales: salesOfOwner(wallet) } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

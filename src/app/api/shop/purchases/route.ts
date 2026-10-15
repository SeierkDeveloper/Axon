import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { shopEnabled } from "@/lib/agentShop";
import { purchasesOf, saleReceipt } from "@/lib/shopSales";
import { publicOrigin } from "@/lib/publicUrl";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

// GET /api/shop/purchases: what the signed-in wallet bought, newest first, each with its receipt and, when it was
// delivered, where its files are.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const origin = publicOrigin(req);
    const purchases = purchasesOf(auth.user.walletAddress).map((s) => ({
      ...saleReceipt(s.saleId)!,
      receiptUrl: `${origin}/r/${s.saleId}`,
      ...(s.status === "delivered" ? { files: `${origin}/api/shop/sales/${s.saleId}/zip` } : {}),
    }));
    return NextResponse.json({ purchases }, { headers: { "Cache-Control": "no-store" } });
  });
}

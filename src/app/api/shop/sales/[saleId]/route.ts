import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { authenticateApiKey } from "@/lib/identity";
import { getSale, shopEnabled } from "@/lib/agentShop";
import { mayOpen, saleReceipt } from "@/lib/shopSales";
import { publicOrigin } from "@/lib/publicUrl";

export const runtime = "nodejs";

// GET /api/shop/sales/:saleId: a sale's receipt, which anybody may read: who bought what from which agent, the version
// and its fingerprint, and the payment. For the buyer (X-Claim-Token, or signed in with the wallet that paid) it also
// says where the files are.
export async function GET(req: NextRequest, { params }: { params: Promise<{ saleId: string }> }) {
  if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
  const { saleId } = await params;
  const sale = getSale(saleId);
  if (!sale) return apiError("NOT_FOUND", "There is no such sale", 404);
  const wallet = authenticateApiKey(req)?.walletAddress ?? null;
  const mine = mayOpen(sale, { claimToken: req.headers.get("x-claim-token"), wallet });
  return NextResponse.json({ receipt: saleReceipt(saleId), ...(mine ? { files: `${publicOrigin(req)}/api/shop/sales/${saleId}/zip` } : {}) }, { headers: { "Cache-Control": "no-store" } });
}

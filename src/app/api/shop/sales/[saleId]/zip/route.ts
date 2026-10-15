import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { authenticateApiKey } from "@/lib/identity";
import { getSale, shopEnabled } from "@/lib/agentShop";
import { mayOpen, saleFiles } from "@/lib/shopSales";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

const PER_MINUTE = 20;

// GET /api/shop/sales/:saleId/zip: the files that were bought, in one archive, as many times as the buyer wants: the
// version that was sold, with a note that carries its fingerprint. For the buyer only: the sale's key (X-Claim-Token),
// or signed in with the wallet that paid.
export async function GET(req: NextRequest, { params }: { params: Promise<{ saleId: string }> }) {
  return withRequestContext(req, async () => {
    if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`shop-zip:${getClientIp(req)}`, PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { saleId } = await params;
    const sale = getSale(saleId);
    if (!sale) return apiError("NOT_FOUND", "There is no such sale", 404);
    const wallet = authenticateApiKey(req)?.walletAddress ?? null;
    if (!mayOpen(sale, { claimToken: req.headers.get("x-claim-token"), wallet })) return apiError("FORBIDDEN", "Only the buyer can open these files", 403);
    const made = saleFiles(sale);
    if (!made) return apiError("TASK_STATE_CONFLICT", "These files are no longer kept", 410);
    return new NextResponse(new Uint8Array(made.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${made.name}"`,
        "Content-Length": String(made.bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

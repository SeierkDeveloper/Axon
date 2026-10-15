import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { shopEnabled } from "@/lib/agentShop";
import { buyProduct, saleReceipt } from "@/lib/shopSales";
import { publicOrigin } from "@/lib/publicUrl";
import { checkRateLimit, getClientIp, rateLimitHeaders, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";
export const maxDuration = 60;

const PER_MINUTE = 10;

// POST /api/shop/products/:productId/buy { paymentSignature, payerWallet, quotedWei? }: buy a product with ETH already
// sent from the buyer's wallet to Axon's receiving wallet on Robinhood Chain (GET /api/shop/products/:id says where and
// how much). The payment is checked on chain; the files come right away, at the address in `files`, with `claimToken`,
// the key that opens them again later. The same payment hash a second time gives back the sale it already made, without
// the key. A product that cannot be handed over any more is refunded (410), with the reason.
export async function POST(req: NextRequest, { params }: { params: Promise<{ productId: string }> }) {
  return withRequestContext(req, async () => {
    if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`shop-buy:${getClientIp(req)}`, PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { productId } = await params;
    const body = (await req.json().catch(() => null)) as { paymentSignature?: unknown; payerWallet?: unknown; quotedWei?: unknown } | null;
    if (!body) return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    const r = await buyProduct({ productId, paymentSignature: body.paymentSignature, payerWallet: body.payerWallet, quotedWei: body.quotedWei });
    if (!r.ok) return apiError(r.code, r.why, r.status, r.sale ? { receipt: saleReceipt(r.sale.saleId) } : undefined);
    const origin = publicOrigin(req);
    return NextResponse.json({
      saleId: r.sale.saleId,
      receipt: saleReceipt(r.sale.saleId),
      receiptUrl: `${origin}/r/${r.sale.saleId}`,
      ...(r.claimToken ? { claimToken: r.claimToken, files: `${origin}/api/shop/sales/${r.sale.saleId}/zip` } : {}),
      ...(r.replay ? { alreadyBought: true, note: "This payment already bought it. Open the files with the key from the first time, or signed in with the wallet that paid." } : {}),
    }, { status: r.replay ? 200 : 201, headers: rateLimitHeaders(rl, PER_MINUTE) });
  });
}

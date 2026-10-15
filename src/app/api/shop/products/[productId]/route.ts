import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { changeProduct, getProduct, productView, shopEnabled, takeDown } from "@/lib/agentShop";
import { publicOrigin } from "@/lib/publicUrl";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ productId: string }> };

// GET /api/shop/products/:productId: one product as anybody may see it.
export async function GET(req: NextRequest, { params }: Ctx) {
  if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
  const { productId } = await params;
  const p = getProduct(productId);
  if (!p) return apiError("NOT_FOUND", "There is no such product", 404);
  return NextResponse.json({ product: productView(p, publicOrigin(req)) });
}

// PATCH /api/shop/products/:productId { price?, title?, description? }: the agent's owner changes it.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const { productId } = await params;
    const body = (await req.json().catch(() => null)) as { price?: unknown; title?: unknown; description?: unknown } | null;
    if (!body) return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    const r = changeProduct(productId, auth.user.walletAddress, body);
    if (!r.ok) return apiError(/no such product/i.test(r.why) ? "NOT_FOUND" : "VALIDATION_ERROR", r.why, /no such product/i.test(r.why) ? 404 : 400);
    return NextResponse.json({ product: productView(r.product, publicOrigin(req)) });
  });
}

// DELETE /api/shop/products/:productId: the agent's owner takes it off sale. Whoever bought it keeps it.
export async function DELETE(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const { productId } = await params;
    const r = takeDown(productId, auth.user.walletAddress);
    if (!r.ok) return apiError("NOT_FOUND", r.why, 404);
    return NextResponse.json({ product: productView(r.product, publicOrigin(req)) });
  });
}

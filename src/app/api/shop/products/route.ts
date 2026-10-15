import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireAgentOwner } from "@/lib/apiAuth";
import { getAgentById } from "@/lib/agents";
import { listProduct, productView, shopEnabled } from "@/lib/agentShop";
import { publicOrigin } from "@/lib/publicUrl";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

// POST /api/shop/products { agentId, siteId, title?, description, price }: the agent's owner puts a page the agent
// built for them up for sale. The version the page shows now is what is sold, by its fingerprint. Signed in with the
// wallet that owns the agent.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const body = (await req.json().catch(() => null)) as { agentId?: unknown; siteId?: unknown; title?: unknown; description?: unknown; price?: unknown } | null;
    if (typeof body?.agentId !== "string" || typeof body.siteId !== "string") return apiError("VALIDATION_ERROR", "agentId and siteId are needed", 400);
    if (!getAgentById(body.agentId)) return apiError("NOT_FOUND", `Agent '${body.agentId}' not found`, 404);
    const auth = requireAgentOwner(req, body.agentId);
    if (!auth.ok) return auth.response;
    const r = listProduct({ agentId: body.agentId, wallet: auth.user.walletAddress, siteId: body.siteId, title: body.title, description: body.description, price: body.price });
    if (!r.ok) return apiError("VALIDATION_ERROR", r.why, 400);
    return NextResponse.json({ product: productView(r.product, publicOrigin(req)) }, { status: 201 });
  });
}

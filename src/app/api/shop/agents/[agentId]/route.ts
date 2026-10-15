import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireAgentOwner } from "@/lib/apiAuth";
import { getAgentById } from "@/lib/agents";
import { listablePages, productView, productsOfAgent, shopEnabled, shopLimits, SHOP } from "@/lib/agentShop";
import { formatEth } from "@/lib/money";
import { publicOrigin } from "@/lib/publicUrl";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ agentId: string }> };

// GET /api/shop/agents/:agentId: the shop as the agent's owner sees it. Every product, on sale or taken down, and the
// pages the agent built for the owner that could go up for sale.
export async function GET(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const { agentId } = await params;
    if (!getAgentById(agentId)) return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
    const auth = requireAgentOwner(req, agentId);
    if (!auth.ok) return auth.response;
    const origin = publicOrigin(req), limits = shopLimits();
    return NextResponse.json({
      products: productsOfAgent(agentId, { all: true }).map((p) => ({ ...productView(p, origin), onSale: p.status === "listed" })),
      pages: listablePages(agentId, auth.user.walletAddress).map((s) => ({ ...s, url: `${origin}/s/${s.siteId}` })),
      rules: { minPrice: formatEth(limits.minWei), maxPrice: formatEth(limits.maxWei), perAgent: limits.perAgent, titleChars: SHOP.titleChars, descriptionChars: SHOP.descriptionChars },
    }, { headers: { "Cache-Control": "no-store" } });
  });
}

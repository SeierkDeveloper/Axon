import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireAgentOwner } from "@/lib/apiAuth";
import { getAgentById } from "@/lib/agents";
import { listablePages, productView, productsOfAgent, shopAgentOf, shopEnabled, shopLimits, SHOP, type ShopAgent } from "@/lib/agentShop";
import { MAKE_EVERY, canMake, makeRunsOf, setMaking } from "@/lib/shopMake";
import { materialCeiling, setBuying } from "@/lib/shopTool";
import { formatEth } from "@/lib/money";
import { publicOrigin } from "@/lib/publicUrl";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ agentId: string }> };

/** What the owner set for the agent in the shop, as they read it back. */
function settingsView(s: ShopAgent | null, agentId: string) {
  return {
    make: {
      can: canMake(agentId), on: Boolean(s?.make.on), kind: s?.make.kind ?? null, price: s?.make.priceWei != null ? formatEth(s.make.priceWei) : null,
      everyHours: s?.make.everyHours ?? MAKE_EVERY.default, perDay: s?.make.perDay ?? 1, nextAt: s?.make.on ? s.make.nextAt : null, runs: makeRunsOf(agentId),
    },
    buy: { can: canMake(agentId), on: Boolean(s?.buy.on), maxPerJob: s?.buy.maxWei != null ? formatEth(s.buy.maxWei) : null },
  };
}

// GET /api/shop/agents/:agentId: the shop as the agent's owner sees it. Every product, on sale or taken down, the pages
// the agent built for the owner that could go up for sale, and what the agent may do in the shop by itself.
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
      settings: settingsView(shopAgentOf(agentId), agentId),
      rules: {
        minPrice: formatEth(limits.minWei), maxPrice: formatEth(limits.maxWei), perAgent: limits.perAgent, titleChars: SHOP.titleChars, descriptionChars: SHOP.descriptionChars,
        kindChars: SHOP.kindChars, makeEveryHours: { min: MAKE_EVERY.min, max: MAKE_EVERY.max }, makePerDayMax: limits.makePerDayMax, materialMaxPerJob: materialCeiling(limits),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  });
}

// PUT /api/shop/agents/:agentId { make?: { on, kind, price, everyHours, perDay }, buy?: { on, maxEth } }: what the agent
// may do in the shop by itself. With make on, the agent builds something new of that kind on that schedule and lists it
// at that price, marked as made by the agent on its own. With buy on, in a paid job it may buy other agents' products
// as material, from its own earnings, up to maxEth for one job. Only the agent's owner.
export async function PUT(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const { agentId } = await params;
    if (!getAgentById(agentId)) return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
    const auth = requireAgentOwner(req, agentId);
    if (!auth.ok) return auth.response;
    const body = (await req.json().catch(() => null)) as { make?: { on?: unknown; kind?: unknown; price?: unknown; everyHours?: unknown; perDay?: unknown }; buy?: { on?: unknown; maxEth?: unknown } } | null;
    const make = body?.make, buy = body?.buy;
    if ((!make && !buy) || (make && typeof make.on !== "boolean") || (buy && typeof buy.on !== "boolean")) {
      return apiError("VALIDATION_ERROR", 'Send { "make": { "on": true, "kind": "...", "price": "0.01", "everyHours": 24, "perDay": 1 } } or { "buy": { "on": true, "maxEth": "0.002" } }', 400);
    }
    let shop = shopAgentOf(agentId);
    if (make) {
      const r = setMaking(agentId, auth.user.walletAddress, { on: make.on as boolean, kind: make.kind, price: make.price, everyHours: make.everyHours, perDay: make.perDay });
      if (!r.ok) return apiError("VALIDATION_ERROR", r.why, 400);
      shop = r.shop;
    }
    if (buy) {
      const r = setBuying(agentId, auth.user.walletAddress, { on: buy.on as boolean, maxEth: buy.maxEth });
      if (!r.ok) return apiError("VALIDATION_ERROR", r.why, 400);
      shop = r.shop;
    }
    return NextResponse.json({ settings: settingsView(shop, agentId) });
  });
}

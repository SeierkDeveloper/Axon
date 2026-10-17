import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { getDb } from "@/lib/db";
import { getAgentById } from "@/lib/agents";
import { isOwnerVerified } from "@/lib/ownerVerification";
import { listAllowanceKeys } from "@/lib/allowanceKeys";
import { formatEth } from "@/lib/money";
import { shopEnabled } from "@/lib/agentShop";
import { canMake } from "@/lib/shopMake";
import { BUSINESS, SPEND_KINDS, SPEND_WORDS, businessCaps, businessEnabled } from "@/lib/businessPolicy";
import { businessesOf, businessOfAgent, startBusiness, type StartInput } from "@/lib/business";
import { canLead } from "@/lib/businessWork";
import { ownerView, publicView } from "@/lib/businessBooks";
import { controlHooks } from "@/lib/businessRun";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

// GET /api/business: the signed-in wallet's businesses with everything about each, the agents it could start one with,
// its allowance keys, and the rules. GET /api/business?agent=<agentId>, signed in or not: what anybody may see about
// that agent's business (no amounts, no limits, no reasons).
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!businessEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const agent = new URL(req.url).searchParams.get("agent");
    if (agent) {
      if (!getAgentById(agent)) return apiError("NOT_FOUND", `Agent '${agent}' not found`, 404);
      return NextResponse.json({ business: publicView(agent) });
    }
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const wallet = auth.user.walletAddress.toLowerCase();
    const caps = businessCaps();
    const mine = (getDb().prepare("SELECT agent_id FROM agents WHERE LOWER(wallet_address) = ? ORDER BY created_at DESC LIMIT 50").all(wallet) as { agent_id: string }[])
      .map(({ agent_id }) => getAgentById(agent_id)!)
      .filter(Boolean)
      .map((a) => ({ agentId: a.agentId, name: a.name, price: a.price ?? null, verified: isOwnerVerified(a.agentId), busy: Boolean(businessOfAgent(a.agentId)), canHire: canLead(a), canSell: shopEnabled() && canMake(a.agentId) }));
    return NextResponse.json({
      businesses: businessesOf(wallet).map((b) => ownerView(b)),
      agents: mine,
      allowanceKeys: listAllowanceKeys(wallet).map((k) => ({ keyId: k.keyId, keyPrefix: k.keyPrefix, label: k.label, perTask: formatEth(k.maxPerTaskWei), perDay: formatEth(k.maxPerDayWei), expiresAt: k.expiresAt })),
      rules: {
        spendKinds: SPEND_KINDS.map((k) => ({ kind: k, words: SPEND_WORDS[k] })), budgetMaxEth: caps.budgetMaxEth, bidsPerHourMax: caps.bidsPerHourMax, perWallet: caps.perWallet,
        goalChars: BUSINESS.goalChars, scanMinutes: caps.scanMinutes, approvalWaitMinutes: caps.approvalWaitMinutes, shop: shopEnabled(),
      },
    }, { headers: noStore });
  });
}

// POST /api/business { agentId, goal, budgetEth, maxPerDayEth, maxPerJobEth, approveAboveEth, spendOn: ["hire", "material",
// "model"], allowanceKeyId?, priceMinEth, priceMaxEth, bidsPerHour?, sell?: { on, priceEth } }: one of your agents starts
// running a business. Only the agent's owner, with a full key.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!businessEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`business-start:${auth.user.walletAddress}`, 20, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await req.json().catch(() => null)) as StartInput | null;
    if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    const r = startBusiness(auth.user.walletAddress, body, controlHooks());
    if (!r.ok) return apiError(/owner/i.test(r.why) ? "FORBIDDEN" : /already/i.test(r.why) ? "CONFLICT" : "VALIDATION_ERROR", r.why, /owner/i.test(r.why) ? 403 : /already/i.test(r.why) ? 409 : 400);
    return NextResponse.json({ business: ownerView(r.business) }, { status: 201, headers: noStore });
  });
}

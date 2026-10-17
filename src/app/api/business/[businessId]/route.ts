import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { sameAddress } from "@/lib/address";
import { businessEnabled } from "@/lib/businessPolicy";
import { changeLimits, getBusiness, pauseBusiness, resumeBusiness, stopBusiness, type StartInput } from "@/lib/business";
import { ownerView } from "@/lib/businessBooks";
import { controlHooks } from "@/lib/businessRun";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ businessId: string }> };
const noStore = { "Cache-Control": "no-store" };

// GET /api/business/:businessId: everything about one of your businesses: its limits and what is left of them, the P&L
// per day and in total, the decision log, the ledger, the daily reports and what waits for your OK.
export async function GET(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    if (!businessEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const b = getBusiness((await params).businessId);
    if (!b || !sameAddress(b.ownerWallet, auth.user.walletAddress)) return apiError("NOT_FOUND", "There is no such business of yours.", 404);
    return NextResponse.json({ business: ownerView(b) }, { headers: noStore });
  });
}

// PATCH /api/business/:businessId { action: "pause" | "resume" | "stop" } or { limits: { budgetEth, maxPerDayEth,
// maxPerJobEth, approveAboveEth, spendOn, priceMinEth, priceMaxEth, bidsPerHour } }. Stopping is for good; what it earned
// stays the agent's, to withdraw the usual way.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    if (!businessEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`business-change:${auth.user.walletAddress}`, 120, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await req.json().catch(() => null)) as { action?: unknown; limits?: StartInput } | null;
    if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    const id = (await params).businessId, wallet = auth.user.walletAddress, hooks = controlHooks();
    const r = body.action === "pause" ? pauseBusiness(id, wallet, hooks)
      : body.action === "resume" ? resumeBusiness(id, wallet, hooks)
      : body.action === "stop" ? stopBusiness(id, wallet, hooks)
      : body.limits && typeof body.limits === "object" ? changeLimits(id, wallet, body.limits)
      : null;
    if (!r) return apiError("VALIDATION_ERROR", 'Send { "action": "pause" | "resume" | "stop" } or { "limits": { ... } }', 400);
    if (!r.ok) return apiError(r.status === 404 ? "NOT_FOUND" : "VALIDATION_ERROR", r.why, r.status ?? 400);
    return NextResponse.json({ business: ownerView(r.business) }, { headers: noStore });
  });
}

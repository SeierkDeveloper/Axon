import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { callerOf } from "@/lib/myloCaller";
import { getClientIp } from "@/lib/rateLimit";
import { confirmAction, viewOf } from "@/lib/myloActions";

export const runtime = "nodejs";

// POST /api/mylo/actions/:id/confirm { method: "wallet", payments: { agentId: txHash } } or { method: "allowance" }:
// the signed-in person confirms one of their proposals, as it was proposed. Paid hires are paid by their own
// transaction (checked on chain by the hire route) or from their own allowance (within its limits).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    if (!caller.wallet) return apiError("FORBIDDEN", "Sign in with your wallet to confirm", 403);
    const body = (await req.json().catch(() => null)) as { method?: unknown; payments?: unknown } | null;
    const method = body?.method === "allowance" ? "allowance" : "wallet";
    const payments = body?.payments && typeof body.payments === "object" ? Object.fromEntries(Object.entries(body.payments as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string> : {};
    const auth = req.headers.get("authorization");
    const apiKey = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : req.headers.get("x-api-key");
    const r = await confirmAction((await params).id, caller.owner, caller.wallet, { method, payments, apiKey, clientIp: getClientIp(req) });
    if (typeof r === "string") return apiError("CONFLICT", r, 409);
    return NextResponse.json({ action: viewOf(r) }, { headers: { "Cache-Control": "no-store" } });
  });
}

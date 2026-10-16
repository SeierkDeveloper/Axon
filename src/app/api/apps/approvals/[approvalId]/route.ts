import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { appsEnabled } from "@/lib/appRegistry";
import { decideApproval } from "@/lib/appPermissions";
import { carryOut } from "@/lib/appCarryOut";
import { appRefusal, noStore } from "@/lib/appsHttp";

export const runtime = "nodejs";
type Params = { params: Promise<{ approvalId: string }> };

// POST /api/apps/approvals/:approvalId { decision: "approve" | "decline" }: the owner's answer. Lands on the job's
// receipt either way. An approval is carried out at once where Axon knows how (a Slack post), and the answer says how
// that went: posted (with a link where the app gives one), later (the app was busy; tried again), or failed and why.
export async function POST(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`apps-decide:${auth.user.walletAddress}`, 240, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await req.json().catch(() => null)) as { decision?: unknown } | null;
    if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    try {
      const { approvalId } = await params;
      const decided = decideApproval(auth.user.walletAddress, approvalId, body.decision as "approve" | "decline");
      const carried = decided.status === "approved" ? await carryOut(decided) : null;
      const { ownerWallet: _o, ...approval } = decided;
      void _o;
      return NextResponse.json({ approval: carried && carried.outcome !== "none" ? { ...approval, status: carried.outcome === "posted" ? "used" : carried.outcome === "failed" ? "failed" : approval.status } : approval, ...(carried ? { carried } : {}) }, { headers: noStore });
    } catch (err) {
      return appRefusal(err);
    }
  });
}

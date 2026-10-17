import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { appsEnabled } from "@/lib/appRegistry";
import { businessEnabled } from "@/lib/businessPolicy";
import { listApprovals } from "@/lib/appPermissions";
import { noStore } from "@/lib/appsHttp";

export const runtime = "nodejs";

// GET /api/apps/approvals: what is waiting for the caller's OK, and what was decided lately.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    // the same inbox holds what an agent running its own business wants to spend above its owner's amount
    if (!appsEnabled() && !businessEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    return NextResponse.json(listApprovals(auth.user.walletAddress), { headers: noStore });
  });
}

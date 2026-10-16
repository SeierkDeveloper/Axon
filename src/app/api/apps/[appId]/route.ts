import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { appsEnabled } from "@/lib/appRegistry";
import { disconnect } from "@/lib/appConnect";
import { appRefusal, noStore } from "@/lib/appsHttp";

export const runtime = "nodejs";
type Params = { params: Promise<{ appId: string }> };

// DELETE /api/apps/:appId: disconnect. The tokens are removed here at once; the app is told where it can be.
export async function DELETE(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`apps-disconnect:${auth.user.walletAddress}`, 30, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    try {
      const { appId } = await params;
      const r = await disconnect(auth.user.walletAddress, appId);
      return NextResponse.json({ disconnected: true, ...r }, { headers: noStore });
    } catch (err) {
      return appRefusal(err);
    }
  });
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { mindLauncherAddress } from "@/lib/mindsChain";
import { prepare } from "@/lib/mindsAgent";

export const runtime = "nodejs";

// POST /api/minds/prepare: write down a launch the signed-in wallet is about to sign, and hand back the reference its
// transaction carries. Nothing is launched here and no agent is made: that happens when the chain shows the launch.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const launcher = mindLauncherAddress();
    if (!launcher) return apiError("UPSTREAM_ERROR", "Launching is not open yet", 503);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return apiError("VALIDATION_ERROR", "Send the launch as JSON", 400);
    const p = prepare(auth.user.walletAddress, body);
    if (typeof p === "string") return apiError("VALIDATION_ERROR", p, 400);
    return NextResponse.json({ ref: p.ref, launcher, name: p.name, symbol: p.symbol, agentId: p.agentId }, { headers: { "Cache-Control": "no-store" } });
  });
}

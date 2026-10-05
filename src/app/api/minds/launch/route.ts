import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { mindLauncherAddress } from "@/lib/mindsChain";
import { ponsLaunchFeeWei } from "@/lib/ponsFee";
import { launchableAgents } from "@/lib/mindsAgent";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/minds/launch?wallet=0x…: what the launch screen needs before anybody signs: the launcher, the launch
// factory's fee as it is right now, and the wallet's own agents that do not have a token yet.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const wallet = normalizeAddress(req.nextUrl.searchParams.get("wallet") ?? "");
    return NextResponse.json(
      { launcher: mindLauncherAddress(), launchFeeWei: (await ponsLaunchFeeWei()).toString(), agents: wallet ? launchableAgents(wallet) : [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

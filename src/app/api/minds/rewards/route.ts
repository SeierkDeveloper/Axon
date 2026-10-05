import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { sharesOf, markClaimed } from "@/lib/mindsAct";
import { VAULT_WRITE_ABI } from "@/lib/mindsChain";
import { publicClient } from "@/lib/evm";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";

// GET /api/minds/rewards?account=0x…: what a wallet can claim from the rewards minds have set aside: each share with
// the proof its treasury checks. Public: a share and its proof are only of use to the wallet they pay, and the claim
// itself is that wallet's own transaction. Shares the chain says are claimed already are left out.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const account = normalizeAddress(req.nextUrl.searchParams.get("account") ?? "");
    if (!account) return apiError("VALIDATION_ERROR", "That is not a wallet address", 400);
    const shares = sharesOf(account).slice(0, 50);
    const client = publicClient();
    const open = [];
    for (const s of shares) {
      const claimed = await client.readContract({ address: s.vault as `0x${string}`, abi: VAULT_WRITE_ABI, functionName: "isClaimed", args: [BigInt(s.rewardId), BigInt(s.index)] }).catch(() => false);
      if (claimed) markClaimed(s.token, s.rewardId, s.index);
      else open.push(s);
    }
    return NextResponse.json({ shares: open }, { headers: { "Cache-Control": "no-store" } });
  });
}

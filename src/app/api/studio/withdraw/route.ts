import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { withdraw } from "@/lib/studioWithdraw";

export const runtime = "nodejs";
export const maxDuration = 180;

// POST /api/studio/withdraw { agentId, amountEth }: send ETH an Agent Studio agent earned to the wallet that owns it,
// and only there. At least 0.001 ETH, at most 2 ETH a day per wallet.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const wallet = auth.user.walletAddress;
    if (!wallet) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const body = (await req.json().catch(() => null)) as { agentId?: unknown; amountEth?: unknown } | null;
    if (typeof body?.agentId !== "string" || !Number.isFinite(Number(body.amountEth))) return apiError("VALIDATION_ERROR", "agentId and amountEth are needed", 400);
    const r = await withdraw(body.agentId, wallet, Number(body.amountEth));
    if (typeof r === "string") return apiError("VALIDATION_ERROR", r, 400);
    return NextResponse.json({ ok: true, withdrawal: r });
  });
}

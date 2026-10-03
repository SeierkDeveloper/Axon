import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { getBuild, tweaksOf } from "@/lib/studioDraft";
import { roundsOf, settleStale } from "@/lib/studioTest";
import { sameAddress } from "@/lib/address";

export const runtime = "nodejs";

// GET /api/studio/builds/:id: one build, its draft, its test rounds answer by answer, and where it has got to. Its owner's alone until it is published.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const { id } = await params;
    settleStale(id);
    const b = getBuild(id);
    // someone else's build reads as missing, not as forbidden: its existence is private too
    if (!b || !sameAddress(b.wallet, auth.user.walletAddress ?? undefined)) return apiError("NOT_FOUND", "No such build", 404);
    return NextResponse.json({ build: b, rounds: roundsOf(id), tweaks: tweaksOf(id) }, { headers: { "Cache-Control": "no-store" } });
  });
}

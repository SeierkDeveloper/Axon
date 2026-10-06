import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { liveToken } from "@/lib/mindsIndex";
import { mindStatus } from "@/lib/mindsStatus";
import { planOf, progressOf } from "@/lib/mindsPlan";
import { boardToken } from "@/lib/mindsStats";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";

// GET /api/minds/tokens/:token: one token with what the chain says right now: its settings, its mind's treasury, what
// its fees have paid out, what its agent has earned from work since the launch, and what its mind is doing or waiting
// for, in a line, so a quiet mind never looks like a broken one.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const token = normalizeAddress((await ctx.params).token);
    if (!token) return apiError("VALIDATION_ERROR", "That is not a token address", 400);
    const t = await liveToken(token);
    if (!t) return apiError("NOT_FOUND", "No token with a mind at that address", 404);
    const status = await mindStatus(token, { treasury: t.treasury }).catch(() => null);
    const mind = status ? { state: status.state, text: status.text, actionsToday: status.day?.actionsToday ?? null, actionsAllowed: t.treasury?.limits.maxActionsPerDay ?? null } : null;
    // the plan its mind works to, and how far along its goal the token is
    const standing = planOf(token), b = boardToken(token);
    const plan = standing ? { ...standing, progress: b ? progressOf(standing, { holders: b.holders, mcapEth: b.mcapEth, burnedTokens: b.burnedTokens, curveBps: b.curveBps, phase: b.phase }) : null } : null;
    return NextResponse.json({ ...t, mind, plan }, { headers: { "Cache-Control": "public, max-age=10" } });
  });
}

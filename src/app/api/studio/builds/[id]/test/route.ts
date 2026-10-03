import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { getBuild, mayRun } from "@/lib/studioDraft";
import { runBuild } from "@/lib/studioTest";
import { sameAddress } from "@/lib/address";
import { studioEnabled } from "@/lib/studioPolicy";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// POST /api/studio/builds/:id/test: test a drafted build and improve it. Runs in the background (minutes); the build
// and its rounds (GET /api/studio/builds/:id) show it working, answer by answer.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const { id } = await params;
    const b = getBuild(id);
    if (!b || !sameAddress(b.wallet, auth.user.walletAddress ?? undefined)) return apiError("NOT_FOUND", "No such build", 404);
    if (!studioEnabled()) return apiError("UPSTREAM_ERROR", "Agent Studio is paused just now", 503);
    if (b.status !== "drafted") return apiError("CONFLICT", `This build is ${b.status}, not waiting to be tested`, 409);
    const room = mayRun(b.wallet);
    if (!room.ok) return apiError("RATE_LIMITED", room.reason, 429);
    void runBuild(id).catch((err) => logger.warn("studio.run_failed", "A Studio run threw", { buildId: id, reason: err instanceof Error ? err.message : String(err) }));
    return NextResponse.json({ ok: true, build: { ...b, status: "testing" } }, { status: 202 });
  });
}

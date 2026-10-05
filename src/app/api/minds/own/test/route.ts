import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { checkOwnUrl, ownMindsOpen, OWN_LIMITS } from "@/lib/mindsOwn";
import { tryOwn } from "@/lib/mindsMind";

export const runtime = "nodejs";

// POST /api/minds/own/test { url }: send the signed-in wallet's own server one sample wake and say what came back,
// read exactly as a real thought would be. A test changes nothing and is marked as one. A wallet gets a few an hour:
// each one makes Axon call an address a stranger chose.
const tries = new Map<string, number[]>();

export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const wallet = auth.user.walletAddress?.toLowerCase();
    if (!wallet) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    if (!ownMindsOpen()) return apiError("UPSTREAM_ERROR", "Running a mind on your own server is not open yet", 503);
    const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
    const bad = checkOwnUrl(body?.url);
    if (bad) return apiError("VALIDATION_ERROR", bad, 400);
    const now = Date.now();
    const recent = (tries.get(wallet) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= OWN_LIMITS.testsPerHour) return apiError("RATE_LIMITED", "That is a lot of tests. Try again in a little while.", 429);
    tries.set(wallet, [...recent, now]);
    return NextResponse.json(await tryOwn(String(body!.url).trim(), wallet), { headers: { "Cache-Control": "no-store" } });
  });
}

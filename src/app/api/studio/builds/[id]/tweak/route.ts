import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { tweakDraft } from "@/lib/studioDraft";
import { studioEnabled } from "@/lib/studioPolicy";

export const runtime = "nodejs";
export const maxDuration = 120;

// POST /api/studio/builds/:id/tweak { request }: one change asked for in Studio's chat ("make it shorter", "add a risk
// section"). The writer edits the draft; a tested build goes back to drafted so the change is tested before listing.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    if (!studioEnabled()) return apiError("UPSTREAM_ERROR", "Agent Studio is paused just now", 503);
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { request?: unknown } | null;
    if (typeof body?.request !== "string") return apiError("VALIDATION_ERROR", "request: the change you want", 400);
    const r = await tweakDraft(id, auth.user.walletAddress, body.request);
    if (typeof r === "string") return apiError(r === "No such build." ? "NOT_FOUND" : "VALIDATION_ERROR", r, r === "No such build." ? 404 : 400);
    return NextResponse.json({ build: r });
  });
}

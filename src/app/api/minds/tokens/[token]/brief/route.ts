import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { briefChangeAt, briefLog, briefOf, setBrief, BRIEF_CHARS } from "@/lib/mindsBrief";

export const runtime = "nodejs";

const CODE = { 400: "VALIDATION_ERROR", 403: "FORBIDDEN", 404: "NOT_FOUND", 429: "RATE_LIMITED" } as const;

// GET /api/minds/tokens/:token/brief: the note a token's creator has left its mind, and the ones before it. Public.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const { token } = await params;
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return apiError("VALIDATION_ERROR", "Not a token address", 400);
    const changeAt = briefChangeAt(token);
    return NextResponse.json({ brief: briefOf(token), log: briefLog(token), maxChars: BRIEF_CHARS, canChangeAt: changeAt ? new Date(changeAt).toISOString() : null }, { headers: { "Cache-Control": "public, max-age=10" } });
  });
}

// POST /api/minds/tokens/:token/brief: the signed-in wallet that launched the token leaves its mind a brief, or takes
// it back with an empty one. It changes what the mind is told its creator wishes, and nothing else.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const { token } = await params;
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return apiError("VALIDATION_ERROR", "Not a token address", 400);
    const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
    if (!body) return apiError("VALIDATION_ERROR", "Send the brief as JSON", 400);
    const r = setBrief(token, auth.user.walletAddress, body.text);
    if (!r.ok) return apiError(CODE[r.status], r.reason, r.status);
    return NextResponse.json({ brief: r.brief, changed: r.changed }, { headers: { "Cache-Control": "no-store" } });
  });
}

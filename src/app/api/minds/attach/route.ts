import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { checkAttach, suggestAttach, prepareAttach } from "@/lib/mindsAttach";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/minds/attach?wallet=0x…&token=0x…: may this wallet give this token a mind? Read from the chain. With no
// token, the token the wallet launched through the earlier agent-token flow, if it has one.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const q = req.nextUrl.searchParams;
    const wallet = normalizeAddress(q.get("wallet") ?? "");
    const token = q.get("token");
    const check = token ? await checkAttach(wallet, token) : wallet ? await suggestAttach(wallet) : null;
    return NextResponse.json({ check }, { headers: { "Cache-Control": "no-store" } });
  });
}

// POST /api/minds/attach { token, model, mindUrl?, agentId? }: write down what the signed-in wallet chose for the mind
// it is about to give its token, and hand back the pot its transaction names. Nothing is sent from here.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return apiError("VALIDATION_ERROR", "Send the choices as JSON", 400);
    const r = await prepareAttach(auth.user.walletAddress, body);
    if (typeof r === "string") return apiError("VALIDATION_ERROR", r, 400);
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  });
}

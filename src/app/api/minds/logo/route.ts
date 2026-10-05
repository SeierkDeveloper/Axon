import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { saveLogo, LOGO_LIMITS } from "@/lib/mindsLogo";

export const runtime = "nodejs";

// POST /api/minds/logo: the signed-in wallet's picture for a token it is about to launch. The body is the image itself.
// Answers with the link that goes into the launch transaction.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    if (Number(req.headers.get("content-length") ?? 0) > LOGO_LIMITS.bytes) return apiError("VALIDATION_ERROR", "That picture is too large. Use one under 500 KB.", 400);
    const bytes = Buffer.from(await req.arrayBuffer());
    const saved = saveLogo(auth.user.walletAddress, bytes);
    if (typeof saved === "string") return apiError("VALIDATION_ERROR", saved, 400);
    // the link is to this site as the visitor reached it, not to whatever the server calls itself behind the proxy
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    return NextResponse.json({ url: `${local ? "http" : "https"}://${host}/api/minds/logo/${saved.id}` }, { headers: { "Cache-Control": "no-store" } });
  });
}

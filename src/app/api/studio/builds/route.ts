import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { buildsOf } from "@/lib/studioDraft";

export const runtime = "nodejs";

// GET /api/studio/builds: the signed-in wallet's Agent Studio builds, newest first.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    return NextResponse.json({ builds: buildsOf(auth.user.walletAddress) }, { headers: { "Cache-Control": "no-store" } });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { ownMindsOpen, ownSecret } from "@/lib/mindsOwn";

export const runtime = "nodejs";

// GET /api/minds/own/secret: the secret Axon signs its requests to the signed-in wallet's own mind server with. It is
// Axon's secret, worked out from the wallet and stored nowhere; the creator puts it on their server so that server can
// tell Axon from anybody else. No key of the creator's is involved.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    if (!auth.user.walletAddress) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    if (!ownMindsOpen()) return apiError("UPSTREAM_ERROR", "Running a mind on your own server is not open yet", 503);
    return NextResponse.json({ secret: ownSecret(auth.user.walletAddress) }, { headers: { "Cache-Control": "no-store" } });
  });
}

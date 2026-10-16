import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { appsEnabled, DEFAULT_ACTIONS } from "@/lib/appRegistry";
import { appsFor } from "@/lib/appConnect";
import { listPermissions, listStanding } from "@/lib/appPermissions";
import { noStore, redirectUriFor } from "@/lib/appsHttp";

export const runtime = "nodejs";

// GET /api/apps: every app, whether it can be connected here and whether the caller has, what connecting asks for in
// plain words, what the caller lets each agent do, and where it may post without asking. Never a token.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const apps = appsFor(auth.user.walletAddress).map((a) => ({ ...a, callbackUrl: redirectUriFor(req, a.appId) }));
    return NextResponse.json({ apps, permissions: listPermissions(auth.user.walletAddress), standing: listStanding(auth.user.walletAddress), defaults: DEFAULT_ACTIONS }, { headers: noStore });
  });
}

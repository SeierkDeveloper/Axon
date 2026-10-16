import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { appsEnabled } from "@/lib/appRegistry";
import { browserCookieName, startConnect, STATE_TTL_MS } from "@/lib/appConnect";
import { appRefusal, noStore, redirectUriFor } from "@/lib/appsHttp";

export const runtime = "nodejs";
type Params = { params: Promise<{ appId: string }> };

// POST /api/apps/:appId/connect: start signing in with an app. Answers with the address to send the browser to, and
// gives this browser a cookie the callback checks, so a sign-in finishes only where it started.
export async function POST(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`apps-connect:${auth.user.walletAddress}`, 20, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    try {
      const { appId } = await params;
      const redirectUri = redirectUriFor(req, appId);
      const started = startConnect({ ownerWallet: auth.user.walletAddress, appId, redirectUri });
      const res = NextResponse.json({ url: started.url, expiresAt: started.expiresAt }, { headers: noStore });
      res.cookies.set(browserCookieName(appId), started.browser, {
        httpOnly: true,
        sameSite: "lax",
        secure: redirectUri.startsWith("https://"),
        path: `/api/apps/${encodeURIComponent(appId)}/callback`,
        maxAge: Math.floor(STATE_TTL_MS / 1000),
      });
      return res;
    } catch (err) {
      return appRefusal(err);
    }
  });
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { logger } from "@/lib/logger";
import { publicOrigin } from "@/lib/publicUrl";
import { appsEnabled } from "@/lib/appRegistry";
import { AppError, browserCookieName, finishConnect } from "@/lib/appConnect";
import { redirectUriFor } from "@/lib/appsHttp";

export const runtime = "nodejs";
type Params = { params: Promise<{ appId: string }> };

// GET /api/apps/:appId/callback: where an app sends the owner back. Finishes the sign-in and sends the browser to the
// dashboard, saying how it went with a short word (never anything the app sent).
export async function GET(req: NextRequest, { params }: Params) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`apps-callback:${getClientIp(req)}`, 30, 600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { appId } = await params;
    const q = req.nextUrl.searchParams;
    const back = (outcome: string) => {
      const res = NextResponse.redirect(`${publicOrigin(req)}/dashboard?app=${encodeURIComponent(appId)}&apps=${outcome}#apps`, 303);
      res.headers.set("Cache-Control", "no-store");
      res.headers.set("Referrer-Policy", "no-referrer");
      res.cookies.set(browserCookieName(appId), "", { path: `/api/apps/${encodeURIComponent(appId)}/callback`, maxAge: 0 });
      return res;
    };
    // the owner said no on the app's own page
    if (q.get("error")) return back("declined");
    try {
      await finishConnect({
        appId,
        code: q.get("code") ?? "",
        state: q.get("state") ?? "",
        browser: req.cookies.get(browserCookieName(appId))?.value,
        redirectUri: redirectUriFor(req, appId),
      });
      return back("connected");
    } catch (err) {
      if (!(err instanceof AppError)) {
        logger.error("apps.callback_failed", "Finishing an app sign-in failed", { err, app: appId });
        return back("failed");
      }
      logger.warn("apps.callback_refused", err.message, { app: appId, status: err.status });
      return back(err.reason);
    }
  });
}

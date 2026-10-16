import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { appsEnabled } from "@/lib/appRegistry";
import { AppError } from "@/lib/appConnect";
import { allowStanding, listStanding, stopStanding } from "@/lib/appPermissions";
import { appRefusal, noStore } from "@/lib/appsHttp";
import { asOwner, plainWords, SLACK_APP } from "@/lib/slackTool";
import { findChannel } from "@/lib/slackApi";

export const runtime = "nodejs";

// Posting without asking: where the caller lets one agent post without their OK each time, for jobs that start
// themselves (a schedule, a trigger). Off unless set here; only for an agent the caller lets publish in that app.
// Slack channels, so far.

// GET /api/apps/standing
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    return NextResponse.json({ standing: listStanding(auth.user.walletAddress) }, { headers: noStore });
  });
}

// PUT /api/apps/standing { agentId, appId: "slack", channel: "#team" }
export async function PUT(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`apps-standing:${auth.user.walletAddress}`, 60, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await req.json().catch(() => null)) as { agentId?: unknown; appId?: unknown; channel?: unknown } | null;
    if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    if (body.appId !== SLACK_APP) return apiError("VALIDATION_ERROR", "Posting without asking is for Slack channels only, so far.", 400);
    const ref = String(body.channel ?? "").trim();
    if (!ref || ref.length > 100) return apiError("VALIDATION_ERROR", "Say which channel.", 400);
    try {
      // the channel as Slack knows it, so a renamed channel is still the same one
      let channel;
      try {
        channel = await asOwner(auth.user.walletAddress, (t) => findChannel(t, ref));
      } catch (err) {
        throw err instanceof AppError ? err : new AppError(plainWords(err), 400);
      }
      const standing = allowStanding(auth.user.walletAddress, String(body.agentId ?? ""), SLACK_APP, { id: channel.id, label: `#${channel.name}` });
      return NextResponse.json({ standing }, { headers: noStore });
    } catch (err) {
      return appRefusal(err);
    }
  });
}

// DELETE /api/apps/standing?agentId=…&appId=…&target=…: ask every time again.
export async function DELETE(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const q = req.nextUrl.searchParams;
    try {
      const stopped = stopStanding(auth.user.walletAddress, q.get("agentId") ?? "", q.get("appId") ?? "", q.get("target") ?? "");
      return NextResponse.json({ stopped }, { headers: noStore });
    } catch (err) {
      return appRefusal(err);
    }
  });
}

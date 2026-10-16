import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { appsEnabled } from "@/lib/appRegistry";
import { listPermissions, resetPermission, setPermission } from "@/lib/appPermissions";
import { appRefusal, noStore } from "@/lib/appsHttp";

export const runtime = "nodejs";

// GET /api/apps/permissions: what the caller lets each agent do in each app. Agents not listed may read and draft.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    return NextResponse.json({ permissions: listPermissions(auth.user.walletAddress) }, { headers: noStore });
  });
}

// PUT /api/apps/permissions { agentId, appId, actions: ["read", "draft", "publish"] }
export async function PUT(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`apps-permissions:${auth.user.walletAddress}`, 120, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await req.json().catch(() => null)) as { agentId?: unknown; appId?: unknown; actions?: unknown } | null;
    if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    try {
      const permission = setPermission(auth.user.walletAddress, String(body.agentId ?? ""), String(body.appId ?? ""), body.actions);
      return NextResponse.json({ permission }, { headers: noStore });
    } catch (err) {
      return appRefusal(err);
    }
  });
}

// DELETE /api/apps/permissions?agentId=…&appId=…: back to the defaults (read and draft).
export async function DELETE(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const q = req.nextUrl.searchParams;
    try {
      const reset = resetPermission(auth.user.walletAddress, q.get("agentId") ?? "", q.get("appId") ?? "");
      return NextResponse.json({ reset }, { headers: noStore });
    } catch (err) {
      return appRefusal(err);
    }
  });
}

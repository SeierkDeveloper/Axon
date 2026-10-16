import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { appsEnabled, getApp } from "@/lib/appRegistry";
import { approvalsForTask } from "@/lib/appPermissions";
import { actionsForTask } from "@/lib/appActivity";
import { noStore } from "@/lib/appsHttp";

export const runtime = "nodejs";

// GET /api/apps/activity?taskId=…: the owner's part of a job's receipt. What the job's agent did in the caller's apps
// (what it read, the drafts it wrote with their text, what it asked to post and what came of it) and everything it
// asked the caller's OK for, with the preview. Only ever the caller's own: another wallet's job answers empty.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!appsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const taskId = (req.nextUrl.searchParams.get("taskId") ?? "").trim();
    if (!taskId || taskId.length > 200) return apiError("VALIDATION_ERROR", "taskId is required", 400);
    const actions = actionsForTask(auth.user.walletAddress, taskId).map((a) => ({ ...a, appName: getApp(a.appId)?.name ?? a.appId }));
    const approvals = approvalsForTask(auth.user.walletAddress, taskId);
    return NextResponse.json({ taskId, actions, approvals }, { headers: noStore });
  });
}

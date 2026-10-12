import { NextRequest, NextResponse } from "next/server";
import { getSite, showVersion, siteOfTask, sitesEnabled, versionsOf } from "@/lib/agentSites";
import { apiError } from "@/lib/apiError";
import { notTheHirer } from "@/lib/hirerAuth";
import { publicOrigin } from "@/lib/publicUrl";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { getTaskById } from "@/lib/tasks";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

const PER_MINUTE = 30;

/** The page a job built or changed, with every version of it that is kept: which is shown, and what each one was. */
function view(taskId: string, origin: string) {
  const site = siteOfTask(taskId);
  if (!site || site.version === 0) return null;
  const url = `${origin.replace(/\/+$/, "")}/s/${site.siteId}`;
  return {
    site: { siteId: site.siteId, title: site.title, version: site.version, status: site.status, url },
    versions: versionsOf(site.siteId).map((v) => ({
      version: v.version, note: v.note, files: v.files, bytes: v.bytes, sha256: v.sha256, createdAt: v.createdAt,
      shown: v.version === site.version, madeHere: v.taskId === taskId, url: `${url}?v=${v.version}`,
    })),
  };
}

// /api/tasks/:taskId/site: the page a job built, for whoever hired the job (see hirerAuth).
//   GET                 the page and every version kept, newest first
//   POST { version }    show that version at the page's link again. Nothing is lost: the versions after it stay.
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!sitesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;
    const seen = view(taskId, publicOrigin(req));
    if (!seen) return apiError("NOT_FOUND", "This job built no page", 404);
    return NextResponse.json(seen, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!sitesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`task-site:${getClientIp(req)}`, PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;
    const site = siteOfTask(taskId);
    if (!site || site.version === 0) return apiError("NOT_FOUND", "This job built no page", 404);
    if (getSite(site.siteId)?.status !== "live") return apiError("TASK_STATE_CONFLICT", "This page was taken down and cannot be changed", 409);
    const body = (await req.json().catch(() => null)) as { version?: unknown } | null;
    const version = typeof body?.version === "number" && Number.isInteger(body.version) ? body.version : NaN;
    if (!Number.isFinite(version) || !showVersion(site.siteId, version)) return apiError("VALIDATION_ERROR", "Send the version to show as { \"version\": 2 }: one of the versions this page has", 400);
    return NextResponse.json(view(taskId, publicOrigin(req)), { headers: { "Cache-Control": "no-store" } });
  });
}

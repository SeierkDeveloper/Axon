import { NextRequest, NextResponse } from "next/server";
import { siteOfTask, sitesEnabled } from "@/lib/agentSites";
import { apiError } from "@/lib/apiError";
import { notTheHirer } from "@/lib/hirerAuth";
import { publicOrigin } from "@/lib/publicUrl";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { siteZip } from "@/lib/siteZip";
import { getTaskById } from "@/lib/tasks";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

const PER_MINUTE = 20;

// GET /api/tasks/:taskId/site/zip: the files of the page a job built, in one archive, for whoever hired the job (see
// hirerAuth). The page as the agent wrote it, in a folder that opens in a browser by itself and can be put anywhere
// that serves files, with a short note. ?v=<n> asks for one of the versions that are kept instead of the one shown.
// A page that was taken down gives no files, here as everywhere (see filesOf in agentSites).
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!sitesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`task-site-zip:${getClientIp(req)}`, PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;
    const site = siteOfTask(taskId);
    if (!site || site.version === 0) return apiError("NOT_FOUND", "This job built no page", 404);
    if (site.status !== "live") return apiError("TASK_STATE_CONFLICT", "This page was taken down, so its files cannot be taken", 410);
    const asked = req.nextUrl.searchParams.get("v");
    const version = asked === null ? undefined : /^\d{1,4}$/.test(asked) ? Number(asked) : NaN;
    const made = Number.isNaN(version) ? null : siteZip(site.siteId, { version, origin: publicOrigin(req) });
    if (!made) return apiError("NOT_FOUND", "This page has no such version", 404);
    return new NextResponse(new Uint8Array(made.bytes), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${made.name}"`,
        "Content-Length": String(made.bytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

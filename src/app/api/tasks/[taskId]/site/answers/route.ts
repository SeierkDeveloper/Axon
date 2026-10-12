import { NextRequest, NextResponse } from "next/server";
import { siteOfTask, sitesEnabled } from "@/lib/agentSites";
import { apiError } from "@/lib/apiError";
import { notTheHirer } from "@/lib/hirerAuth";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { answerCount, answersCsv, answersOf, removeAnswer } from "@/lib/siteAnswers";
import { getTaskById } from "@/lib/tasks";
import { withRequestContext } from "@/lib/withRequestContext";

export const runtime = "nodejs";

const PER_MINUTE = 30;

// /api/tasks/:taskId/site/answers: what visitors sent through the form of the page a job built, for whoever hired
// the job (see hirerAuth) and for nobody else.
//   GET               the answers, newest first, and how many there are
//   GET ?format=csv   all of them as a file a spreadsheet opens
//   DELETE ?id=<id>   remove one answer for good
// They stay readable when forms are switched off or the page is taken down: they are the hirer's.
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!sitesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;
    const site = siteOfTask(taskId);
    if (!site || site.version === 0) return apiError("NOT_FOUND", "This job built no page", 404);
    if (req.nextUrl.searchParams.get("format") === "csv") {
      const name = `${site.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "answers"}-answers.csv`;
      return new NextResponse(answersCsv(site.siteId), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    return NextResponse.json({ total: answerCount(site.siteId), answers: answersOf(site.siteId) }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!sitesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`task-site-answers:${getClientIp(req)}`, PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;
    const site = siteOfTask(taskId);
    if (!site || site.version === 0) return apiError("NOT_FOUND", "This job built no page", 404);
    const id = req.nextUrl.searchParams.get("id") ?? "";
    if (!id || !removeAnswer(site.siteId, id)) return apiError("NOT_FOUND", "There is no such answer", 404);
    return NextResponse.json({ ok: true, total: answerCount(site.siteId), answers: answersOf(site.siteId) }, { headers: { "Cache-Control": "no-store" } });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { isReportReason, REPORT_REASONS } from "@/lib/peoplePolicy";
import { reportPeopleTask } from "@/lib/people";
import { callerOf, noStore, visitorKey, walletOf } from "@/lib/peopleHttp";

export const runtime = "nodejs";

// POST /api/people/:taskId/report { reason, note? }: anyone reports a task that breaks the rules. Signed in or not, one
// report per person per task. Enough reports take it off the board until a moderator looks.
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    const c = callerOf(req);
    if ("response" in c) return c.response;
    const reporter = walletOf(c.caller) ?? visitorKey(req);
    const rl = checkRateLimit(`people-report:${reporter}`, 10, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await req.json().catch(() => null)) as { reason?: unknown; note?: unknown } | null;
    if (!body || !isReportReason(body.reason)) return apiError("VALIDATION_ERROR", `Say why: ${REPORT_REASONS.join(", ")}.`, 400);
    const r = reportPeopleTask((await params).taskId, reporter, body.reason, typeof body.note === "string" ? body.note.trim() : null);
    if (!r.ok) return apiError(/already/.test(r.why) ? "CONFLICT" : "NOT_FOUND", r.why, /already/.test(r.why) ? 409 : 404);
    return NextResponse.json({ reported: true, hidden: r.hidden }, { status: 201, headers: noStore });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { notTheHirer } from "@/lib/hirerAuth";
import { answerQuestion, askEnabled, questionsView } from "@/lib/ask";

export const runtime = "nodejs";

const ANSWERS_PER_MINUTE = 20;

// POST /api/tasks/:taskId/answer: answer the question a job is waiting on. The job is queued again and its agent is
// run with the question and the answer. Only whoever hired the job may answer (see hirerAuth).
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!askEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`task-answer:${getClientIp(req)}`, ANSWERS_PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;

    const body = (await req.json().catch(() => null)) as { answer?: unknown } | null;
    if (!body || typeof body.answer !== "string") return apiError("VALIDATION_ERROR", "Send the answer as { \"answer\": \"...\" }", 400);
    const done = answerQuestion(taskId, body.answer);
    if (!done.ok) return apiError(done.refused === "not_waiting" ? "TASK_STATE_CONFLICT" : "VALIDATION_ERROR", done.reason, done.refused === "not_waiting" ? 409 : 400, { refused: done.refused });
    return NextResponse.json({ ...done.task, ...questionsView(done.task) });
  });
}

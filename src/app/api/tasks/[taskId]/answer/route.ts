import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { claimTokenValid } from "@/lib/mcpServer";
import { apiError } from "@/lib/apiError";
import { getDb } from "@/lib/db";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { answerQuestion, askEnabled, questionsView } from "@/lib/ask";

export const runtime = "nodejs";

const ANSWERS_PER_MINUTE = 20;

// POST /api/tasks/:taskId/answer: answer the question a job is waiting on. The job is queued again and its agent is
// run with the question and the answer. Only whoever hired the job may answer: the hire's claimToken
// (X-Claim-Token) for a hire made without signing in, otherwise the hirer's API key (or the allowance key that paid).
// The agent's owner may read a job but not answer for the person who hired it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!askEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`task-answer:${getClientIp(req)}`, ANSWERS_PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { taskId } = await params;
    const task = getTaskById(taskId);

    const claimToken = req.headers.get("x-claim-token");
    if (claimToken) {
      if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
      if (!claimTokenValid(taskId, claimToken)) return apiError("FORBIDDEN", "Invalid claim token for this task", 403);
    } else {
      const auth = requireApiKey(req, { allowAllowanceScope: true });
      if (!auth.ok) return auth.response;
      if (!task) return apiError("NOT_FOUND", `Task '${taskId}' not found`, 404);
      const mine = auth.user.scope === "allowance"
        ? Boolean(getDb().prepare("SELECT 1 FROM allowance_reservations WHERE task_id = ? AND api_key_id = ?").get(taskId, auth.user.keyId))
        : canAccessIdentity(auth.user, task.fromAgent);
      if (!mine) return apiError("FORBIDDEN", "Only whoever hired this job can answer its question", 403);
    }

    const body = (await req.json().catch(() => null)) as { answer?: unknown } | null;
    if (!body || typeof body.answer !== "string") return apiError("VALIDATION_ERROR", "Send the answer as { \"answer\": \"...\" }", 400);
    const done = answerQuestion(taskId, body.answer);
    if (!done.ok) return apiError(done.refused === "not_waiting" ? "TASK_STATE_CONFLICT" : "VALIDATION_ERROR", done.reason, done.refused === "not_waiting" ? 409 : 400, { refused: done.refused });
    return NextResponse.json({ ...done.task, ...questionsView(done.task) });
  });
}

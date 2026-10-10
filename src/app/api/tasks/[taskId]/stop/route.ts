import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { notTheHirer } from "@/lib/hirerAuth";
import { steerEnabled, stopJob } from "@/lib/steer";

export const runtime = "nodejs";

const STOPS_PER_MINUTE = 20;

// POST /api/tasks/:taskId/stop: stop a job that has not finished. It ends as cancelled: nothing is delivered,
// whatever was paid is refunded, and it counts neither for nor against the agent. Only whoever hired the job may
// stop it (see hirerAuth).
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!steerEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`task-stop:${getClientIp(req)}`, STOPS_PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;
    const done = stopJob(taskId);
    if (!done.ok) return apiError(done.status === 409 ? "TASK_STATE_CONFLICT" : "VALIDATION_ERROR", done.reason, done.status, { refused: done.refused });
    return NextResponse.json(done.task);
  });
}

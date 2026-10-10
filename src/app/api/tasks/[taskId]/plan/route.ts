import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { notTheHirer } from "@/lib/hirerAuth";
import { decidePlan, planEnabled, planView, type PlanAction } from "@/lib/planFirst";

export const runtime = "nodejs";

const DECISIONS_PER_MINUTE = 20;
const ACTIONS: PlanAction[] = ["approve", "change", "cancel"];

// POST /api/tasks/:taskId/plan: decide on the plan a job is waiting on. { action: "approve" } starts the work.
// { action: "change", change: "..." } has the agent write the plan again. { action: "cancel" } ends the job before
// any work: whatever was paid is refunded. Only whoever hired the job may decide (see hirerAuth).
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!planEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`task-plan:${getClientIp(req)}`, DECISIONS_PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;

    const body = (await req.json().catch(() => null)) as { action?: unknown; change?: unknown } | null;
    const action = ACTIONS.find((a) => a === body?.action);
    if (!action) return apiError("VALIDATION_ERROR", "Send { \"action\": \"approve\" | \"change\" | \"cancel\" }, with \"change\" saying what to change", 400);
    const done = decidePlan(taskId, action, typeof body?.change === "string" ? body.change : null);
    if (!done.ok) return apiError(done.refused === "not_waiting" ? "TASK_STATE_CONFLICT" : "VALIDATION_ERROR", done.reason, done.refused === "not_waiting" ? 409 : 400, { refused: done.refused });
    return NextResponse.json({ ...done.task, ...planView(done.task) });
  });
}

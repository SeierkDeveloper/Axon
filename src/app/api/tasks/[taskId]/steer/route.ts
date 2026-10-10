import { NextRequest, NextResponse } from "next/server";
import { getTaskById } from "@/lib/tasks";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { notTheHirer } from "@/lib/hirerAuth";
import { sendNote, steerEnabled, steerView } from "@/lib/steer";

export const runtime = "nodejs";

const NOTES_PER_MINUTE = 20;

// POST /api/tasks/:taskId/steer: send the agent a note while its job runs. Body: { note }. The agent reads it at
// its next step, or before it finishes. A job that has finished takes a follow-up instead. Only whoever hired the
// job may send one (see hirerAuth).
export async function POST(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  return withRequestContext(req, async () => {
    if (!steerEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const rl = checkRateLimit(`task-steer:${getClientIp(req)}`, NOTES_PER_MINUTE, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const { taskId } = await params;
    const refused = notTheHirer(req, taskId, getTaskById(taskId));
    if (refused) return refused;

    const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
    if (!body || typeof body.note !== "string") return apiError("VALIDATION_ERROR", "Send the note as { \"note\": \"...\" }", 400);
    const sent = sendNote(taskId, body.note);
    if (!sent.ok) return apiError(sent.status === 409 ? "TASK_STATE_CONFLICT" : "VALIDATION_ERROR", sent.reason, sent.status, { refused: sent.refused });
    return NextResponse.json({ note: sent.note, ...steerView(getTaskById(taskId)!) });
  });
}

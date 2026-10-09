import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { getTaskById } from "@/lib/tasks";
import { claimTokenValid } from "@/lib/mcpServer";
import { voiceEnabled, speakable, speak, spokenBefore, dailySpeaks, SPEAK } from "@/lib/agentVoice";

export const runtime = "nodejs";

// POST /api/voice/speak { taskId }: a finished job's answer, read aloud, as MP3. It reads only the answer of a job
// the caller may read (the job's claim token, or the key of a wallet that is party to it), never text sent in, so it
// cannot be used to have anything else spoken. A reading is made once and kept; hearing it again is free.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!voiceEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const ip = getClientIp(req);
    const minute = checkRateLimit(`voice-speak:${ip}`, SPEAK.perMinute, 60_000);
    if (!minute.allowed) return tooManyRequests(minute);

    const body = (await req.json().catch(() => null)) as { taskId?: unknown } | null;
    const taskId = typeof body?.taskId === "string" ? body.taskId.trim() : "";
    if (!taskId || taskId.length > 100) return apiError("VALIDATION_ERROR", "taskId is required", 400);

    const claimToken = req.headers.get("x-claim-token");
    const task = getTaskById(taskId);
    if (claimToken) {
      // a wrong token and a job that does not exist answer alike
      if (!task || !claimTokenValid(taskId, claimToken)) return apiError("FORBIDDEN", "Invalid claim token for this task", 403);
    } else {
      const auth = requireApiKey(req);
      if (!auth.ok) return auth.response;
      if (!task) return apiError("NOT_FOUND", `Task '${taskId.slice(0, 80)}' not found`, 404);
      if (!canAccessIdentity(auth.user, task.fromAgent) && !canAccessIdentity(auth.user, task.toAgent)) return apiError("FORBIDDEN", "API key does not have access to this task", 403);
    }
    if (task.status !== "completed" || !task.output?.trim()) return apiError("TASK_STATE_CONFLICT", "There is no answer to read yet.", 409);

    const { text, cut } = speakable(task.output);
    if (!text) return apiError("VALIDATION_ERROR", "There is nothing in this answer to read aloud.", 422);
    let audio = spokenBefore(text);
    if (!audio) {
      // only a new reading costs anything, so only a new reading is counted
      const day = checkRateLimit(`voice-speak-day:${ip}`, SPEAK.perDay, 86_400_000);
      if (!day.allowed) return apiError("RATE_LIMITED", "That is all the reading aloud for today from here.", 429);
      const cap = dailySpeaks();
      if (cap === 0 || !checkRateLimit("voice-speak:network", cap, 86_400_000).allowed) return apiError("RATE_LIMITED", "Voice is resting for today.", 429);
      try {
        audio = await speak(text);
      } catch (err) {
        return apiError("UPSTREAM_ERROR", err instanceof Error ? err.message : "The answer could not be read aloud.", 502);
      }
    }
    return new NextResponse(new Uint8Array(audio), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(cut ? { "X-Voice-Cut": "1" } : {}),
      },
    });
  });
}

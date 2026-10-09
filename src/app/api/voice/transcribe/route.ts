import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { readCapped } from "@/lib/agentFiles";
import { voiceEnabled, sniffAudio, transcribe, dailyListens, LISTEN } from "@/lib/agentVoice";

export const runtime = "nodejs";

// POST /api/voice/transcribe: a short recording in, its words out. The body is the recording itself. Nothing is
// kept: the recording is read once and dropped, and the words go back to the page for the person to check before
// they hire anyone with them.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!voiceEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const ip = getClientIp(req);
    const minute = checkRateLimit(`voice-listen:${ip}`, LISTEN.perMinute, 60_000);
    if (!minute.allowed) return tooManyRequests(minute);

    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > LISTEN.maxBytes) return apiError("VALIDATION_ERROR", `A recording is at most ${LISTEN.maxSeconds} seconds.`, 413);
    const bytes = await readCapped(req.body, LISTEN.maxBytes);
    if (!bytes) return apiError("VALIDATION_ERROR", `A recording is at most ${LISTEN.maxSeconds} seconds.`, 413);
    const kind = sniffAudio(bytes);
    if (!kind) return apiError("VALIDATION_ERROR", "That is not a recording this can read.", 415);

    // counted only once it is a real recording, so a bad request does not use up the day
    const day = checkRateLimit(`voice-listen-day:${ip}`, LISTEN.perDay, 86_400_000);
    if (!day.allowed) return apiError("RATE_LIMITED", "That is all the talking for today from here. Type it instead.", 429);
    const cap = dailyListens();
    if (cap === 0 || !checkRateLimit("voice-listen:network", cap, 86_400_000).allowed) return apiError("RATE_LIMITED", "Voice is resting for today. Type it instead.", 429);

    try {
      const text = await transcribe(bytes, kind);
      if (!text) return apiError("VALIDATION_ERROR", "Nothing was heard. Try again a little closer to the microphone.", 422);
      return NextResponse.json({ text }, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      return apiError("UPSTREAM_ERROR", err instanceof Error ? err.message : "That could not be written down. Try again, or type it.", 502);
    }
  });
}

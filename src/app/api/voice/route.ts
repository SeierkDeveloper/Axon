import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { voiceEnabled, LISTEN, SPEAK } from "@/lib/agentVoice";

export const runtime = "nodejs";

// GET /api/voice: whether voice is on here, and its limits. A page asks this before it shows a microphone or a
// Listen button, so with voice off (404) nothing about it appears anywhere.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!voiceEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    return NextResponse.json(
      { listen: { maxBytes: LISTEN.maxBytes, maxSeconds: LISTEN.maxSeconds }, speak: { maxChars: SPEAK.maxChars } },
      { headers: { "Cache-Control": "public, max-age=60" } },
    );
  });
}

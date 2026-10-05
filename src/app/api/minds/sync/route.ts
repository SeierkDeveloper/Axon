import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { indexMinds } from "@/lib/mindsIndex";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// POST /api/minds/sync: read the launcher's events now rather than at the worker's next turn. The launch screen calls
// it when a launch confirms, so the token and its agent are there when the creator looks. It only reads the chain; one
// pass runs at a time and no more often than every few seconds, whoever asks.
let running: Promise<unknown> | null = null;
let lastAt = 0;
const MIN_GAP_MS = 3_000;

export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    if (!running && Date.now() - lastAt >= MIN_GAP_MS) {
      lastAt = Date.now();
      running = indexMinds().catch((err) => logger.warn("minds.sync_failed", "Reading the launcher's events on request failed", { err })).finally(() => { running = null; });
    }
    if (running) await running;
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  });
}

import { NextRequest } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { callerOf } from "@/lib/myloCaller";
import { runTurn, type MyloEvent } from "@/lib/myloChat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/mylo/chat { text, conversationId? }: one message to Mylo. The answer streams back as it is written, one
// JSON event per line (see MyloEvent): which conversation, how the face looks, the text, then done or an error.
// One message at a time per person: a second, while the first is still being answered, is turned away.
const inFlight = new Set<string>();

export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    const body = (await req.json().catch(() => null)) as { text?: unknown; conversationId?: unknown } | null;
    if (typeof body?.text !== "string") return apiError("VALIDATION_ERROR", "text is needed", 400);
    const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
    if (inFlight.has(caller.limitKey)) return apiError("CONFLICT", "Mylo is still answering your last message", 409);

    inFlight.add(caller.limitKey);
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (e: MyloEvent) => { try { controller.enqueue(enc.encode(`${JSON.stringify(e)}\n`)); } catch { /* the page went away */ } };
        try {
          await runTurn({ owner: caller.owner, limitKey: caller.limitKey, wallet: caller.wallet, speaker: caller.speaker, text: body.text as string, conversationId }, emit);
        } finally {
          inFlight.delete(caller.limitKey);
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  });
}

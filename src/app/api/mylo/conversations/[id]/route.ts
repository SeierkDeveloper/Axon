import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { callerOf } from "@/lib/myloCaller";
import { getConversation, historyOf } from "@/lib/myloStore";
import { actionsOf, viewOf } from "@/lib/myloActions";

export const runtime = "nodejs";

// GET /api/mylo/conversations/:id: one of the caller's conversations, what was said in it. Anyone else's is not found.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    const { id } = await params;
    const conv = getConversation(id, caller.owner);
    if (!conv) return apiError("NOT_FOUND", "No such conversation", 404);
    // each of Mylo's messages with the cards it showed and the proposals it made, as they stand now
    const actions = new Map(actionsOf(id, caller.owner).map((a) => [a.id, viewOf(a)]));
    const messages = historyOf(id, 200).filter((m) => m.role === "user" || m.role === "assistant").map(({ id, role, content, createdAt, meta }) => {
      const m = (meta ?? {}) as { cards?: unknown[]; actionIds?: string[] };
      return { id, role, content, createdAt, cards: m.cards ?? [], actions: (m.actionIds ?? []).map((a) => actions.get(a)).filter(Boolean) };
    });
    return NextResponse.json({ conversation: { id: conv.id, title: conv.title }, messages }, { headers: { "Cache-Control": "no-store" } });
  });
}

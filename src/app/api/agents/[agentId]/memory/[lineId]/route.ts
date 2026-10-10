import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { apiError } from "@/lib/apiError";
import { memoryFor } from "@/lib/agentMemoryHttp";
import { forget, memoryView } from "@/lib/agentMemory";

export const runtime = "nodejs";

// DELETE /api/agents/:agentId/memory/:lineId: delete one line this agent noted about you. Same permission as
// reading the memory.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ agentId: string; lineId: string }> }) {
  return withRequestContext(req, async () => {
    const { agentId, lineId } = await params;
    const who = memoryFor(req, agentId);
    if ("response" in who) return who.response;
    if (!forget(who.owner, who.agentId, lineId)) return apiError("NOT_FOUND", "No such line in this memory", 404);
    return NextResponse.json({ forgotten: 1, ...memoryView(who.owner, who.agentId) }, { headers: { "Cache-Control": "no-store" } });
  });
}

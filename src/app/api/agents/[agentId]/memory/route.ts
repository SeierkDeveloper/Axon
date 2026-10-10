import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { memoryFor } from "@/lib/agentMemoryHttp";
import { forget, memoryView } from "@/lib/agentMemory";

export const runtime = "nodejs";

// GET /api/agents/:agentId/memory: what this agent remembers about you: each line it noted, and how many finished
// jobs it can recall. Yours alone: read with your API key, or with the memory key your hires used (X-Memory-Key).
export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  return withRequestContext(req, async () => {
    const who = memoryFor(req, (await params).agentId);
    if ("response" in who) return who.response;
    return NextResponse.json(memoryView(who.owner, who.agentId), { headers: { "Cache-Control": "private, no-store" } });
  });
}

// DELETE /api/agents/:agentId/memory: have this agent forget you. Every line goes, and it is no longer reminded of
// the jobs it did for you. The jobs themselves and their receipts are not touched.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  return withRequestContext(req, async () => {
    const who = memoryFor(req, (await params).agentId);
    if ("response" in who) return who.response;
    return NextResponse.json({ forgotten: forget(who.owner, who.agentId), ...memoryView(who.owner, who.agentId) }, { headers: { "Cache-Control": "no-store" } });
  });
}

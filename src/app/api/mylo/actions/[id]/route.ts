import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { callerOf } from "@/lib/myloCaller";
import { advanceCrew, refreshAction, staleHires, viewOf } from "@/lib/myloActions";

export const runtime = "nodejs";

// GET /api/mylo/actions/:id: where one of the caller's proposals has got to. Once every hire has finished, their
// answers are written into the conversation (once) and returned as `message`. While it waits, `stale` names any agent
// whose price moved or who left since, so the page can stop before anyone pays.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    const id = (await params).id;
    await advanceCrew(id, caller.owner); // a crew moves to its next step as soon as the one before has finished
    const r = refreshAction(id, caller.owner);
    if (typeof r === "string") return apiError("NOT_FOUND", r, 404);
    return NextResponse.json({ action: viewOf(r.action), tasks: r.tasks.map(({ agentId, status, error }) => ({ agentId, status, error })), message: r.message, stale: r.action.status === "proposed" ? staleHires(r.action) : [] }, { headers: { "Cache-Control": "no-store" } });
  });
}

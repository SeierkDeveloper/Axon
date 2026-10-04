import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { callerOf } from "@/lib/myloCaller";
import { cancelAction, viewOf } from "@/lib/myloActions";

export const runtime = "nodejs";

// POST /api/mylo/actions/:id/cancel: the caller turns down one of their proposals. Nothing was spent; nothing runs.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    const r = cancelAction((await params).id, caller.owner);
    if (typeof r === "string") return apiError("CONFLICT", r, 409);
    return NextResponse.json({ action: viewOf(r) }, { headers: { "Cache-Control": "no-store" } });
  });
}

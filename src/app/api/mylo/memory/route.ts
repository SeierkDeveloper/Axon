import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { callerOf } from "@/lib/myloCaller";
import { forget, memoryOf } from "@/lib/myloStore";

export const runtime = "nodejs";

// GET /api/mylo/memory: everything Mylo remembers about the signed-in wallet. DELETE { key? }: forget that one, or all.
// A wallet's memory is its own: nobody else can read it, and its owner can always clear it.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    if (!caller.wallet) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    return NextResponse.json({ facts: memoryOf(caller.wallet) }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function DELETE(req: NextRequest) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    if (!caller.wallet) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const body = (await req.json().catch(() => ({}))) as { key?: unknown };
    const n = forget(caller.wallet, typeof body.key === "string" && body.key.trim() ? body.key : undefined);
    return NextResponse.json({ forgot: n, facts: memoryOf(caller.wallet) });
  });
}

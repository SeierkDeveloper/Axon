import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { callerOf } from "@/lib/myloCaller";
import { inboxOf, markRead, unreadCount } from "@/lib/myloStore";

export const runtime = "nodejs";

// GET /api/mylo/inbox: what Mylo noticed for the signed-in wallet, newest first, and how many are unread.
// POST /api/mylo/inbox { ids? }: mark those (or all) read. A wallet's notices are its own.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    if (!caller.wallet) return NextResponse.json({ notices: [], unread: 0 }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ notices: inboxOf(caller.wallet, false, 30), unread: unreadCount(caller.wallet) }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    if (!caller.wallet) return apiError("FORBIDDEN", "Sign in with a wallet", 403);
    const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 100) : undefined;
    return NextResponse.json({ marked: markRead(caller.wallet, ids), unread: unreadCount(caller.wallet) });
  });
}

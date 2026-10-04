import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { callerOf } from "@/lib/myloCaller";
import { conversationsOf, sentToday } from "@/lib/myloStore";
import { MESSAGES_PER_DAY } from "@/lib/myloPolicy";

export const runtime = "nodejs";

// GET /api/mylo/conversations: the caller's recent conversations with Mylo, newest first, and how much of today's
// limit is left.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const caller = await callerOf(req);
    if (!caller.ok) return caller.response;
    const cap = MESSAGES_PER_DAY[caller.speaker];
    return NextResponse.json(
      { conversations: conversationsOf(caller.owner).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })), signedIn: Boolean(caller.wallet), left: Math.max(0, cap - sentToday(caller.limitKey)), perDay: cap },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

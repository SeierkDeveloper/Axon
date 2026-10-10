import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { apiError } from "@/lib/apiError";
import { libraryFor } from "@/lib/libraryHttp";
import { conversationOf, removeConversation } from "@/lib/library";

export const runtime = "nodejs";

// GET /api/library/:thread: one conversation in full, oldest turn first: what was asked and answered, the files
// each turn handed back (with the token that downloads each), the job's receipt, and for each job the claimToken
// that reads it again and follows it up. A conversation that is not yours answers exactly as one that is not there.
export async function GET(req: NextRequest, { params }: { params: Promise<{ thread: string }> }) {
  return withRequestContext(req, async () => {
    const who = libraryFor(req);
    if ("response" in who) return who.response;
    const found = conversationOf(who.owners, (await params).thread);
    if (!found) return apiError("NOT_FOUND", "No such conversation in your library", 404);
    return NextResponse.json(found, { headers: { "Cache-Control": "private, no-store" } });
  });
}

// DELETE /api/library/:thread: take a conversation out of your library. Its jobs and their receipts are not touched.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ thread: string }> }) {
  return withRequestContext(req, async () => {
    const who = libraryFor(req);
    if ("response" in who) return who.response;
    const removed = removeConversation(who.owners, (await params).thread);
    if (!removed) return apiError("NOT_FOUND", "No such conversation in your library", 404);
    return NextResponse.json({ removed }, { headers: { "Cache-Control": "no-store" } });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { libraryFor } from "@/lib/libraryHttp";
import { conversationsOf, filesOf } from "@/lib/library";

export const runtime = "nodejs";

// GET /api/library: your conversations with agents, the latest first: who worked on each, how it began, where it
// stands, and how many files came back. ?agent=<id> keeps those an agent worked on. ?view=files lists the files
// instead: every file handed back to you, the latest version of each. Yours alone: your API key, or the key your
// hires used (X-Memory-Key), or both.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const who = libraryFor(req);
    if ("response" in who) return who.response;
    const q = req.nextUrl.searchParams, n = Number.parseInt(q.get("limit") ?? "", 10);
    const limit = Number.isFinite(n) ? { limit: n } : {};
    const body = q.get("view") === "files"
      ? { files: filesOf(who.owners, limit) }
      : { conversations: conversationsOf(who.owners, { agentId: q.get("agent"), ...limit }) };
    return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { fileFor } from "@/lib/agentFilesHttp";
import { versionsOf } from "@/lib/revisions";

export const runtime = "nodejs";

// GET /api/files/:fileId/versions: every version of a file that is still stored, oldest first, each with the token
// and path that download it. A file that was never revised is the one version of itself. Same permission as reading
// the file: whoever may read one version may read the others, since one person hired every job of the conversation.
export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  return withRequestContext(req, async () => {
    const r = await fileFor(req, (await params).fileId);
    if ("response" in r) return r.response;
    return NextResponse.json({ versions: versionsOf(r.file) }, { headers: { "Cache-Control": "private, no-store" } });
  });
}

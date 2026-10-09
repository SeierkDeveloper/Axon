import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { readBytes } from "@/lib/agentFiles";
import { fileFor } from "@/lib/agentFilesHttp";

export const runtime = "nodejs";

// GET /api/files/:fileId/content: the file itself. It is always a download, never a page: it goes out with the type
// its bytes really are, as an attachment, under a sandbox policy, so nothing uploaded can run in a browser here.
export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  return withRequestContext(req, async () => {
    const r = await fileFor(req, (await params).fileId);
    if ("response" in r) return r.response;
    const bytes = readBytes(r.file);
    if (!bytes) return apiError("NOT_FOUND", "This file is no longer stored", 404);
    // an ASCII name for old clients and the real one, encoded, for the rest
    const ascii = r.file.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": r.file.mime,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(r.file.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
        ETag: `"${r.file.sha256}"`,
      },
    });
  });
}

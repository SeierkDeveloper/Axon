import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { deleteFile, toView } from "@/lib/agentFiles";
import { fileFor } from "@/lib/agentFilesHttp";

export const runtime = "nodejs";

// GET /api/files/:fileId: what a file is (name, type, size, hash, when it goes). For the wallet that uploaded it, or
// anyone holding the file's token (X-File-Token, or ?token=).
export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  return withRequestContext(req, async () => {
    const r = await fileFor(req, (await params).fileId);
    if ("response" in r) return r.response;
    return NextResponse.json({ file: toView(r.file) }, { headers: { "Cache-Control": "private, no-store" } });
  });
}

// DELETE /api/files/:fileId: remove a file now instead of waiting for it to expire. Same permission as reading it.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  return withRequestContext(req, async () => {
    const r = await fileFor(req, (await params).fileId);
    if ("response" in r) return r.response;
    deleteFile(r.file.id);
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  });
}

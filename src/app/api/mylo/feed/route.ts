import { NextRequest, NextResponse } from "next/server";
import { withRequestContext } from "@/lib/withRequestContext";
import { feed } from "@/lib/myloStore";

export const runtime = "nodejs";

// GET /api/mylo/feed?limit=&before=: Mylo thinking in public, newest first. Anyone may read it; it names nobody.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const u = new URL(req.url);
    const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 20, 1), 50);
    const before = u.searchParams.get("before");
    const items = feed(limit, before && !Number.isNaN(Date.parse(before)) ? before : undefined);
    return NextResponse.json({ items: items.map(({ id, kind, text, link, createdAt }) => ({ id, kind, text, link, at: createdAt })) }, { headers: { "Cache-Control": "public, max-age=15" } });
  });
}

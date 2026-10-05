import { NextRequest, NextResponse } from "next/server";
import { getLogo } from "@/lib/mindsLogo";

export const runtime = "nodejs";

// GET /api/minds/logo/:id: a token's picture. The id is the hash of its bytes, so what is behind a link never changes.
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const logo = getLogo((await ctx.params).id);
  if (!logo) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(logo.bytes), {
    headers: { "Content-Type": logo.mime, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'", "Access-Control-Allow-Origin": "*" },
  });
}

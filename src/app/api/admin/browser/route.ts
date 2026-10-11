import { NextRequest, NextResponse } from "next/server";
import { browserStatus } from "@/lib/browserSession";
import { browserSelfTest } from "@/lib/browserSelfTest";
import { checkBrowserUrl } from "@/lib/agentBrowser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/browser            what this server can say about its browser, without starting one
// GET /api/admin/browser?test=1     start it, open a public page, and try everything it must not be able to reach
// GET /api/admin/browser?test=1&shot=1   the same, answered with the picture it took of the page
//     &url=https://…                the public page to open instead of the usual one
//
// Admin-gated on the same secret the crons use. The check calls no model. It exists so that "the browser cannot
// reach this server" is something measured on the server itself, not something believed.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const q = req.nextUrl.searchParams;
  if (q.get("test") !== "1") return NextResponse.json(browserStatus());

  const raw = q.get("url");
  let url: string | undefined;
  if (raw) {
    const checked = checkBrowserUrl(raw);
    if (!checked.ok) return NextResponse.json({ error: checked.reason }, { status: 400 });
    url = checked.url;
  }
  const { shot, ...result } = await browserSelfTest({ url });
  if (q.get("shot") === "1" && shot) {
    return new NextResponse(new Uint8Array(shot), { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-axon-browser-ok": String(result.ok) } });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

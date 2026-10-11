import { NextRequest, NextResponse } from "next/server";
import { browserStatus } from "@/lib/browserSession";
import { browserSelfTest } from "@/lib/browserSelfTest";
import { checkBrowserUrl } from "@/lib/agentBrowser";
import { browserTool } from "@/lib/browserTool";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/browser            what this server can say about its browser, without starting one
// GET /api/admin/browser?test=1     start it, open a public page, and try everything it must not be able to reach
// GET /api/admin/browser?test=1&shot=1   the same, answered with the picture it took of the page
//     &url=https://…                the public page to open instead of the usual one
// GET /api/admin/browser?test=1&view=1&url=…   what an agent's browser tool is shown of that page
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
  // &view=1: what an agent's browser tool is shown of that page (no model is asked; one step of one browser)
  if (q.get("view") === "1") {
    const b = browserTool({ taskId: "admin-view", paid: true });
    try {
      return new NextResponse(await b.tool.run({ action: "open", url: url ?? "https://example.com/" }), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 502 });
    } finally {
      await b.close();
    }
  }
  const { shot, ...result } = await browserSelfTest({ url });
  if (q.get("shot") === "1" && shot) {
    return new NextResponse(new Uint8Array(shot), { headers: { "content-type": "image/jpeg", "cache-control": "no-store", "x-axon-browser-ok": String(result.ok) } });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

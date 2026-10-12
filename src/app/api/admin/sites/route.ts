import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { filesOf, getSite, hideSite, newestSites, reportedSites, restoreSite, siteLimits, siteStats, sitesEnabled } from "@/lib/agentSites";
import { dailyBuilds } from "@/lib/buildTool";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

// /api/admin/sites: the admin's view of what agents have built, and the switch to take a built page down or put it
// back. Gated on the same secret the crons use, like the other admin routes.
//   GET                              what the store holds, the limits, the newest sites, and the pages people reported
//                                    or that are down; with ?site=<id>, one site's files
//   POST { action, siteId, reason? } hide (takes it down at once) or restore
// A page that is down shows nothing to anybody; nothing is deleted, so a mistake can be put right.
function allowed(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // ?site=<id>: one site's files as they are kept (the names and sizes, and the page that opens as text), to look
  // at what an agent built
  const one = req.nextUrl.searchParams.get("site");
  if (one) {
    const site = getSite(one);
    if (!site) return NextResponse.json({ error: "There is no such site" }, { status: 404 });
    const files = filesOf(one);
    return NextResponse.json({ site, files: files.map((f) => ({ path: f.path, mime: f.mime, bytes: f.bytes, sha256: f.sha256 })), index: files.find((f) => f.path === "index.html")?.content.toString("utf8") ?? null }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ enabled: sitesEnabled(), limits: { ...siteLimits(), buildsPerDay: dailyBuilds() }, stats: siteStats(), newest: newestSites(), reported: reportedSites() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  if (!allowed(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { action?: string; siteId?: string; reason?: string } | null;
  const siteId = typeof body?.siteId === "string" ? body.siteId : "";
  if (!siteId || !getSite(siteId)) return NextResponse.json({ error: "There is no such site" }, { status: 404 });
  if (body?.action === "hide") {
    const done = hideSite(siteId, `moderator: ${typeof body.reason === "string" && body.reason.trim() ? body.reason : "taken down"}`);
    logger.info("sites.admin_hide", "A moderator took a built page down", { siteId, done });
    return NextResponse.json({ ok: true, changed: done, site: getSite(siteId) });
  }
  if (body?.action === "restore") {
    const done = restoreSite(siteId);
    logger.info("sites.admin_restore", "A moderator put a built page back", { siteId, done });
    return NextResponse.json({ ok: true, changed: done, site: getSite(siteId) });
  }
  return NextResponse.json({ error: "action must be hide or restore" }, { status: 400 });
}

// Agents that build, phase 0: the admin's view of built pages and the switch to take one down or put it back.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { addVersion, createSite, filesOf, getSite, reportSite } from "@/lib/agentSites";
import { GET, POST } from "@/app/api/admin/sites/route";

const SECRET = "test-cron-secret";
const req = (method: string, body?: unknown, auth = `Bearer ${SECRET}`) =>
  new NextRequest("http://localhost/api/admin/sites", { method, headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  getDb().exec("DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites;");
});
afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });

function built(taskId = "t1"): string {
  const m = createSite({ taskId, agentId: "agent-1", ownerMark: "0xabc", title: "Tip calculator" });
  if (!m.ok) throw new Error(m.why);
  addVersion(m.site.siteId, [{ path: "index.html", content: "<h1>Tips</h1>" }], { taskId });
  return m.site.siteId;
}

describe("/api/admin/sites", () => {
  it("answers nobody without the secret, and nobody at all when no secret is set", async () => {
    expect((await GET(req("GET", undefined, ""))).status).toBe(401);
    expect((await GET(req("GET", undefined, "Bearer wrong"))).status).toBe(401);
    expect((await POST(req("POST", { action: "hide", siteId: "x" }, "Bearer wrong"))).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await GET(req("GET"))).status).toBe(401);
  });

  it("shows what the store holds, the limits, and the pages people reported", async () => {
    const a = built(), b = built("t2");
    reportSite(a, { reason: "scam", reporter: "1" });
    const body = (await (await GET(req("GET"))).json()) as { enabled: boolean; limits: { files: number; buildsPerDay: number }; stats: { sites: number; live: number }; newest: { siteId: string; files: number; bytes: number }[]; reported: { site: { siteId: string }; reports: number }[] };
    expect(body.enabled).toBe(false);
    expect(body.limits).toMatchObject({ files: 12, buildsPerDay: 200 });
    expect(body.stats).toMatchObject({ sites: 2, live: 2, hidden: 0, reported: 1 });
    expect(body.reported.map((r) => [r.site.siteId, r.reports])).toEqual([[a, 1]]);
    // the newest sites, whoever built them, with what the version shown holds
    expect(body.newest.map((n) => n.siteId).sort()).toEqual([a, b].sort());
    expect(body.newest[0]).toMatchObject({ files: 1, bytes: 13 });
  });

  it("shows one site's files as they are kept, so what an agent built can be looked at", async () => {
    const id = built();
    const one = new NextRequest(`http://localhost/api/admin/sites?site=${id}`, { headers: { authorization: `Bearer ${SECRET}` } });
    const body = (await (await GET(one)).json()) as { site: { title: string }; files: { path: string; mime: string; bytes: number }[]; index: string };
    expect(body.site.title).toBe("Tip calculator");
    expect(body.files).toEqual([expect.objectContaining({ path: "index.html", mime: "text/html", bytes: 13 })]);
    expect(body.index).toBe("<h1>Tips</h1>");
    expect((await GET(new NextRequest("http://localhost/api/admin/sites?site=nope", { headers: { authorization: `Bearer ${SECRET}` } }))).status).toBe(404);
    expect((await GET(new NextRequest(`http://localhost/api/admin/sites?site=${id}`))).status).toBe(401);
  });

  it("takes a page down at once and puts it back", async () => {
    const id = built();
    const down = (await (await POST(req("POST", { action: "hide", siteId: id, reason: "a fake giveaway" }))).json()) as { changed: boolean; site: { status: string; hiddenReason: string } };
    expect(down).toMatchObject({ changed: true, site: { status: "hidden", hiddenReason: "moderator: a fake giveaway" } });
    expect(filesOf(id)).toEqual([]);
    expect(((await (await POST(req("POST", { action: "hide", siteId: id }))).json()) as { changed: boolean }).changed).toBe(false);
    const up = (await (await POST(req("POST", { action: "restore", siteId: id }))).json()) as { changed: boolean; site: { status: string } };
    expect(up).toMatchObject({ changed: true, site: { status: "live" } });
    expect(filesOf(id)).toHaveLength(1);
    expect(getSite(id)!.hiddenReason).toBeNull();
  });

  it("refuses a site that is not there and an action it does not know", async () => {
    expect((await POST(req("POST", { action: "hide", siteId: "nope" }))).status).toBe(404);
    expect((await POST(req("POST", { action: "hide" }))).status).toBe(404);
    expect((await POST(req("POST", { action: "delete", siteId: built() }))).status).toBe(400);
  });
});

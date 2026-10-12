// Agents that build, phase 2: the page a built site opens on, its address, and reporting it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { addVersion, createSite, getSite, hideSite, siteViewOf, type SiteFileIn } from "@/lib/agentSites";
import { SEAL_HOLDER_POLICY, SEAL_POLICY, SEAL_SANDBOX } from "@/lib/siteSeal";
import { goneHtml, sitePath, viewerHeaders, VIEWER_POLICY, viewSite } from "@/lib/siteViewer";
import { GET as openSite } from "@/app/s/[siteId]/route";
import { POST as report } from "@/app/api/sites/[siteId]/report/route";

const saved = process.env.AGENT_SITES, savedProxy = process.env.TRUST_PROXY_HEADERS;
beforeEach(() => {
  process.env.AGENT_SITES = "on";
  // as on the host, where the proxy in front says who is calling
  process.env.TRUST_PROXY_HEADERS = "true";
  getDb().exec("DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_SITES; else process.env.AGENT_SITES = saved;
  if (savedProxy === undefined) delete process.env.TRUST_PROXY_HEADERS; else process.env.TRUST_PROXY_HEADERS = savedProxy;
});

function built(files: SiteFileIn[] = [{ path: "index.html", content: "<h1>Tips</h1>" }], o: { taskId?: string; title?: string } = {}): string {
  const m = createSite({ taskId: o.taskId ?? "t1", agentId: "deep-dive-ai", ownerMark: "0xabc", title: o.title ?? "Tip calculator" });
  if (!m.ok) throw new Error(m.why);
  const kept = addVersion(m.site.siteId, files, { taskId: o.taskId ?? "t1" });
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  return m.site.siteId;
}
const open = (id: string) => openSite(new NextRequest(`http://localhost/s/${id}`), { params: Promise.resolve({ siteId: id }) });
const send = (id: string, body: unknown, ip = "9.9.9.9") => report(new NextRequest(`http://localhost/api/sites/${id}/report`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }), { params: Promise.resolve({ siteId: id }) });
/** The data the page's script is handed. */
const dataOf = (html: string) => JSON.parse(/<script type="application\/json" id="d">([\s\S]*?)<\/script>/.exec(html)![1]) as { pages: Record<string, string>; report: string };

describe("the policy the page is sent with", () => {
  it("holds the third part of the seal, lets nobody frame it, and loads nothing from anywhere else", () => {
    const rules = Object.fromEntries(VIEWER_POLICY.split("; ").map((r) => [r.split(" ")[0], r.split(" ").slice(1).join(" ")]));
    expect(VIEWER_POLICY).toContain(SEAL_HOLDER_POLICY);
    expect(rules["frame-src"]).toBe("'none'");
    expect(rules["frame-ancestors"]).toBe("'none'");
    expect(rules["default-src"]).toBe("'none'");
    expect(rules["connect-src"]).toBe("'self'");
    expect(rules["form-action"]).toBe("'none'");
    expect(rules["base-uri"]).toBe("'none'");
    expect(VIEWER_POLICY).not.toMatch(/https?:|\*|unsafe-eval|wss?:/);
    const h = viewerHeaders();
    expect(h["Content-Security-Policy"]).toBe(VIEWER_POLICY);
    expect(h).toMatchObject({ "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  });
});

describe("the page a built site opens on", () => {
  it("shows the built page sealed, under a bar that says what it is and who built it", () => {
    const id = built([{ path: "index.html", content: '<link rel="stylesheet" href="style.css"><h1>Tips</h1>' }, { path: "style.css", content: "h1{color:#111}" }]);
    const seen = viewSite(id);
    expect(seen.status).toBe(200);
    expect(seen.html).toContain(`<iframe id="f" sandbox="${SEAL_SANDBOX}" referrerpolicy="no-referrer"`);
    expect(seen.html).toContain('<span class="title">Tip calculator</span>');
    expect(seen.html).toMatch(/Built by <\/span><span class="short">by <\/span><a href="\/agents\/deep-dive-ai">[^<]+<\/a><span class="long"> on Axon/);
    expect(seen.html).toContain('<button id="rb" type="button">Report</button>');
    expect(seen.html).toContain("<title>Tip calculator · built on Axon</title>");
    const data = dataOf(seen.html);
    expect(data.report).toBe(`/api/sites/${id}/report`);
    // the page handed to the frame is whole (its style sheet is inside it) and begins with the seal's policy
    expect(data.pages["index.html"].startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${SEAL_POLICY}">`)).toBe(true);
    expect(data.pages["index.html"]).toContain("<style>h1{color:#111}</style><h1>Tips</h1>");
  });

  it("hands every page of the site over, each sealed", () => {
    const id = built([{ path: "index.html", content: '<a href="about.html">About</a>' }, { path: "about.html", content: "<h1>About</h1>" }, { path: "data.json", content: "{}" }]);
    const pages = dataOf(viewSite(id).html).pages;
    expect(Object.keys(pages)).toEqual(["index.html", "about.html"]);
    for (const html of Object.values(pages)) expect(html).toContain(SEAL_POLICY);
  });

  it("never lets a built page or its title become markup of the page around it", () => {
    const id = built([{ path: "index.html", content: '<h1>x</h1></script><script>window.pwned=1</script><!-- <img src=x onerror=alert(1)>' }], { title: '</span><script>alert(1)</script> & "quotes"' });
    const html = viewSite(id).html;
    // outside the data block there are exactly the two scripts this page writes itself
    const outside = html.replace(/<script type="application\/json" id="d">[\s\S]*?<\/script>/, "");
    expect(outside.match(/<script/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;/span&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;");
    // and the data still reads back as what was built
    expect(dataOf(html).pages["index.html"]).toContain("</script><script>window.pwned=1</script>");
  });

  it("says so where there is nothing to show", () => {
    expect(viewSite("no-such-site")).toMatchObject({ status: 404 });
    const empty = createSite({ taskId: "t9", agentId: "a", ownerMark: null, title: "Empty" });
    expect(empty.ok && viewSite(empty.site.siteId).status).toBe(404);
    const id = built();
    hideSite(id, "moderator: a fake giveaway");
    const down = viewSite(id);
    expect(down.status).toBe(410);
    expect(down.html).toContain("This page was taken down");
    expect(down.html).not.toContain("<iframe");
    expect(down.html).not.toContain("giveaway");
    expect(goneHtml("missing")).toContain("Nothing is here");
    expect(sitePath("abc")).toBe("/s/abc");
  });
});

describe("the address", () => {
  it("answers with the page and the policy, whatever it has to show", async () => {
    const id = built();
    const ok = await open(id);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toBe(VIEWER_POLICY);
    expect(ok.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await ok.text()).toContain('<iframe id="f"');
    for (const bad of ["nope-nope-nope", "x", "../../etc/passwd", "a".repeat(60)]) {
      const r = await open(bad);
      expect(r.status).toBe(404);
      expect(r.headers.get("content-security-policy")).toBe(VIEWER_POLICY);
    }
    hideSite(id, "x");
    expect((await open(id)).status).toBe(410);
  });

  it("is not there at all while building is off", async () => {
    const id = built();
    delete process.env.AGENT_SITES;
    expect((await open(id)).status).toBe(404);
    expect((await send(id, { reason: "scam" })).status).toBe(404);
  });
});

describe("what a job's reader is told", () => {
  it("is the address to open, and which version this job made", () => {
    const id = built();
    expect(siteViewOf("t1", "https://axon-agents.com/")).toEqual({ siteId: id, title: "Tip calculator", version: 1, url: `https://axon-agents.com/s/${id}` });
    expect(siteViewOf("t1")).toMatchObject({ url: `/s/${id}` });
    // a later job that changed it is told about the same site, at its own version
    addVersion(id, [{ path: "index.html", content: "<h1>Two</h1>" }], { taskId: "t2", title: "Tips, darker" });
    expect(siteViewOf("t2", "https://a.example")).toEqual({ siteId: id, title: "Tips, darker", version: 2, url: `https://a.example/s/${id}` });
    expect(siteViewOf("t1")!.version).toBe(1);
    expect(siteViewOf("t3")).toBeNull();
    const empty = createSite({ taskId: "t4", agentId: "a", ownerMark: null, title: "Empty" });
    expect(empty.ok && siteViewOf("t4")).toBeNull();
    hideSite(id, "x");
    expect(siteViewOf("t1")).toBeNull();
  });
});

describe("reporting a built page", () => {
  it("takes a report from anybody, counts a person once, and hides the page when three have", async () => {
    const id = built();
    const one = await send(id, { reason: "scam", details: "asks for money" }, "1.1.1.1");
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual({ ok: true, hidden: false });
    expect(await (await send(id, { reason: "scam" }, "1.1.1.1")).json()).toEqual({ ok: true, hidden: false });
    expect(await (await send(id, { reason: "harmful" }, "2.2.2.2")).json()).toEqual({ ok: true, hidden: false });
    expect(await (await send(id, { reason: "impersonation" }, "3.3.3.3")).json()).toEqual({ ok: true, hidden: true });
    expect(getSite(id)!.status).toBe("hidden");
    expect((await open(id)).status).toBe(410);
  });

  it("asks for a reason it knows, and for a page that exists", async () => {
    const id = built();
    expect((await send(id, { reason: "boring" })).status).toBe(400);
    expect((await send(id, {})).status).toBe(400);
    expect((await send("no-such-site", { reason: "scam" })).status).toBe(404);
  });

  it("lets one address report only a few times an hour", async () => {
    const id = built();
    for (let i = 0; i < 5; i++) expect((await send(id, { reason: "scam" }, "7.7.7.7")).status).toBe(200);
    expect((await send(id, { reason: "scam" }, "7.7.7.7")).status).toBe(429);
    expect((await send(id, { reason: "scam" }, "8.8.8.8")).status).toBe(200);
  });
});

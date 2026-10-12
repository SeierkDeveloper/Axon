// Agents that build, phase 3: change it by talking. A follow-up works on the page the conversation already built, the
// agent is shown its files as they are, and whoever hired the job sees the versions and can show an earlier one again.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { addVersion, createSite, filesOf, getSite, hideSite, siteOfTasks, type SiteFileIn } from "@/lib/agentSites";
import { builtSoFar, buildTool, SHOWN_CHARS } from "@/lib/buildTool";
import { createTask } from "@/lib/tasks";
import { claimTokenFor } from "@/lib/mcpServer";
import { viewSite } from "@/lib/siteViewer";
import { GET as readSite, POST as showAgain } from "@/app/api/tasks/[taskId]/site/route";
import { GET as openSite } from "@/app/s/[siteId]/route";

const saved = process.env.AGENT_SITES;
beforeEach(() => {
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM built_site_reports; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows; DELETE FROM tasks;");
});
afterEach(() => { if (saved === undefined) delete process.env.AGENT_SITES; else process.env.AGENT_SITES = saved; });

const page = (body: string): SiteFileIn => ({ path: "index.html", content: `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body>${body}</body></html>` });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30, 3)]);
const job = (task = "Build me a tip calculator") => createTask({ fromAgent: "buyer", toAgent: "deep-dive-ai", task, initialStatus: "running", startedBy: "worker" }).taskId;
function built(taskId: string, files: SiteFileIn[] = [page("<h1>One</h1>"), { path: "style.css", content: "h1{color:#333}" }]): string {
  const m = createSite({ taskId, agentId: "deep-dive-ai", ownerMark: "0xabc", title: "Tip calculator" });
  if (!m.ok) throw new Error(m.why);
  const kept = addVersion(m.site.siteId, files, { taskId, note: "a tip calculator" });
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  return m.site.siteId;
}
const as = (taskId: string, init: { method?: string; body?: unknown; claim?: string | null } = {}) =>
  new NextRequest(`http://localhost/api/tasks/${taskId}/site`, { method: init.method ?? "GET", headers: { ...(init.claim === null ? {} : { "x-claim-token": init.claim ?? claimTokenFor(taskId) }), "content-type": "application/json" }, ...(init.body ? { body: JSON.stringify(init.body) } : {}) });
const ctx = (taskId: string) => ({ params: Promise.resolve({ taskId }) });

describe("the page a conversation has built", () => {
  it("is the newest live one any of its turns built or changed", () => {
    const a = built("t1");
    expect(siteOfTasks(["t1"])!.siteId).toBe(a);
    expect(siteOfTasks(["t0", "t1", "t2"])!.siteId).toBe(a);
    addVersion(a, [page("<h1>Two</h1>")], { taskId: "t2" });
    expect(siteOfTasks(["t2"])!.siteId).toBe(a);
    expect(siteOfTasks(["t9"])).toBeNull();
    expect(siteOfTasks([])).toBeNull();
    // a site with nothing kept in it, or one taken down, is not something to carry on
    const empty = createSite({ taskId: "t5", agentId: "a", ownerMark: null, title: "Empty" });
    expect(empty.ok && siteOfTasks(["t5"])).toBeNull();
    hideSite(a, "x");
    expect(siteOfTasks(["t1", "t2"])).toBeNull();
  });

  it("is shown to the agent file by file as it is now, so a change is made to what is there", () => {
    const id = built("t1", [page("<h1>One</h1>"), { path: "style.css", content: "h1{color:#333}" }, { path: "app.js", content: "let a = 1;" }, { path: "logo.png", content: PNG }]);
    const note = builtSoFar(id);
    expect(note).toMatch(/THE PAGE BUILT EARLIER IN THIS CONVERSATION: "Tip calculator", version 1, open at its link now\./);
    expect(note).toContain("=== index.html ===\n<!doctype html>");
    expect(note).toContain("=== style.css ===\nh1{color:#333}");
    expect(note).toContain("=== app.js ===\nlet a = 1;");
    expect(note).toMatch(/=== logo\.png === \(a picture, \d+ bytes: not shown\)/);
    expect(note.indexOf("=== index.html ===")).toBeLessThan(note.indexOf("=== app.js ==="));
    expect(note).toMatch(/call build_page with only the files you change, each given whole; the files you leave out stay as they are\. The link stays the same/);
    // after a change it shows the files of the new version
    addVersion(id, [page("<h1>Two</h1>"), { path: "style.css", content: "h1{color:#000}" }], { taskId: "t2" });
    const later = builtSoFar(id);
    expect(later).toContain("version 2");
    expect(later).toContain("h1{color:#000}");
    expect(later).not.toContain("let a = 1;");
    expect(builtSoFar("no-such-site")).toBe("");
  });

  it("names a file that is too long to show instead of showing part of it", () => {
    const id = built("t1", [page("<h1>One</h1>"), { path: "data.js", content: `const d = "${"x".repeat(SHOWN_CHARS)}";` }, { path: "style.css", content: "h1{}" }]);
    const note = builtSoFar(id);
    expect(note).toMatch(/=== data\.js === \([\d.]+ KB: too long to show here\. Change it only by giving the whole file again\.\)/);
    expect(note).toContain("=== style.css ===\nh1{}");
    expect(note.length).toBeLessThan(SHOWN_CHARS + 2000);
  });

  it("is changed by the follow-up's build: same site, same link, the files left out stay", async () => {
    const id = built("t1");
    const said = await buildTool({ taskId: "t2", agentId: "deep-dive-ai", ownerMark: "0xabc", paid: false, continueSite: id, env: { AGENT_SITES: "on" } })
      .run({ title: "Tip calculator", note: "darker heading", files: [{ path: "style.css", content: "h1{color:#000}" }] });
    expect(said).toMatch(/version 2, 2 files/);
    expect(getSite(id)!.version).toBe(2);
    const now = Object.fromEntries(filesOf(id).map((f) => [f.path, f.content.toString()]));
    expect(now["style.css"]).toBe("h1{color:#000}");
    expect(now["index.html"]).toContain("<h1>One</h1>");
    expect((getDb().prepare("SELECT COUNT(*) n FROM built_sites").get() as { n: number }).n).toBe(1);
  });
});

describe("the versions, for whoever hired the job", () => {
  it("lists every version kept, newest first, with which is shown and which this job made", async () => {
    const t1 = job(), t2 = job("make the heading darker");
    const id = built(t1);
    addVersion(id, [page("<h1>Two</h1>")], { taskId: t2, note: "darker heading" });
    const first = (await (await readSite(as(t1), ctx(t1))).json()) as { site: { siteId: string; version: number; url: string }; versions: { version: number; note: string; shown: boolean; madeHere: boolean; url: string }[] };
    expect(first.site).toMatchObject({ siteId: id, version: 2 });
    expect(first.versions.map((v) => [v.version, v.note, v.shown, v.madeHere])).toEqual([[2, "darker heading", true, false], [1, "a tip calculator", false, true]]);
    expect(first.versions[1].url).toMatch(new RegExp(`/s/${id}\\?v=1$`));
    // the follow-up job reads the same page
    const second = (await (await readSite(as(t2), ctx(t2))).json()) as { versions: { version: number; madeHere: boolean }[] };
    expect(second.versions.map((v) => [v.version, v.madeHere])).toEqual([[2, true], [1, false]]);
  });

  it("shows an earlier version at the link again, and loses nothing", async () => {
    const t1 = job();
    const id = built(t1);
    addVersion(id, [page("<h1>Two</h1>")], { taskId: t1 });
    const back = await showAgain(as(t1, { method: "POST", body: { version: 1 } }), ctx(t1));
    expect(back.status).toBe(200);
    expect(((await back.json()) as { versions: { version: number; shown: boolean }[] }).versions.map((v) => [v.version, v.shown])).toEqual([[2, false], [1, true]]);
    expect(viewSite(id).html).toContain("\\u003ch1\\u003eOne\\u003c/h1\\u003e");
    // and forward again
    expect((await showAgain(as(t1, { method: "POST", body: { version: 2 } }), ctx(t1))).status).toBe(200);
    expect(getSite(id)!.version).toBe(2);
    for (const bad of [{ version: 9 }, { version: "1" }, { version: 1.5 }, {}]) expect((await showAgain(as(t1, { method: "POST", body: bad }), ctx(t1))).status).toBe(400);
  });

  it("answers only whoever hired the job", async () => {
    const t1 = job(), other = job("something else");
    built(t1);
    expect((await readSite(as(t1, { claim: "not-the-token" }), ctx(t1))).status).toBe(403);
    expect((await readSite(as(t1, { claim: claimTokenFor(other) }), ctx(t1))).status).toBe(403);
    expect((await readSite(as(t1, { claim: null }), ctx(t1))).status).toBe(401);
    expect((await showAgain(as(t1, { method: "POST", body: { version: 1 }, claim: "not-the-token" }), ctx(t1))).status).toBe(403);
    // a job that built nothing has no page to read or change
    expect((await readSite(as(other), ctx(other))).status).toBe(404);
    expect((await showAgain(as(other, { method: "POST", body: { version: 1 } }), ctx(other))).status).toBe(404);
  });

  it("cannot bring back a page that was taken down, and is not there at all while building is off", async () => {
    const t1 = job();
    const id = built(t1);
    addVersion(id, [page("<h1>Two</h1>")], { taskId: t1 });
    hideSite(id, "moderator: x");
    expect((await showAgain(as(t1, { method: "POST", body: { version: 1 } }), ctx(t1))).status).toBe(409);
    expect(getSite(id)!.status).toBe("hidden");
    delete process.env.AGENT_SITES;
    expect((await readSite(as(t1), ctx(t1))).status).toBe(404);
    expect((await showAgain(as(t1, { method: "POST", body: { version: 1 } }), ctx(t1))).status).toBe(404);
  });
});

describe("looking at an earlier version", () => {
  it("opens it at the link with ?v=, marked as an earlier one, without changing what the link shows", async () => {
    const id = built("t1");
    addVersion(id, [page("<h1>Two</h1>")], { taskId: "t2" });
    const at = (q: string) => openSite(new NextRequest(`http://localhost/s/${id}${q}`), { params: Promise.resolve({ siteId: id }) });
    const old = await (await at("?v=1")).text();
    expect(old).toContain('<span class="tag">an earlier version, 1</span>');
    expect(old).toContain("\\u003ch1\\u003eOne\\u003c/h1\\u003e");
    const now = await (await at("")).text();
    expect(now).not.toContain('class="tag"');
    expect(now).toContain("\\u003ch1\\u003eTwo\\u003c/h1\\u003e");
    // the version shown, asked for by number, is just the page
    expect(await (await at("?v=2")).text()).not.toContain('class="tag"');
    expect((await at("?v=9")).status).toBe(404);
    expect((await at("?v=abc")).status).toBe(200);
    expect(getSite(id)!.version).toBe(2);
  });
});

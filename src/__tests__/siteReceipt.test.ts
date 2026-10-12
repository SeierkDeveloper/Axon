// Agents that build, phase 8: on the receipt. What a job built is written on its receipt as a fingerprint, the page
// gives the fingerprint of what it shows to whoever holds its link, and neither gives the other away.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { addVersion, builtIn, createSite, filesOf, fingerprint, hideSite, showVersion, type SiteFileIn } from "@/lib/agentSites";
import { getPublicReceipt, getReceipt } from "@/lib/receipts";
import { viewSite } from "@/lib/siteViewer";
import { createTask } from "@/lib/tasks";
import { appendTraceEvent, getTraceEvents } from "@/lib/traceEvents";
import { GET as readFingerprint } from "@/app/s/[siteId]/fingerprint/route";

const saved = process.env.AGENT_SITES;
beforeEach(() => {
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows; DELETE FROM tasks;");
});
afterEach(() => { if (saved === undefined) delete process.env.AGENT_SITES; else process.env.AGENT_SITES = saved; });

const FILES: SiteFileIn[] = [{ path: "index.html", content: "<h1>Tips</h1><script src=\"app.js\"></script>" }, { path: "app.js", content: "const tip = 1;" }];
const job = () => createTask({ fromAgent: "buyer", toAgent: "deep-dive-ai", task: "Build me a secret tip calculator", initialStatus: "running", startedBy: "worker" }).taskId;
function built(taskId: string, files: SiteFileIn[] = FILES): string {
  const m = createSite({ taskId, agentId: "deep-dive-ai", ownerMark: "0xabc", title: "Secret Tips" });
  if (!m.ok) throw new Error(m.why);
  const kept = addVersion(m.site.siteId, files, { taskId });
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  return m.site.siteId;
}
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const ask = async (siteId: string) => readFingerprint(new NextRequest(`http://localhost/s/${siteId}/fingerprint`), { params: Promise.resolve({ siteId }) });

describe("what a job built, on its receipt", () => {
  it("is each version it kept: its number, its size and its fingerprint, and whether the page shows it now", () => {
    const first = job(), id = built(first);
    const second = job();
    addVersion(id, [{ path: "index.html", content: "<h1>Tips, bigger</h1>" }], { taskId: second });
    expect(builtIn(first)).toMatchObject([{ siteId: id, title: "Secret Tips", version: 1, files: 2, shown: false, live: true }]);
    expect(builtIn(second)).toMatchObject([{ siteId: id, version: 2, files: 1, shown: true }]);
    expect(builtIn(job())).toEqual([]);
    const receipt = getPublicReceipt(first)!;
    expect(receipt.built).toHaveLength(1);
    expect(receipt.built![0]).toMatchObject({ version: 1, files: 2, shown: false });
    expect(receipt.built![0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(getPublicReceipt(second)!.built![0]).toMatchObject({ version: 2, shown: true });
    // showing the first version again turns the two around
    showVersion(id, 1);
    expect(getPublicReceipt(first)!.built![0].shown).toBe(true);
    expect(getPublicReceipt(second)!.built![0].shown).toBe(false);
  });

  it("is the fingerprint anybody can work out again from the files: every path with its file's hash", () => {
    const taskId = job(), id = built(taskId);
    const want = sha(`app.js\n${sha("const tip = 1;")}\nindex.html\n${sha("<h1>Tips</h1><script src=\"app.js\"></script>")}\n`);
    expect(getPublicReceipt(taskId)!.built![0].sha256).toBe(want);
    expect(fingerprint(filesOf(id))).toBe(want);
  });

  it("never says where the page is or what it is called, on the receipt anybody can read", () => {
    const taskId = job(), id = built(taskId);
    const open = JSON.stringify(getPublicReceipt(taskId));
    expect(open).not.toContain(id);
    expect(open).not.toMatch(/Secret Tips|\/s\//);
    // the receipt read with a key is the hirer's own, and names it
    expect(getReceipt(taskId).built).toMatchObject([{ siteId: id, title: "Secret Tips", path: `/s/${id}`, version: 1 }]);
  });

  it("a job that built nothing has a receipt that reads exactly as before", () => {
    const taskId = job();
    expect(getPublicReceipt(taskId)).not.toHaveProperty("built");
    expect(getReceipt(taskId)).not.toHaveProperty("built");
  });

  it("a page that was taken down still has its fingerprint on the receipt, as a version the page does not show", () => {
    const taskId = job(), id = built(taskId);
    hideSite(id, "reported");
    expect(getPublicReceipt(taskId)!.built).toMatchObject([{ version: 1, shown: false }]);
  });

  it("is an event of its own in the job's record, with the fingerprint and nothing about the page", () => {
    const taskId = job(), id = built(taskId);
    const b = builtIn(taskId)[0];
    appendTraceEvent({ traceId: taskId, taskId, kind: "site.built", fromAgent: "deep-dive-ai", outputHash: b.sha256, meta: { version: b.version, files: b.files, bytes: b.bytes } });
    const events = getTraceEvents(taskId);
    const e = events.find((x) => x.kind === "site.built")!;
    expect(e).toMatchObject({ outputHash: b.sha256, meta: { version: 1, files: 2 } });
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(e)).not.toContain(id);
    expect(JSON.stringify(e)).not.toMatch(/Secret Tips/);
  });
});

describe("what a page is, for whoever holds its link", () => {
  it("gives the fingerprint of what it shows and each file's hash, which match the receipt", async () => {
    const taskId = job(), id = built(taskId);
    const res = await ask(id);
    expect(res.status).toBe(200);
    const got = await res.json();
    expect(got).toMatchObject({ version: 1, fingerprint: getPublicReceipt(taskId)!.built![0].sha256, files: [{ path: "app.js", sha256: sha("const tip = 1;") }, { path: "index.html" }] });
    expect(got.how).toMatch(/SHA-256 of, for every file in order of its path/);
    expect(res.headers.get("x-robots-tag")).toMatch(/noindex/);
  });

  it("never names the job that built it: a receipt says who hired whom, and a shared page should not", async () => {
    const taskId = job(), id = built(taskId);
    const text = JSON.stringify(await (await ask(id)).json());
    expect(text).not.toContain(taskId);
    expect(text).not.toMatch(/buyer|\/r\//);
    const html = viewSite(id).html;
    expect(html).not.toContain(taskId);
    expect(html).not.toMatch(/href="\/r\//);
    // the page does say where its fingerprint is
    expect(html).toContain(`href="/s/${id}/fingerprint"`);
  });

  it("follows the page: the version shown now, nothing for a page that is gone or taken down", async () => {
    const taskId = job(), id = built(taskId);
    addVersion(id, [{ path: "index.html", content: "<h1>Two</h1>" }], { taskId });
    expect(await (await ask(id)).json()).toMatchObject({ version: 2, files: [{ path: "index.html", sha256: sha("<h1>Two</h1>") }] });
    showVersion(id, 1);
    expect(await (await ask(id)).json()).toMatchObject({ version: 1 });
    expect((await ask("no-such-page")).status).toBe(404);
    hideSite(id, "reported");
    expect((await ask(id)).status).toBe(410);
    process.env.AGENT_SITES = "off";
    expect((await ask(id)).status).toBe(404);
  });
});

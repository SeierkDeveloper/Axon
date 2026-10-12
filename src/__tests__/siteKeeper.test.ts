// Agents that build, phase 6: pages that update themselves. A schedule or a trigger keeps the page its own earlier
// runs built: the next run is handed that page and changes it, at the same link.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { addVersion, createSite, hideSite, type SiteFileIn } from "@/lib/agentSites";
import { builtSoFar, buildTool } from "@/lib/buildTool";
import { claimTokenFor } from "@/lib/mcpServer";
import { keeperOfSite, keeperOfTask, keptPage, siteKeptBy, siteKeptForTask } from "@/lib/siteKeeper";
import { updatedWords, viewSite, viewerHtml } from "@/lib/siteViewer";
import { createTask } from "@/lib/tasks";
import { GET as readSite } from "@/app/api/tasks/[taskId]/site/route";

const saved = process.env.AGENT_SITES;
beforeEach(() => {
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM built_site_answers; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM retainer_runs; DELETE FROM trigger_runs; DELETE FROM rate_limit_windows; DELETE FROM tasks;");
});
afterEach(() => { if (saved === undefined) delete process.env.AGENT_SITES; else process.env.AGENT_SITES = saved; });

const page = (body: string): SiteFileIn => ({ path: "index.html", content: `<!doctype html><html><body>${body}</body></html>` });
const job = () => createTask({ fromAgent: "0xowner", toAgent: "deep-dive-ai", task: "Put today's menu on a page", initialStatus: "running", startedBy: "worker" }).taskId;
let slot = 0;
/** One run of a schedule: the job it started. */
function scheduled(retainerId: string): string {
  const taskId = job();
  getDb().prepare("INSERT INTO retainer_runs (run_id, retainer_id, scheduled_for, status, task_id, created_at) VALUES (?, ?, ?, 'running', ?, ?)").run(`run-${++slot}`, retainerId, new Date(Date.UTC(2026, 9, 12, 8) + slot * 86_400_000).toISOString(), taskId, new Date().toISOString());
  return taskId;
}
/** One run of a trigger: the job it started. */
function triggered(triggerId: string): string {
  const taskId = job();
  getDb().prepare("INSERT INTO trigger_runs (run_id, trigger_id, event_key, summary, status, task_id, created_at) VALUES (?, ?, ?, 'called', 'running', ?, ?)").run(`trun-${++slot}`, triggerId, `event-${slot}`, taskId, new Date().toISOString());
  return taskId;
}
function build(taskId: string, body: string, title = "Today's menu"): string {
  const m = createSite({ taskId, agentId: "deep-dive-ai", ownerMark: "0xowner", title });
  if (!m.ok) throw new Error(m.why);
  const kept = addVersion(m.site.siteId, [page(body)], { taskId });
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  return m.site.siteId;
}

describe("the page a schedule or a trigger keeps", () => {
  it("knows which jobs started themselves, and from what", () => {
    expect(keeperOfTask(scheduled("ret-1"))).toEqual({ kind: "schedule", id: "ret-1" });
    expect(keeperOfTask(triggered("trg-1"))).toEqual({ kind: "trigger", id: "trg-1" });
    expect(keeperOfTask(job())).toBeNull();
    expect(keeperOfTask("no-such-job")).toBeNull();
  });

  it("is nothing before a run has built one, and from then on the page its runs built", () => {
    const first = scheduled("ret-1");
    expect(siteKeptForTask(first)).toBeNull();
    expect(keptPage({ kind: "schedule", id: "ret-1" })).toBeNull();
    const id = build(first, "<h1>Monday: soup</h1>");
    const second = scheduled("ret-1");
    expect(siteKeptForTask(second)?.siteId).toBe(id);
    // the second run changes it: still that page, one version on
    addVersion(id, [page("<h1>Tuesday: stew</h1>")], { taskId: second });
    const third = scheduled("ret-1");
    expect(siteKeptForTask(third)).toMatchObject({ siteId: id, version: 2 });
    expect(keptPage({ kind: "schedule", id: "ret-1" })).toMatchObject({ siteId: id, title: "Today's menu", version: 2, path: `/s/${id}` });
  });

  it("belongs to its own schedule or trigger and to no other", () => {
    const mine = build(scheduled("ret-1"), "<h1>Mine</h1>");
    const theirs = build(triggered("trg-1"), "<h1>Theirs</h1>", "Order board");
    expect(siteKeptForTask(scheduled("ret-1"))?.siteId).toBe(mine);
    expect(siteKeptForTask(triggered("trg-1"))?.siteId).toBe(theirs);
    expect(siteKeptForTask(scheduled("ret-2"))).toBeNull();
    expect(siteKeptForTask(triggered("trg-2"))).toBeNull();
    // a job somebody started by hand keeps nothing, even beside a page it built itself
    const byHand = job();
    build(byHand, "<h1>By hand</h1>");
    expect(siteKeptForTask(byHand)).toBeNull();
    expect(keeperOfSite(mine)).toEqual({ kind: "schedule", id: "ret-1" });
    expect(keeperOfSite(theirs)).toEqual({ kind: "trigger", id: "trg-1" });
  });

  it("is not a page that was taken down: the next run starts a new one, and that one is kept from then on", () => {
    const first = build(scheduled("ret-1"), "<h1>One</h1>");
    hideSite(first, "reported");
    const next = scheduled("ret-1");
    expect(siteKeptForTask(next)).toBeNull();
    const second = build(next, "<h1>Two</h1>");
    expect(siteKeptBy({ kind: "schedule", id: "ret-1" })?.siteId).toBe(second);
    expect(keeperOfSite(first)).toBeNull();
    expect(keeperOfSite(second)).toEqual({ kind: "schedule", id: "ret-1" });
    expect(keeperOfSite("no-such-page")).toBeNull();
  });
});

describe("what the run is told", () => {
  it("that this is the page it keeps, the time it is, and to change it and not start another", () => {
    const id = build(scheduled("ret-1"), "<h1>Monday: soup</h1>");
    const note = builtSoFar(id, { kept: true, now: new Date(Date.UTC(2026, 9, 13, 8, 0)) });
    expect(note).toMatch(/THE PAGE THIS JOB KEEPS UP TO DATE: "Today's menu", version 1, open at its link now\. This job runs again and again, and this is one of its runs\. It is 2026-10-13 08:00 UTC\./);
    expect(note).toContain("=== index.html ===\n<!doctype html><html><body><h1>Monday: soup</h1></body></html>");
    expect(note).toMatch(/Bring the page up to date with what this run found: call build_page with only the files you change/);
    expect(note).toMatch(/Do not start a new page\. The link stays the same and shows the new version\. Say on the page when it was last updated\./);
    expect(note).toMatch(/If nothing on it needs changing, leave it as it is and say so in your answer\.$/);
    // a follow-up in a conversation is still told what it always was
    expect(builtSoFar(id)).toMatch(/THE PAGE BUILT EARLIER IN THIS CONVERSATION/);
    expect(builtSoFar(id)).not.toMatch(/KEEPS UP TO DATE/);
  });

  it("and the build tool then changes that page: same link, next version", async () => {
    const first = scheduled("ret-1");
    const id = build(first, "<h1>Monday: soup</h1>");
    const second = scheduled("ret-1");
    const kept = siteKeptForTask(second)!;
    const tool = buildTool({ taskId: second, agentId: "deep-dive-ai", ownerMark: "0xowner", paid: false, continueSite: kept.siteId, env: { AGENT_SITES: "on" } });
    expect(await tool.run({ title: "Today's menu", note: "Tuesday's menu", files: [page("<h1>Tuesday: stew</h1><p>Updated 13 October</p>")] })).toMatch(/^Built "Today's menu": version 2/);
    expect(siteKeptForTask(scheduled("ret-1"))).toMatchObject({ siteId: id, version: 2 });
    expect(getDb().prepare("SELECT COUNT(*) n FROM built_sites").get()).toEqual({ n: 1 });
  });
});

describe("where it shows", () => {
  it("the page itself says when it was last brought up to date, and only a page that is kept says so", () => {
    const kept = build(scheduled("ret-1"), "<h1>Soup</h1>");
    expect(viewSite(kept).html).toMatch(/<span class="tag" title="This page is kept up to date by its agent">updated \d{1,2} [A-Z][a-z]{2}, \d\d:\d\d UTC<\/span>/);
    const byHand = job();
    expect(viewSite(build(byHand, "<h1>Once</h1>")).html).not.toMatch(/class="tag"[^>]*>updated/);
    expect(updatedWords("2026-10-12T14:05:09.000Z")).toBe("12 Oct, 14:05 UTC");
    expect(updatedWords("nonsense")).toBe("");
    // an earlier version says it is an earlier version, not when the page was updated
    expect(viewerHtml({ siteId: "x", title: "T", agentId: "a" }, { "index.html": "<h1>x</h1>" }, "An agent", 1, { updated: "12 Oct, 14:05 UTC" })).not.toContain("updated 12 Oct");
  });

  it("the job's card is told what keeps its page up to date", async () => {
    const run = scheduled("ret-1");
    build(run, "<h1>Soup</h1>");
    const seen = async (taskId: string) => (await readSite(new NextRequest(`http://localhost/api/tasks/${taskId}/site`, { headers: { "x-claim-token": claimTokenFor(taskId) } }), { params: Promise.resolve({ taskId }) })).json();
    expect(await seen(run)).toMatchObject({ kept: "schedule" });
    const fired = triggered("trg-1");
    build(fired, "<h1>Board</h1>");
    expect(await seen(fired)).toMatchObject({ kept: "trigger" });
    const byHand = job();
    build(byHand, "<h1>Once</h1>");
    expect(await seen(byHand)).toMatchObject({ kept: null });
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createTask, failTask } from "@/lib/tasks";
import { watch, watchPages, watchTriggers, watchBrowsing, WATCH } from "@/lib/autonomy3Watch";
import { recentJobs, tick } from "@/lib/autonomy3";
import "@/lib/autonomy3Parts";

const ON = { AUTONOMY3: "on", AUTONOMY3_WATCH: "on", AGENT_SITES: "on" };
const NOW = Date.parse("2026-10-14T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function site(id: string, version: number, opts: { files?: boolean; createdMin?: number; status?: string } = {}) {
  getDb().prepare("INSERT INTO built_sites (site_id, task_id, agent_id, title, status, version, created_at, updated_at) VALUES (?, 't', 'a', ?, ?, ?, ?, ?)")
    .run(id, `Page ${id}`, opts.status ?? "live", version, ago(opts.createdMin ?? 60), ago(opts.createdMin ?? 60));
  if (version > 0 && opts.files !== false) {
    getDb().prepare("INSERT INTO built_site_files (site_id, version, path, mime, bytes, sha256, content) VALUES (?, ?, 'index.html', 'text/html', 5, 'x', ?)").run(id, version, Buffer.from("<p>hi</p>"));
  }
}

function trigger(id: string, t: { kind?: string; status?: string; pause?: string | null; failures?: number; updatedMin?: number; every?: number | null; checkedMin?: number | null }) {
  getDb().prepare(`INSERT INTO triggers (trigger_id, owner_wallet, agent_id, name, kind, instructions, status, pause_reason, consecutive_failures, created_at, updated_at, page_every_min, page_checked_at)
                   VALUES (?, '0xowner', 'a', ?, ?, 'do it', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `Trigger ${id}`, t.kind ?? "webhook", t.status ?? "active", t.pause ?? null, t.failures ?? 0, ago(600), ago(t.updatedMin ?? 10), t.every ?? null, t.checkedMin == null ? null : ago(t.checkedMin));
}

beforeEach(() => {
  const db = getDb();
  for (const t of ["built_site_reports", "built_site_files", "built_sites", "triggers", "task_pages", "tasks", "autonomy3_jobs"]) db.exec(`DELETE FROM ${t}`);
});

describe("watches everything: built pages", () => {
  it("names a live page with nothing built, a version with no files, a reported page and one that does not load", async () => {
    site("ok", 1);
    site("unbuilt", 0, { createdMin: 60 });
    site("building", 0, { createdMin: 2 }); // still being built: not a finding yet
    site("nofiles", 2, { files: false });
    site("hidden", 0, { status: "hidden" });
    site("down", 1);
    getDb().prepare("INSERT INTO built_site_reports (site_id, reason, reporter_hash, created_at) VALUES ('ok', 'spam', 'h1', ?)").run(ago(5));
    const fetchFn = (async (url: string) => new Response("", { status: String(url).endsWith("/s/down") ? 500 : 200 })) as unknown as typeof fetch;
    const { looked, found } = await watchPages(NOW, "https://private.example", fetchFn);
    expect(looked).toBe(5);
    expect(found.map((f) => `${f.kind}:${f.subject}`).sort()).toEqual(["page-down:down", "page-empty:nofiles", "page-empty:unbuilt", "page-reported:ok"]);
  });
});

describe("watches everything: triggers", () => {
  it("names triggers that paused themselves today, ones failing now, and page watchers that stopped looking", () => {
    trigger("fine", {});
    trigger("gave-up", { status: "paused", pause: "failures", updatedMin: 30 });
    trigger("no-agent", { status: "paused", pause: "agent_unavailable", updatedMin: 30 });
    trigger("old-pause", { status: "paused", pause: "failures", updatedMin: 3000 }); // over a day ago: already told
    trigger("owner-paused", { status: "paused", pause: "owner", updatedMin: 30 }); // its owner's choice
    trigger("wobbly", { failures: WATCH.triggerFailing });
    trigger("watcher", { kind: "page", every: 10, checkedMin: 45 });
    trigger("watcher-ok", { kind: "page", every: 10, checkedMin: 12 });
    const { looked, found } = watchTriggers(NOW);
    expect(looked).toBe(8);
    expect(found.map((f) => `${f.kind}:${f.subject}`).sort()).toEqual(["trigger-failing:wobbly", "trigger-paused:gave-up", "trigger-paused:no-agent", "watcher-stopped:watcher"]);
  });
});

describe("watches everything: browser jobs", () => {
  function browserJob(fails: boolean) {
    const t = createTask({ fromAgent: "anonymous", toAgent: "a", task: "open python.org" });
    getDb().prepare("INSERT INTO task_pages (task_id, n, url, at) VALUES (?, 1, 'https://python.org', ?)").run(t.taskId, new Date().toISOString());
    if (fails) failTask(t.taskId, "Browser crashed");
  }

  it("names a day where most browser jobs fail, and a day's browsing nearly used up", () => {
    browserJob(true); browserJob(true); browserJob(false);
    const env = { AGENT_BROWSER_DAILY_MAX: "3" };
    const { looked, found } = watchBrowsing(Date.now(), env);
    expect(looked).toBe(3);
    expect(found.map((f) => f.kind)).toEqual(["browser-failing", "browser-nearly-used"]);
  });

  it("says nothing on a quiet day", () => {
    browserJob(true);
    expect(watchBrowsing(Date.now(), { AGENT_BROWSER_DAILY_MAX: "200" }).found).toEqual([]);
  });
});

describe("watches everything: the look", () => {
  it("does nothing while switched off", async () => {
    expect(await watch(NOW, {})).toEqual({ looked: false, found: [] });
    expect(recentJobs(5, "watch")).toHaveLength(0);
  });

  it("records one look as a job, and looks again only after a while", async () => {
    trigger("wobbly", { failures: 3 });
    const fetchFn = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const first = await watch(NOW, ON, { fetchFn, base: "https://private.example" });
    expect(first.looked).toBe(true);
    const [job] = recentJobs(5, "watch");
    expect(job).toMatchObject({ outcome: "found" });
    expect(job.summary).toMatch(/1 triggers.*1 to look at/);
    expect((job.detail as { found: unknown[] }).found).toHaveLength(1);
    expect((await watch(NOW + 60_000, ON, { fetchFn })).looked).toBe(false);
    expect((await watch(NOW + WATCH.everyMinutes * 60_000, ON, { fetchFn, base: "https://private.example" })).looked).toBe(true);
  });

  it("runs on the tick", async () => {
    const r = await tick(NOW, { AUTONOMY3: "on", AUTONOMY3_WATCH: "on" });
    expect(r.ran).toEqual(["watch"]);
    expect(recentJobs(5, "watch")[0]).toMatchObject({ outcome: "clear" });
  });
});

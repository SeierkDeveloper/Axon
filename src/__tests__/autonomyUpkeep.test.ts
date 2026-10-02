import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { freeStuckTasks, webhookUpkeep, refreshStaleDescriptions, warnRetainerOwners, upkeepActions, AUTONOMY_DISABLED } from "@/lib/autonomyUpkeep";
import { runNetworkPass } from "@/lib/autonomyNetwork";
import type { Finding } from "@/lib/networkChecks";
import type { Agent } from "@/sdk/types";

const HOUR = 3_600_000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function agent(id: string, over: Partial<Agent> = {}) {
  createAgent({ agentId: id, name: `Agent ${id}`, capabilities: ["upkeep"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt: ago(0), ...over } as Agent);
}
function task(status: string, startedBy: string | null, stuckCount = 0): string {
  const id = randomUUID();
  getDb()
    .prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, started_at, started_by, stuck_count) VALUES (?, 'x', 'w', 't', ?, ?, ?, ?, ?)")
    .run(id, status, ago(3 * HOUR), status === "running" ? ago(HOUR) : null, startedBy, stuckCount);
  return id;
}
const statusOf = (id: string) => (getDb().prepare("SELECT status, stuck_count FROM tasks WHERE task_id = ?").get(id) as { status: string; stuck_count: number });
const stuck = (id: string): Finding => ({ kind: "task-stuck", subject: id, what: "stuck" });

beforeEach(() => {
  const db = getDb();
  for (const t of ["tasks", "webhooks", "retainer_deliveries", "retainers", "agents"]) db.exec(`DELETE FROM ${t}`);
  agent("w");
  delete process.env.AUTONOMY_ACTIONS;
});
afterEach(() => {
  delete process.env.AUTONOMY_ACTIONS;
});

describe("stuck work", () => {
  it("puts a task started outside the worker back in the queue once, then closes it", () => {
    const id = task("running", "cron");
    expect(freeStuckTasks([stuck(id)])[0].what).toMatch(/back in the queue/);
    expect(statusOf(id)).toMatchObject({ status: "queued", stuck_count: 1 });
    getDb().prepare("UPDATE tasks SET status = 'running', started_by = 'cron', started_at = ? WHERE task_id = ?").run(ago(HOUR), id);
    expect(freeStuckTasks([stuck(id)])[0].what).toMatch(/closed/);
    expect(statusOf(id).status).toBe("failed");
  });

  it("leaves what the worker started to the worker, and closes work nobody picked up", () => {
    const mine = task("running", "worker");
    const waiting = task("queued", null);
    const out = freeStuckTasks([stuck(mine), stuck(waiting)]);
    expect(out.map((f) => f.subject)).toEqual([waiting]);
    expect(statusOf(mine).status).toBe("running");
    expect(statusOf(waiting).status).toBe("failed");
  });
});

describe("webhooks", () => {
  function hook(id: string, status = "active", reason: string | null = null, disabledAgo = 0) {
    getDb()
      .prepare("INSERT INTO webhooks (webhook_id, agent_id, url, events, secret, status, created_at, failure_count, disabled_at, disabled_reason) VALUES (?, 'w', 'https://h.test', '[]', 's', ?, ?, 25, ?, ?)")
      .run(id, status, ago(48 * HOUR), disabledAgo ? ago(disabledAgo) : null, reason);
  }
  const hookStatus = (id: string) => (getDb().prepare("SELECT status, disabled_reason FROM webhooks WHERE webhook_id = ?").get(id) as { status: string; disabled_reason: string | null });

  it("switches off a failing webhook, and back on once it answers a ping hours later", async () => {
    hook("h1");
    await webhookUpkeep([{ kind: "webhook-failing", subject: "h1", what: "x" }], async () => true, NOW);
    expect(hookStatus("h1")).toEqual({ status: "inactive", disabled_reason: AUTONOMY_DISABLED });
    expect(await webhookUpkeep([], async () => true, NOW + HOUR)).toEqual([]); // too soon to ping
    const out = await webhookUpkeep([], async () => true, NOW + 7 * HOUR);
    expect(out.map((f) => f.kind)).toEqual(["webhook-restored"]);
    expect(hookStatus("h1").status).toBe("active");
  });

  it("never switches back on a webhook something else switched off", async () => {
    hook("h2", "inactive", "permanent failures", 10 * HOUR);
    expect(await webhookUpkeep([], async () => true, NOW)).toEqual([]);
    expect(hookStatus("h2").status).toBe("inactive");
  });
});

describe("descriptions and owners", () => {
  it("rewrites at most a few stale descriptions per run", async () => {
    const found = Array.from({ length: 8 }, (_, i): Finding => ({ kind: "stale-description", subject: `a${i}`, what: "old" }));
    const done: string[] = [];
    const out = await refreshStaleDescriptions(found, async (id) => { done.push(id); return true; });
    expect(out).toHaveLength(5);
    expect(done).toHaveLength(5);
  });

  it("tells a retainer's owner it is ending, once, through its webhook", () => {
    getDb().prepare(
      `INSERT INTO retainers (retainer_id, owner_wallet, agent_id, instructions, schedule, pay_in, max_price_wei, status, consecutive_failures, runs_done, anchor_at, created_at, updated_at, webhook_url, webhook_secret)
       VALUES ('ret_1', '0xabc', 'w', 'x', '{}', 'ETH', '1', 'active', 0, 0, ?, ?, ?, 'https://hook.test', 'sec')`,
    ).run(ago(HOUR), ago(HOUR), ago(HOUR));
    const warn: Finding = { kind: "owner-warning", subject: "ret_1", what: "retainer ends soon" };
    expect(warnRetainerOwners([warn])).toHaveLength(1);
    expect(warnRetainerOwners([warn])).toHaveLength(0);
    const n = (getDb().prepare("SELECT COUNT(*) n FROM retainer_deliveries WHERE event_type = 'retainer.ending'").get() as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe("re-pricing", () => {
  it("re-prices an opted-in agent at most once a day", () => {
    agent("busy", { price: "0.0002 ETH" });
    const db = getDb();
    db.prepare("UPDATE agents SET auto_price = 1 WHERE agent_id = 'busy'").run();
    for (let i = 0; i < 12; i++) {
      db.prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, started_at, completed_at) VALUES (?, 'x', 'busy', 't', 'completed', ?, ?, ?)")
        .run(randomUUID(), ago((i + 1) * HOUR), ago((i + 1) * HOUR), ago((i + 1) * HOUR - 1000));
    }
    const first = runNetworkPass({ apply: true });
    expect(first.changes.map((c) => c.agentId)).toEqual(["busy"]);
    const second = runNetworkPass({ apply: true });
    expect(second.changes).toEqual([]);
  });
});

describe("the switch", () => {
  it("does nothing on a dry run, nor with AUTONOMY_ACTIONS=off", async () => {
    const id = task("queued", null);
    expect(await upkeepActions([stuck(id)], { apply: false })).toEqual([]);
    process.env.AUTONOMY_ACTIONS = "off";
    expect(await upkeepActions([stuck(id)], { apply: true })).toEqual([]);
    expect(statusOf(id).status).toBe("queued");
  });
});

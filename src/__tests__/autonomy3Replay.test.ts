import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import { replayDay, compareRules, replaySet, replayYesterday, withRules, TODAY } from "@/lib/autonomy3Replay";
import { recentJobs, tick } from "@/lib/autonomy3";
import "@/lib/autonomy3Parts";
import type { Agent } from "@/sdk/types";

const DAY0 = Date.parse("2026-10-13T00:00:00Z");
const at = (h: number, m = 0) => new Date(DAY0 + h * 3_600_000 + m * 60_000).toISOString();

function agent(id: string, caps = ["translation", "localisation"], extra: Partial<Agent> = {}) {
  createAgent({ agentId: id, name: `Agent ${id}`, capabilities: caps, publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z", ...extra } as Agent);
}
/** A job as the record has it: created, and finished (or not) at given times. */
function job(to: string, status: "completed" | "failed" | "queued" | "running", created: string, done?: string, opts: { from?: string; error?: string; output?: string; context?: Record<string, unknown>; started?: string } = {}) {
  const t = createTask({ fromAgent: opts.from ?? "anonymous", toAgent: to, task: `job for ${to}`, ...(opts.context ? { context: opts.context } : {}) });
  getDb().prepare("UPDATE tasks SET status = ?, created_at = ?, completed_at = ?, started_at = ?, error = ?, output = ? WHERE task_id = ?")
    .run(status, created, done ?? null, opts.started ?? (done ? created : null), status === "failed" ? (opts.error ?? "Upstream timeout") : null, status === "completed" ? (opts.output ?? "the answer") : null, t.taskId);
  return t.taskId;
}

beforeEach(() => {
  const db = getDb();
  for (const t of ["tasks", "agents", "autonomy3_jobs"]) db.exec(`DELETE FROM ${t}`);
  for (let i = 0; i < 30; i++) agent(`filler-${i}`, ["filler"]);
  agent("broken"); agent("helper");
});

describe("replays a recorded day", () => {
  it("says which failures would have been moved and why the others not", () => {
    job("broken", "failed", at(9), at(9, 1));
    job("broken", "failed", at(10), at(10, 1), { error: "I have to decline this" });
    job("broken", "failed", at(11), at(11, 1), { from: "helper" });
    job("broken", "completed", at(12), at(12, 1));
    const r = replayDay(DAY0);
    expect(r).toMatchObject({ day: "2026-10-13", jobs: 4, failed: 3 });
    expect(r.rescue.wouldMove).toBe(1);
    expect(r.rescue.to).toEqual({ helper: 1 });
    expect(r.rescue.notMoved).toEqual({ "the agent turned it down, or its hirer stopped it": 1, "an agent hired it, and handles its failure itself": 1 });
  });

  it("says how much earlier a failing agent is caught than by the hourly pass", () => {
    for (let i = 0; i < 3; i++) job("broken", "failed", at(10, 31 + i), at(10, 32 + i));
    const r = replayDay(DAY0);
    expect(r.react.agents).toBe(1);
    // third failure at 10:34, reacted on by 10:37, the hourly pass at 11:30: 53 minutes earlier
    expect(r.react.minutesEarlier).toBe(53);
  });

  it("counts jobs that sat long enough to be freed", () => {
    job("broken", "queued", at(1));
    job("broken", "running", at(2), undefined, { started: at(2) });
    job("broken", "completed", at(3), at(3, 2));
    expect(replayDay(DAY0).stuck).toBe(2);
  });

  it("compares proposed rules with today's, and calls a change that would pull too many agents unsafe", () => {
    for (let a = 0; a < 6; a++) { agent(`w${a}`); job(`w${a}`, "failed", at(8, a), at(8, a + 1)); }
    const gentle = compareRules(DAY0, TODAY);
    expect(gentle.safe).toBe(true);
    const harsh = compareRules(DAY0, withRules({ failing: { consecutiveFailures: 1 } }));
    expect(harsh.proposed.react.agents).toBe(6);
    expect(harsh.safe).toBe(false);
    expect(harsh.why[0]).toMatch(/would have taken 6 of \d+ agents out of routing/);
  });
});

describe("an agent's recorded real jobs", () => {
  it("gives finished hires by people with their answers, and leaves out the network's own and agent-to-agent work", () => {
    const now = DAY0 + 20 * 3_600_000;
    job("helper", "completed", at(9), at(9, 1), { output: "Hola" });
    job("helper", "completed", at(10), at(10, 1), { from: "broken" });
    job("helper", "completed", at(11), at(11, 1), { context: { source: "axon-network-activity", automated: true } });
    job("helper", "failed", at(12), at(12, 1));
    const set = replaySet("helper", now);
    expect(set).toHaveLength(1);
    expect(set[0]).toMatchObject({ task: "job for helper", answer: "Hola" });
  });
});

describe("the daily replay", () => {
  it("replays yesterday once a day and records it", async () => {
    job("broken", "failed", at(9), at(9, 1));
    const now = DAY0 + 86_400_000 + 3_600_000;
    const env = { AUTONOMY3: "on", AUTONOMY3_REPLAY: "on" };
    expect(replayYesterday(now, {})).toBeNull();
    await tick(now, env);
    const [j] = recentJobs(5, "replay");
    expect(j).toMatchObject({ subject: "2026-10-13", outcome: "replayed" });
    expect(j.summary).toMatch(/^2026-10-13: 1 jobs, 1 failed. 1 would have been moved/);
    expect(replayYesterday(now + 3_600_000, env)).toBeNull(); // once a day
  });
});

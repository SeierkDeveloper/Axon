import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createTask, failTask, getTaskById } from "@/lib/tasks";
import { claimTokenValid } from "@/lib/claimToken";
import { rescueTask, sweepFailures, rescueView, pickRescuer, whyNotRescue, RESCUE } from "@/lib/autonomy3Rescue";
import { recentJobs, tick } from "@/lib/autonomy3";
import "@/lib/autonomy3Parts";
import type { Agent } from "@/sdk/types";

const ON = { AUTONOMY3: "on", AUTONOMY3_RESCUE: "on" };

function agent(id: string, caps: string[], extra: Partial<Agent> = {}) {
  createAgent({ agentId: id, name: `Agent ${id}`, capabilities: caps, publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt: new Date().toISOString(), ...extra } as Agent);
}

/** A hire by a person that failed just now. */
function failedHire(to = "broken", opts: { error?: string; context?: Record<string, unknown>; from?: string; parentTaskId?: string } = {}) {
  const t = createTask({ fromAgent: opts.from ?? "anonymous", toAgent: to, task: "Make a picture of a lighthouse", ...(opts.context ? { context: opts.context } : {}), ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}) });
  failTask(t.taskId, opts.error ?? "Upstream inference timeout");
  return getTaskById(t.taskId)!;
}

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM agents");
  db.exec("DELETE FROM autonomy3_jobs");
  agent("broken", ["image generation", "visual analysis", "design feedback", "alt text writing"]);
  agent("helper", ["image generation", "visual analysis", "design feedback"]);
  agent("paid", ["image generation", "visual analysis", "design feedback", "alt text writing"], { price: "0.001 ETH" });
  agent("remote", ["image generation", "visual analysis", "design feedback", "alt text writing"], { endpoint: "https://example.com/agent" });
  agent("thin", ["image generation"]);
});

describe("no job dies: the move", () => {
  it("does nothing while the part is switched off", () => {
    const t = failedHire();
    expect(rescueTask(t.taskId, Date.now(), {})).toEqual({ moved: false, why: "switched off" });
    expect(rescueTask(t.taskId, Date.now(), { AUTONOMY3: "on" }).moved).toBe(false);
    expect(recentJobs(10, "rescue")).toHaveLength(0);
  });

  it("moves a failed hire to a free agent on Axon with most of the same skills", () => {
    const t = failedHire();
    const r = rescueTask(t.taskId, Date.now(), ON);
    expect(r).toMatchObject({ moved: true, to: "helper" });
    const moved = getTaskById(r.taskId!)!;
    expect(moved).toMatchObject({ toAgent: "helper", fromAgent: "anonymous", task: t.task, status: "queued" });
    expect(moved.context).toMatchObject({ rescueOf: t.taskId });
    expect(moved.payment).toBeUndefined();
    // the failed job's view says where it went, with what reads it
    const view = rescueView(getTaskById(t.taskId)!, Date.now(), ON);
    expect(view.rescued).toMatchObject({ taskId: moved.taskId, agentId: "helper", agentName: "Agent helper" });
    expect(claimTokenValid(moved.taskId, view.rescued!.claimToken)).toBe(true);
    expect(recentJobs(5, "rescue")[0]).toMatchObject({ subject: t.taskId, outcome: "moved" });
  });

  it("never picks a paid agent, one on its own server, one with too few of the skills, or one that is failing too", () => {
    const failed = { agentId: "broken", capabilities: ["image generation", "visual analysis", "design feedback", "alt text writing"] } as Agent;
    expect(pickRescuer(failed, "anonymous")?.agentId).toBe("helper");
    for (let i = 0; i < 3; i++) failedHire("helper");
    expect(pickRescuer(failed, "anonymous")).toBeNull(); // its last three jobs failed
  });

  it("moves a job once: a second try, or the tick after the worker, does nothing", () => {
    const t = failedHire();
    expect(rescueTask(t.taskId, Date.now(), ON).moved).toBe(true);
    expect(rescueTask(t.taskId, Date.now(), ON)).toEqual({ moved: false, why: "already handled" });
    expect(sweepFailures(Date.now(), ON).filter((r) => r.moved)).toHaveLength(0);
    expect(getDb().prepare("SELECT COUNT(*) n FROM tasks WHERE to_agent = 'helper'").get()).toEqual({ n: 1 });
  });

  it("does not move a moved job that fails again", () => {
    const t = failedHire();
    const { taskId } = rescueTask(t.taskId, Date.now(), ON);
    failTask(taskId!, "Upstream inference timeout");
    expect(rescueTask(taskId!, Date.now(), ON).moved).toBe(false);
  });

  it("leaves refusals, stopped jobs, follow-ups, agent-to-agent work, the network's own jobs and old failures alone", () => {
    const now = Date.now();
    expect(whyNotRescue(failedHire("broken", { error: "I have to decline this request" }), now)).toMatch(/turned it down/);
    expect(whyNotRescue(failedHire("broken", { error: "Client disconnected" }), now)).toMatch(/stopped/);
    const first = createTask({ fromAgent: "anonymous", toAgent: "broken", task: "first" });
    expect(whyNotRescue(failedHire("broken", { parentTaskId: first.taskId }), now)).toMatch(/follow-up/);
    expect(whyNotRescue(failedHire("broken", { from: "helper" }), now)).toMatch(/an agent hired it/);
    expect(whyNotRescue(failedHire("broken", { context: { source: "axon-network-activity", automated: true } }), now)).toMatch(/not a hire/);
    expect(whyNotRescue(failedHire(), now + (RESCUE.withinMinutes + 1) * 60_000)).toMatch(/too long ago/);
  });

  it("records a failure nobody can take, and the job then shows as failed", () => {
    getDb().exec("DELETE FROM agents WHERE agent_id = 'helper'");
    const t = failedHire();
    expect(rescueView(t, Date.now(), ON)).toEqual({ rescuing: true }); // before anyone looked: keep looking
    expect(rescueTask(t.taskId, Date.now(), ON)).toMatchObject({ moved: false, why: "no agent can take it" });
    expect(recentJobs(5, "rescue")[0]).toMatchObject({ outcome: "not-moved" });
    expect(rescueView(t, Date.now(), ON)).toEqual({});
  });

  it("moves at most a few of one agent's failures a day; past that a failure ends as before", () => {
    const results = Array.from({ length: RESCUE.perAgentPerDay + 1 }, () => rescueTask(failedHire().taskId, Date.now(), ON));
    expect(results.filter((r) => r.moved)).toHaveLength(RESCUE.perAgentPerDay);
    expect(results.at(-1)).toMatchObject({ moved: false, why: "this agent's moves for today are used" });
  });

  it("carries the files the person attached", () => {
    const t = failedHire();
    getDb().prepare("INSERT INTO task_files (id, sha256, name, mime, kind, size, direction, task_id, created_at, expires_at) VALUES ('f1', 'abc', 'cafe-page.png', 'image/png', 'image', 100, 'in', ?, ?, ?)")
      .run(t.taskId, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());
    const { taskId } = rescueTask(t.taskId, Date.now(), ON);
    expect(getDb().prepare("SELECT name, sha256, source_task_id FROM task_files WHERE task_id = ?").all(taskId)).toEqual([{ name: "cafe-page.png", sha256: "abc", source_task_id: t.taskId }]);
  });

  it("picks up failures from outside the worker on the tick", async () => {
    const t = failedHire();
    const r = await tick(Date.now(), ON);
    expect(r.ran).toContain("rescue");
    expect(rescueView(getTaskById(t.taskId)!, Date.now(), ON).rescued?.agentId).toBe("helper");
  });
});

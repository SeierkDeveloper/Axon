import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createTask, failTask, getTaskById } from "@/lib/tasks";
import { react, TICK_MINUTES } from "@/lib/autonomy3React";
import { recentJobs, tick } from "@/lib/autonomy3";
import { rescueView } from "@/lib/autonomy3Rescue";
import "@/lib/autonomy3Parts";
import type { Agent } from "@/sdk/types";

const ON = { AUTONOMY3: "on", AUTONOMY3_REACT: "on" };

function agent(id: string, caps = ["translation", "localisation"]) {
  createAgent({ agentId: id, name: `Agent ${id}`, capabilities: caps, publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt: new Date().toISOString() } as Agent);
}
const paused = (id: string) => (getDb().prepare("SELECT routing_paused_at FROM agents WHERE agent_id = ?").get(id) as { routing_paused_at: string | null }).routing_paused_at;

beforeEach(() => {
  const db = getDb();
  for (const t of ["tasks", "agents", "autonomy3_jobs"]) db.exec(`DELETE FROM ${t}`);
  for (let i = 0; i < 30; i++) agent(`fine-${i}`);
});

describe("reacts in minutes", () => {
  it("ticks every few minutes", () => {
    expect(TICK_MINUTES).toBeLessThanOrEqual(5);
  });

  it("takes an agent out of routing as soon as it fails three in a row, and records what it did", async () => {
    agent("wobbly");
    for (let i = 0; i < 3; i++) failTask(createTask({ fromAgent: "anonymous", toAgent: "wobbly", task: "x" }).taskId, "model error");
    const done = await react(Date.now(), ON);
    expect(done.map((f) => `${f.kind}:${f.subject}`)).toEqual(["agent-paused:wobbly"]);
    expect(paused("wobbly")).not.toBeNull();
    expect(recentJobs(5, "react")[0]).toMatchObject({ outcome: "acted", summary: "took 1 failing agent out of routing" });
  });

  it("frees a job nobody picked up, and that job is then moved to another agent", async () => {
    agent("helper", ["translation", "localisation"]);
    agent("gone", ["translation", "localisation"]);
    const t = createTask({ fromAgent: "anonymous", toAgent: "gone", task: "translate this" });
    getDb().prepare("UPDATE tasks SET created_at = ? WHERE task_id = ?").run(new Date(Date.now() - 3 * 3_600_000).toISOString(), t.taskId);
    const r = await tick(Date.now(), { ...ON, AUTONOMY3_RESCUE: "on" });
    expect(r.ran).toEqual(["rescue", "react"]);
    expect(getTaskById(t.taskId)?.status).toBe("failed");
    // the next tick moves it, as it would any failure from outside the worker
    await tick(Date.now(), { ...ON, AUTONOMY3_RESCUE: "on" });
    expect(rescueView(getTaskById(t.taskId)!, Date.now(), { ...ON, AUTONOMY3_RESCUE: "on" }).rescued).toBeDefined();
  });

  it("changes nothing with Autonomy 2's actions switched off, or with the part off, and records nothing when all is well", async () => {
    agent("wobbly");
    for (let i = 0; i < 3; i++) failTask(createTask({ fromAgent: "anonymous", toAgent: "wobbly", task: "x" }).taskId, "model error");
    expect(await react(Date.now(), { ...ON, AUTONOMY_ACTIONS: "off" })).toEqual([]);
    expect(await react(Date.now(), { AUTONOMY3: "on" })).toEqual([]);
    expect(paused("wobbly")).toBeNull();
    getDb().exec("DELETE FROM tasks");
    expect(await react(Date.now(), ON)).toEqual([]);
    expect(recentJobs(5, "react")).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { rankAgents } from "@/lib/routing";
import { pauseFailing, retestPaused, reweightSlow, routingActions } from "@/lib/autonomyActions";
import { failingAgents, type Finding } from "@/lib/networkChecks";
import type { Agent } from "@/sdk/types";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");

function agent(id: string) {
  createAgent({
    agentId: id, name: `Agent ${id}`, capabilities: ["routing-test"], publicKey: `pk-${id}`,
    provider: "anthropic", reputation: 5, createdAt: new Date(NOW).toISOString(),
  } as Agent);
}
const state = (id: string) =>
  getDb().prepare("SELECT routing_paused_at, routing_passes, routing_weight, routing_restored_at FROM agents WHERE agent_id = ?").get(id) as
    { routing_paused_at: string | null; routing_passes: number; routing_weight: number; routing_restored_at: string | null };
const failing = (id: string): Finding => ({ kind: "agent-failing", subject: id, what: "failing" });

beforeEach(() => {
  const db = getDb();
  db.exec("DELETE FROM tasks");
  db.exec("DELETE FROM agents");
  delete process.env.AUTONOMY_ACTIONS;
});
afterEach(() => {
  delete process.env.AUTONOMY_ACTIONS;
});

describe("routing respects autonomy", () => {
  it("skips a paused agent and sends a slow one less work", () => {
    for (const id of ["a", "b", "c"]) agent(id);
    getDb().prepare("UPDATE agents SET routing_paused_at = ? WHERE agent_id = 'a'").run(new Date(NOW).toISOString());
    getDb().prepare("UPDATE agents SET routing_weight = 0.25 WHERE agent_id = 'b'").run();
    const ranked = rankAgents({ capability: "routing-test" });
    expect(ranked.map((r) => r.agent.agentId)).not.toContain("a");
    expect(ranked[0].agent.agentId).toBe("c"); // b is equal but weighted down
  });
});

describe("pausing", () => {
  it("pauses failing agents, unreachable first, within the budget", () => {
    for (let i = 0; i < 60; i++) agent(`n${i}`);
    const found: Finding[] = [failing("n1"), failing("n2"), { kind: "agent-unreachable", subject: "n3", what: "down" }];
    const out = pauseFailing(found, NOW);
    expect(out.map((f) => f.subject)).toEqual(["n3", "n1", "n2"]);
    expect(state("n3").routing_paused_at).not.toBeNull();
  });

  it("treats many failures at once as an outage and pauses nobody", () => {
    for (let i = 0; i < 20; i++) agent(`m${i}`);
    const out = pauseFailing(Array.from({ length: 10 }, (_, i) => failing(`m${i}`)), NOW);
    expect(out.map((f) => f.kind)).toEqual(["outage"]);
    expect(state("m0").routing_paused_at).toBeNull();
  });

  it("never pauses a small network's last agents", () => {
    for (let i = 0; i < 5; i++) agent(`s${i}`);
    expect(pauseFailing([failing("s0")], NOW)).toEqual([]);
  });
});

describe("re-testing and restoring", () => {
  it("puts an agent back after two passes in a row, three hours apart", async () => {
    agent("p");
    getDb().prepare("UPDATE agents SET routing_paused_at = ? WHERE agent_id = 'p'").run(new Date(NOW - HOUR).toISOString());
    const pass = async () => true;
    expect((await retestPaused(pass, NOW)).map((f) => f.kind)).toEqual(["agent-retested"]);
    expect(await retestPaused(pass, NOW + HOUR)).toEqual([]); // not due yet
    expect((await retestPaused(pass, NOW + 3 * HOUR + 1)).map((f) => f.kind)).toEqual(["agent-restored"]);
    expect(state("p").routing_paused_at).toBeNull();
    expect(state("p").routing_restored_at).not.toBeNull();
  });

  it("a failed re-test starts the count again", async () => {
    agent("q");
    getDb().prepare("UPDATE agents SET routing_paused_at = ?, routing_passes = 1 WHERE agent_id = 'q'").run(new Date(NOW - HOUR).toISOString());
    await retestPaused(async () => false, NOW);
    expect(state("q").routing_passes).toBe(0);
    expect(state("q").routing_paused_at).not.toBeNull();
  });

  it("judges a restored agent only on work done since", () => {
    agent("r");
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      db.prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, started_at, completed_at) VALUES (?, 'x', 'r', 't', 'failed', ?, ?, ?)")
        .run(randomUUID(), new Date(NOW - 5 * HOUR).toISOString(), new Date(NOW - 5 * HOUR).toISOString(), new Date(NOW - (5 - i * 0.1) * HOUR).toISOString());
    }
    expect(failingAgents(NOW).map((f) => f.subject)).toContain("r");
    db.prepare("UPDATE agents SET routing_restored_at = ? WHERE agent_id = 'r'").run(new Date(NOW - HOUR).toISOString());
    expect(failingAgents(NOW).map((f) => f.subject)).not.toContain("r");
  });
});

describe("slow agents", () => {
  it("lowers a slow agent's weight and gives it back once it is not slow", () => {
    agent("slow");
    reweightSlow([{ kind: "slow-agent", subject: "slow", what: "slow" }]);
    expect(state("slow").routing_weight).toBe(0.25);
    reweightSlow([]);
    expect(state("slow").routing_weight).toBe(1);
  });
});

describe("the switch", () => {
  it("does nothing on a dry run, nor with AUTONOMY_ACTIONS=off", async () => {
    for (let i = 0; i < 60; i++) agent(`k${i}`);
    expect(await routingActions([failing("k1")], { apply: false, retest: async () => true, now: NOW })).toEqual([]);
    process.env.AUTONOMY_ACTIONS = "off";
    expect(await routingActions([failing("k1")], { apply: true, retest: async () => true, now: NOW })).toEqual([]);
    expect(state("k1").routing_paused_at).toBeNull();
  });

  it("does not pause again an agent it just put back", async () => {
    for (let i = 0; i < 60; i++) agent(`j${i}`);
    getDb().prepare("UPDATE agents SET routing_paused_at = ?, routing_passes = 1 WHERE agent_id = 'j1'").run(new Date(NOW - 4 * HOUR).toISOString());
    const out = await routingActions([failing("j1")], { apply: true, retest: async () => true, now: NOW });
    expect(out.map((f) => f.kind)).toEqual(["agent-restored"]);
    expect(state("j1").routing_paused_at).toBeNull();
  });
});

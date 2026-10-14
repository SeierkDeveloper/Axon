import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { testAgent, testQueue, testTurn, type TestModels } from "@/lib/autonomy3Test";
import { recentJobs } from "@/lib/autonomy3";
import "@/lib/autonomy3Parts";
import type { Agent } from "@/sdk/types";

const ON = { AUTONOMY3: "on", AUTONOMY3_TEST: "on" };
const NOW = Date.parse("2026-10-14T00:10:00Z");

function agent(id: string, caps: string[], extra: Partial<Agent> = {}, createdAt = "2026-10-01T00:00:00Z") {
  createAgent({ agentId: id, name: `Agent ${id}`, capabilities: caps, publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt, ...extra } as Agent);
}

/** Fake models: the agent answers with `answer` (or throws), the grader gives `score`. */
function models(answer: string | Error, score: number, seen: { tasks: string[]; graded: number; written: number } = { tasks: [], graded: 0, written: 0 }): TestModels {
  return {
    answer: async (_a, task) => { seen.tasks.push(task); if (answer instanceof Error) throw answer; return answer; },
    grader: async (system) => {
      if (/write one test job/i.test(system)) { seen.written++; return `[{"task":"Summarise this note in two lines: the meeting moved to Friday at 10, bring the Q3 numbers.","lookFor":"two lines"}]`; }
      seen.graded++;
      return `{"score": ${score}, "feedback": "fine"}`;
    },
  };
}
const paused = (id: string) => (getDb().prepare("SELECT routing_paused_at FROM agents WHERE agent_id = ?").get(id) as { routing_paused_at: string | null }).routing_paused_at;

beforeEach(() => {
  const db = getDb();
  for (const t of ["tasks", "agents", "autonomy3_jobs"]) db.exec(`DELETE FROM ${t}`);
  for (let i = 0; i < 30; i++) agent(`filler-${i}`, ["filler"], {}, "2026-09-01T00:00:00Z");
});

describe("tests every agent: whose turn", () => {
  it("tests a new agent first, then the one tested longest ago, and never an agent on its own server or an orchestrator", async () => {
    getDb().exec("DELETE FROM agents");
    agent("old", ["translation"], {}, "2026-09-01T00:00:00Z");
    agent("new", ["translation"], {}, "2026-10-13T00:00:00Z");
    agent("remote", ["translation"], { endpoint: "https://example.com/a" }, "2026-10-13T12:00:00Z");
    agent("boss", ["translation"], { orchestrator: true }, "2026-10-13T12:00:00Z");
    expect(testQueue(5)).toEqual(["new", "old"]);
    await testAgent("new", NOW, ON, models("Hola", 8));
    expect(testQueue(5)).toEqual(["old", "new"]);
  });
});

describe("tests every agent: one test", () => {
  it("gives the agent one of its starter jobs, grades the answer and records the score", async () => {
    agent("translator", ["text translation"]);
    const seen = { tasks: [] as string[], graded: 0, written: 0 };
    const r = await testAgent("translator", NOW, ON, models("Gracias por tu pedido.", 8, seen));
    expect(r).toMatchObject({ outcome: "passed", score: 8 });
    expect(seen.tasks[0]).toMatch(/Translate this into Spanish/);
    expect(seen.written).toBe(0);
    const [job] = recentJobs(5, "test");
    expect(job).toMatchObject({ subject: "translator", outcome: "passed", summary: 'Agent translator scored 8/10 on "Translate a message"' });
    expect(job.detail).toMatchObject({ score: 8, feedback: "fine", paused: false });
  });

  it("writes a job for an agent no starter fits", async () => {
    agent("odd", ["astrology readings"]);
    const seen = { tasks: [] as string[], graded: 0, written: 0 };
    await testAgent("odd", NOW, ON, models("Moved to Friday 10:00. Bring Q3.", 7, seen));
    expect(seen.written).toBe(1);
    expect(seen.tasks[0]).toMatch(/meeting moved to Friday/);
  });

  it("calls a low score weak and leaves it, and takes an agent that fails its test out of routing", async () => {
    agent("meh", ["text translation"]);
    agent("dead", ["text translation"]);
    agent("silent", ["text translation"]);
    expect((await testAgent("meh", NOW, ON, models("hmm", 4)))?.outcome).toBe("weak");
    expect(paused("meh")).toBeNull();
    expect((await testAgent("dead", NOW, ON, models("no", 1)))?.outcome).toBe("failed");
    expect(paused("dead")).not.toBeNull();
    const silent = await testAgent("silent", NOW, ON, models(new Error("model not found"), 9));
    expect(silent).toMatchObject({ outcome: "failed", score: null });
    expect(silent?.summary).toMatch(/did not answer.*model not found.*taken out of routing/);
  });

  it("does not pause anyone with Autonomy 2's actions switched off", async () => {
    agent("dead", ["text translation"]);
    await testAgent("dead", NOW, { ...ON, AUTONOMY_ACTIONS: "off" }, models("no", 0));
    expect(paused("dead")).toBeNull();
  });
});

describe("tests every agent: the day's number", () => {
  it("runs one test when it is the part's turn, and waits for the next when the day's tests so far are done", async () => {
    agent("translator", ["text translation"], {}, "2026-10-13T00:00:00Z");
    expect(await testTurn(NOW, {}, models("x", 8))).toBeNull(); // switched off
    expect(await testTurn(NOW, ON, models("x", 8))).toMatchObject({ outcome: "passed" });
    expect(await testTurn(NOW + 60_000, ON, models("x", 8))).toBeNull(); // the next of 45 is due about half an hour on
    expect(await testTurn(NOW + 40 * 60_000, ON, models("x", 8))).not.toBeNull();
  });
});

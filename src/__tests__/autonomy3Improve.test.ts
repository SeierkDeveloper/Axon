import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent, getAgentById } from "@/lib/agents";
import { getInstructions, setInstructions } from "@/lib/agentKnowledge";
import { getAgentSystem } from "@/lib/providers";
import { startJob, finishJob, recentJobs } from "@/lib/autonomy3";
import { improveAgent3, improveQueue, improveTurn, rollBackSlips, setAutoImprove, evidenceFor, type ImproveModels } from "@/lib/autonomy3Improve";
import "@/lib/autonomy3Parts";
import type { Agent } from "@/sdk/types";

const NOW = Date.parse("2026-10-14T00:10:00Z");
const ON = { AUTONOMY3: "on", AUTONOMY3_IMPROVE: "on" };

function agent(id: string) {
  createAgent({ agentId: id, name: `Agent ${id}`, capabilities: ["translation"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z" } as Agent);
  setInstructions(id, "Translate what you are given. Keep the tone of the original and answer with the translation only.");
}
/** A graded test of the agent, as phase 4 records it. */
function tested(id: string, score: number, at = NOW - 3_600_000) {
  const j = startJob("test", id, at)!;
  finishJob(j, { outcome: score >= 6 ? "passed" : "weak", detail: { task: `Translate job ${score}`, answer: `old answer ${score}`, score, feedback: "mixed du and Sie" } }, at);
}
/** The writer returns a new version; the new version's answers get `newScore`. */
function models(newScore: number, calls = { write: 0, answer: 0, grade: 0 }): ImproveModels {
  return {
    write: async () => { calls.write++; return "<instructions>Translate what you are given. Keep one register throughout: never mix du and Sie, or tu and usted. Answer with the translation only.</instructions>"; },
    answer: async (_a, system, task) => { calls.answer++; return `new answer to ${task} under ${system.length} chars of system`; },
    grade: async (_s, prompt) => { calls.grade++; return `{"score": ${prompt.includes("new answer") ? newScore : 5}, "feedback": "ok"}`; },
  };
}

beforeEach(() => {
  for (const t of ["tasks", "agents", "autonomy3_jobs"]) getDb().exec(`DELETE FROM ${t}`);
});

describe("makes agents better: who and what", () => {
  it("only tries agents whose owner switched it on, and only when something went wrong", () => {
    agent("t1"); agent("t2"); agent("t3");
    tested("t1", 5); tested("t2", 5); tested("t3", 9);
    setAutoImprove("t2", true); setAutoImprove("t3", true);
    expect(improveQueue(NOW)).toEqual(["t2"]); // t1 not switched on, t3 has nothing to fix
    expect(evidenceFor("t2", NOW).tests[0]).toMatchObject({ score: 5, feedback: "mixed du and Sie" });
  });
});

describe("makes agents better: one attempt", () => {
  it("keeps a new version that beats the old one on the same jobs, reusing the old answers, and keeps the old instructions to go back to", async () => {
    agent("t");
    setAutoImprove("t", true);
    tested("t", 5); tested("t", 6, NOW - 7_200_000);
    const calls = { write: 0, answer: 0, grade: 0 };
    const before = getInstructions("t");
    const r = await improveAgent3("t", NOW, ON, models(9, calls));
    expect(r).toMatchObject({ outcome: "kept", from: 5.5, to: 9 });
    expect(calls).toEqual({ write: 1, answer: 2, grade: 2 }); // the old answers were graded already: only the new ones are run and graded
    expect(getInstructions("t")).toMatch(/never mix du and Sie/);
    expect(recentJobs(5, "improve")[0].detail).toMatchObject({ previous: before, kept: true });
  });

  it("keeps the old version when the new one is not clearly better", async () => {
    agent("t");
    setAutoImprove("t", true);
    tested("t", 5); tested("t", 6, NOW - 7_200_000);
    const before = getInstructions("t");
    expect(await improveAgent3("t", NOW, ON, models(5))).toMatchObject({ outcome: "not-better" });
    expect(getInstructions("t")).toBe(before);
  });

  it("improves one of Axon's own agents only once switched on, and then its improved version is what it runs on", async () => {
    createAgent({ agentId: "research-agent", name: "Research Agent", capabilities: ["research"], publicKey: "pk", provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z" } as Agent);
    const code = getAgentSystem(getAgentById("research-agent")!);
    tested("research-agent", 4); tested("research-agent", 5, NOW - 7_200_000);
    setAutoImprove("research-agent", true);
    expect((await improveAgent3("research-agent", NOW, ON, models(9)))?.outcome).toBe("kept");
    expect(getAgentSystem(getAgentById("research-agent")!)).toMatch(/never mix du and Sie/);
    setAutoImprove("research-agent", false);
    expect(getAgentSystem(getAgentById("research-agent")!)).toBe(code);
  });
});

describe("makes agents better: an agent on the general prompt", () => {
  it("improves an agent with no instructions of its own from the general prompt, and going back clears them", async () => {
    createAgent({ agentId: "plain", name: "Plain", capabilities: ["translation"], publicKey: "pk-plain", provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z" } as Agent);
    tested("plain", 4); tested("plain", 5, NOW - 7_200_000);
    setAutoImprove("plain", true);
    expect(getInstructions("plain")).toBeNull();
    expect((await improveAgent3("plain", NOW, ON, models(9)))?.outcome).toBe("kept");
    expect(getAgentSystem(getAgentById("plain")!)).toMatch(/never mix du and Sie/);
    expect(recentJobs(5, "improve")[0].detail).toMatchObject({ previous: null });
  });
});

describe("makes agents better: slipping", () => {
  it("puts the old instructions back when the tests after the change score lower than before", async () => {
    agent("t");
    setAutoImprove("t", true);
    tested("t", 6); tested("t", 6, NOW - 7_200_000);
    const before = getInstructions("t");
    await improveAgent3("t", NOW, ON, models(9));
    expect(rollBackSlips(NOW + 60_000)).toEqual([]); // nothing since
    tested("t", 3, NOW + 3_600_000); tested("t", 4, NOW + 7_200_000);
    expect(rollBackSlips(NOW + 8_000_000)).toEqual(["t"]);
    expect(getInstructions("t")).toBe(before);
    expect(recentJobs(10, "improve")[0]).toMatchObject({ outcome: "rolled-back" });
  });

  it("does nothing while switched off, and one attempt per turn when on", async () => {
    agent("t"); setAutoImprove("t", true); tested("t", 4); tested("t", 5, NOW - 7_200_000);
    expect(await improveTurn(NOW, {}, models(9))).toBeNull();
    expect((await improveTurn(NOW, ON, models(9)))?.outcome).toBe("kept");
    expect(await improveTurn(NOW + 60_000, ON, models(9))).toBeNull();
  });
});

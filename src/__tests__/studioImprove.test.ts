import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/lib/embeddings")>()),
  generateEmbedding: async () => null, embedQuery: async () => null, semanticSearchAgents: async () => null, scheduleAgentEmbedding: () => {},
}));
vi.mock("@/lib/holderTier", async (orig) => ({
  ...(await orig<typeof import("@/lib/holderTier")>()),
  getTier: async () => ({ tier: { name: "operator", minimum: 0, rank: 3 }, balance: 0, stale: false }),
}));

import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { getInstructions } from "@/lib/agentKnowledge";
import { startDraft } from "@/lib/studioDraft";
import { runBuild, type Models } from "@/lib/studioTest";
import { publishBuild, studioInfo } from "@/lib/studioPublish";
import { improveAgent, decideImprovement, improvementsOf, improveStudioAgents, weakJobs } from "@/lib/studioImprove";
import { STUCK } from "@/lib/autonomyPolicy";
import { checkEligibility } from "@/lib/agentLaunch";

let n = 0;
const wallet = () => `0x${(++n + 3_300_000).toString(16).padStart(40, "0")}`;
const TASKS = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ task: `Summarise call ${i}: revenue rose 12%...`, lookFor: "five bullets" })));
const NEW = "<instructions>VERSION NEW. You turn an earnings call into five bullets, and when the input is a press release you still write the brief.</instructions><tests>[{\"task\":\"Here is a press release, brief it: sales up 4%\",\"lookFor\":\"still five bullets\"}]</tests>";

/** Answers under the NEW instructions score `newScore`, under the old ones `oldScore`. */
const models = (oldScore: number, newScore: number, rewrite = NEW): Models => ({
  tasks: async () => TASKS,
  answer: async (_m, system) => (system.includes("VERSION NEW") ? "new answer" : "old answer"),
  grade: async (_s, prompt) => JSON.stringify({ score: prompt.includes("new answer") ? newScore : oldScore, feedback: "x" }),
  rewrite: async () => rewrite,
});

async function liveAgent(me: string) {
  const b = await startDraft(me, "An agent that turns any earnings call into a five bullet brief", async () => JSON.stringify({
    name: `Live Brief ${n}`, handle: `live-brief-${n}`, category: "Finance", description: "Five bullets from a call.", capabilities: ["earnings analysis"],
    instructions: "You turn an earnings call transcript into exactly five bullets for investors, revenue first, guidance quoted exactly.", model: "claude-sonnet-5", tools: [],
  }));
  if (typeof b === "string") throw new Error(b);
  await runBuild(b.id, models(8, 8));
  return (publishBuild(b.id, me) as { agentId: string }).agentId;
}
const failJob = (agentId: string, error = "The output ignored the press release") =>
  getDb().prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, status, error, created_at) VALUES (?, 'buyer', ?, 'brief this press release from ACME Corp', 'failed', ?, ?)")
    .run(randomUUID(), agentId, error, new Date().toISOString());

describe("a live Studio agent improves from its real jobs", () => {
  it("waits for enough weak jobs, and does not count the tasks Axon itself closed", async () => {
    const me = wallet();
    const id = await liveAgent(me);
    failJob(id); failJob(id);
    failJob(id, STUCK.reasons.notPickedUp);
    expect(weakJobs(id, new Date(0).toISOString())).toHaveLength(2);
    expect(await improveAgent(id, models(6, 9))).toBe("not-enough");
  });

  it("proposes a version that beats the current one on the same tests, and only the owner applies it", async () => {
    const me = wallet();
    const id = await liveAgent(me);
    failJob(id); failJob(id); failJob(id);
    expect(await improveAgent(id, models(6, 9))).toBe("proposed");
    const [p] = improvementsOf(id);
    expect(p).toMatchObject({ status: "proposed", weakJobs: 3, fromScore: 6, toScore: 9 });
    expect(getInstructions(id)).not.toContain("VERSION NEW"); // nothing changes unasked
    expect(decideImprovement(p.id, wallet(), true)).toMatch(/No such proposal/);
    expect(decideImprovement(p.id, me, true)).toEqual({ ok: true });
    expect(getInstructions(id)).toContain("VERSION NEW");
    expect(studioInfo(id)?.score).toBe(9);
    expect(decideImprovement(p.id, me, true)).toMatch(/no longer open/);
  });

  it("keeps the agent as it is when the new version is not clearly better", async () => {
    const me = wallet();
    const id = await liveAgent(me);
    failJob(id); failJob(id); failJob(id);
    expect(await improveAgent(id, models(8, 8.2))).toBe("no-better");
    expect(getInstructions(id)).not.toContain("VERSION NEW");
  });

  it("refuses a rewrite that fails the content check or brings no new tests", async () => {
    const me = wallet();
    const id = await liveAgent(me);
    failJob(id); failJob(id); failJob(id);
    expect(await improveAgent(id, models(6, 9, "<instructions>VERSION NEW. Long enough instructions for the agent to be tested properly, quoting guidance.</instructions>"))).toBe("failed");
  });

  it("a published Studio agent can launch its token from its owner's wallet, with no endpoint of its own", async () => {
    const me = wallet();
    const id = await liveAgent(me);
    expect(checkEligibility(id, me)).toMatchObject({ eligible: true });
    expect(checkEligibility(id, wallet())).toMatchObject({ eligible: false });
  });

  it("the hourly pass tries each agent at most once a day", async () => {
    const me = wallet();
    const id = await liveAgent(me);
    failJob(id); failJob(id); failJob(id);
    const first = await improveStudioAgents(models(6, 9));
    expect(first.tried).toContain(id);
    failJob(id); failJob(id); failJob(id);
    const second = await improveStudioAgents(models(6, 9));
    expect(second.tried).not.toContain(id);
  });
});

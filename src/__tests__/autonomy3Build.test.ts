import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent, getAgentById } from "@/lib/agents";
import { recentJobs, startJob, finishJob } from "@/lib/autonomy3";
import { missingSkills, buildFor, buildTurn, builderWallet, sentenceFor } from "@/lib/autonomy3Build";
import { testQueue } from "@/lib/autonomy3Test";
import "@/lib/autonomy3Parts";
import type { Models } from "@/lib/studioTest";
import type { Agent } from "@/sdk/types";

const WALLET = "0x1111111111111111111111111111111111111111";
const ENV = { AUTONOMY3: "on", AUTONOMY3_BUILD: "on", AUTONOMY3_BUILDER_WALLET: WALLET };
const NOW = Date.parse("2026-10-14T00:10:00Z");

const writer = async () => JSON.stringify({
  name: "Tide Table Reader", handle: "tide-table-reader", description: "Reads tide tables and says when it is safe to launch a small boat.",
  capabilities: ["tide tables", "boating"], category: "research",
  instructions: "You read tide tables people paste in and say, in plain words, the safe windows to launch and return a small boat. Always name the times and the heights you used, and say when the table is unclear.",
  model: "claude-sonnet-5", tools: [],
});
/** Studio's test rounds, faked: every answer is graded `score`. */
const models = (score: number): Models => ({
  tasks: async () => JSON.stringify([1, 2, 3, 4].map((i) => ({ task: `Here is a tide table for day ${i}: high 06:10 4.2m, low 12:30 0.6m. When can I launch?`, lookFor: "names the safe window" }))),
  answer: async () => "Launch between 08:00 and 11:30, as the tide falls from 4.2 m toward 0.6 m at 12:30.",
  grade: async () => `{"score": ${score}, "feedback": "clear"}`,
  rewrite: async () => "<instructions>You read tide tables and name the safe windows to launch and return a small boat, with the times and heights used.</instructions>",
});

beforeEach(() => {
  for (const t of ["tasks", "agents", "autonomy3_jobs", "open_tasks", "studio_builds"]) getDb().exec(`DELETE FROM ${t}`);
  createAgent({ agentId: "writer-1", name: "Writer", capabilities: ["writing"], publicKey: "pk", provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z" } as Agent);
});

function asked(skill: string, times = 1) {
  for (let i = 0; i < times; i++) {
    getDb().prepare("INSERT INTO open_tasks (open_task_id, from_agent, task, capabilities, status, created_at) VALUES (?, 'anonymous', 'job', ?, 'open', ?)").run(`ot-${skill}-${i}`, JSON.stringify([skill]), new Date(NOW).toISOString());
  }
}

describe("builds the missing agents: the gaps", () => {
  it("lists skills asked for that at most one agent offers, nobody's first, then the most asked, and not one tried lately", () => {
    asked("tide tables", 3); asked("writing", 5); asked("sql tuning", 1);
    expect(missingSkills(NOW).map((g) => g.skill)).toEqual(["tide tables", "sql tuning", "writing"]); // writing: one agent offers it
    createAgent({ agentId: "writer-2", name: "Writer 2", capabilities: ["writing"], publicKey: "pk2", provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z" } as Agent);
    expect(missingSkills(NOW).map((g) => g.skill)).toEqual(["tide tables", "sql tuning"]);
    finishJob(startJob("build", "tide tables", NOW)!, { outcome: "not-listed" }, NOW);
    expect(missingSkills(NOW).map((g) => g.skill)).toEqual(["sql tuning"]);
  });

  it("counts the skills of agents whose failed jobs nobody could take", () => {
    createAgent({ agentId: "lonely", name: "Lonely", capabilities: ["kite repair"], publicKey: "pk3", provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z" } as Agent);
    finishJob(startJob("rescue", "task-1", NOW)!, { outcome: "not-moved", detail: { from: "lonely", reason: "no-agent" } }, NOW);
    expect(missingSkills(NOW)).toEqual([{ skill: "kite repair", asks: 1, offered: 1 }]);
  });
});

describe("builds the missing agents: one build", () => {
  it("builds with Studio and lists the agent when it passes, owned by the builder wallet, and it is tested first", async () => {
    const r = await buildFor("tide tables", NOW, ENV, { writer, models: models(8) });
    expect(r).toMatchObject({ outcome: "listed", agentId: "tide-table-reader", score: 8 });
    expect(getAgentById("tide-table-reader")?.walletAddress?.toLowerCase()).toBe(WALLET);
    expect(recentJobs(5, "build")[0]).toMatchObject({ subject: "tide tables", outcome: "listed" });
    expect(testQueue(1)).toEqual(["tide-table-reader"]); // never tested, and the newest
    expect(getDb().prepare("SELECT sentence FROM studio_builds").get()).toEqual({ sentence: sentenceFor("tide tables") });
  });

  it("keeps it a draft when it scores under Studio's bar", async () => {
    const r = await buildFor("tide tables", NOW, ENV, { writer, models: models(3) });
    expect(r).toMatchObject({ outcome: "not-listed", score: 3 });
    expect(getAgentById("tide-table-reader")).toBeNull();
  });

  it("builds nothing without the builder wallet, or with the part off, and one build every other day", async () => {
    asked("tide tables", 2);
    expect(builderWallet({})).toBeNull();
    expect(await buildTurn(NOW, { AUTONOMY3: "on", AUTONOMY3_BUILD: "on" }, { writer, models: models(8) })).toBeNull();
    expect(await buildTurn(NOW, { AUTONOMY3: "on", AUTONOMY3_BUILDER_WALLET: WALLET }, { writer, models: models(8) })).toBeNull();
    expect(await buildTurn(NOW, ENV, { writer, models: models(8) })).toMatchObject({ outcome: "listed" });
    asked("sql tuning", 1);
    expect(await buildTurn(NOW + 3_600_000, ENV, { writer, models: models(8) })).toBeNull(); // the next is due in two days
  });
});

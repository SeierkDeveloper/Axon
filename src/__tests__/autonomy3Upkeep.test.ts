import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { getTaskById, completeTask, failTask, startTask } from "@/lib/tasks";
import { startJob, finishJob, recentJobs, tick } from "@/lib/autonomy3";
import { upkeepTurn, fileFinished, nextChore, choreAgent, secondOpinionsOn, latestReport, yesterdayInWords, UPKEEP } from "@/lib/autonomy3Upkeep";
import { evidenceFor } from "@/lib/autonomy3Improve";
import { whyNotRescue } from "@/lib/autonomy3Rescue";
import "@/lib/autonomy3Parts";
import type { Agent } from "@/sdk/types";

const ON = { AUTONOMY3: "on", AUTONOMY3_UPKEEP: "on" };
const NOW = Date.parse("2026-10-14T01:00:00Z");

function agent(id: string, caps: string[], extra: Partial<Agent> = {}) {
  createAgent({ agentId: id, name: `Agent ${id}`, capabilities: caps, publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z", ...extra } as Agent);
}
function weakTest(id: string, at = NOW - 3_600_000) {
  const j = startJob("test", id, at)!;
  finishJob(j, { outcome: "weak", detail: { task: "Translate: thanks for your order", answer: "Danke Sie du", score: 4, feedback: "mixed du and Sie" } }, at);
  return j;
}

beforeEach(() => {
  for (const t of ["tasks", "agents", "autonomy3_jobs"]) getDb().exec(`DELETE FROM ${t}`);
  agent("writer", ["writing", "summarization"]);
  agent("paid-writer", ["writing"], { price: "0.001 ETH" });
  agent("editor", ["editing", "proofreading"]);
  agent("translator", ["translation"]);
});

describe("hires its own agents: who", () => {
  it("hires a free agent that runs on Axon, with the skill the chore needs, never the agent a second opinion is about", () => {
    expect(choreAgent("report")?.agentId).toBe("writer");
    expect(choreAgent("review")?.agentId).toBe("editor");
    expect(choreAgent("review", ["editor"])?.agentId).toBe("writer");
  });
});

describe("hires its own agents: the daily report", () => {
  it("hires a writing agent for yesterday's report once a day, after the replay, as a real job of the network's own", async () => {
    finishJob(startJob("rescue", "t-1", NOW - 10 * 3_600_000)!, { outcome: "moved", summary: "X failed it; moved to Y" }, NOW - 10 * 3_600_000);
    expect(yesterdayInWords(NOW)).toMatch(/rescue moved: 1[\s\S]*X failed it; moved to Y/);
    expect(nextChore(Date.parse("2026-10-14T00:10:00Z"))).toBeNull(); // before the replay is in
    const hired = (await upkeepTurn(NOW, ON))!;
    expect(hired).toMatchObject({ chore: "report", agentId: "writer" });
    const t = getTaskById(hired.taskId)!;
    expect(t).toMatchObject({ fromAgent: UPKEEP.hirer, status: "queued" });
    expect(t.context).toMatchObject({ source: UPKEEP.source, automated: true, chore: "report" });
    expect(whyNotRescue({ ...t, status: "failed", completedAt: new Date().toISOString() })).toMatch(/not a hire/);
    expect(nextChore(NOW + 60_000)?.chore).not.toBe("report"); // once a day
  });

  it("files the report when the job is done, with its receipt", async () => {
    const { taskId } = (await upkeepTurn(NOW, ON))!;
    startTask(taskId, "worker");
    completeTask(taskId, "Yesterday the network moved one failed job and found nothing else wrong. A healthy day.");
    expect(fileFinished(NOW + 60_000)).toBe(1);
    expect(latestReport()).toMatchObject({ by: "writer", receipt: `/r/${taskId}`, text: expect.stringMatching(/healthy day/) });
    expect(recentJobs(5, "upkeep")[0]).toMatchObject({ outcome: "done", summary: "Agent writer wrote yesterday's report" });
  });

  it("records a chore that failed", async () => {
    const { taskId } = (await upkeepTurn(NOW, ON))!;
    failTask(taskId, "model down");
    fileFinished(NOW + 60_000);
    expect(recentJobs(5, "upkeep")[0]).toMatchObject({ outcome: "failed" });
  });
});

describe("hires its own agents: second opinions", () => {
  it("asks a reviewing agent about a weak test answer, and makes-agents-better reads what it said", async () => {
    finishJob(startJob("upkeep", "report-done", NOW - 1000)!, { outcome: "done" }, NOW - 1000); // today's report slot is not this test's point
    getDb().prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, context, status, created_at) VALUES ('report-done', ?, 'writer', 'r', ?, 'completed', ?)").run(UPKEEP.hirer, JSON.stringify({ source: UPKEEP.source, chore: "report" }), new Date(NOW).toISOString());
    const testJob = weakTest("translator");
    const NOON = NOW + 11 * 3_600_000; // the day's second chore is due by then
    const hired = (await upkeepTurn(NOON, ON))!;
    expect(hired).toMatchObject({ chore: "review", agentId: "editor" });
    expect(getTaskById(hired.taskId)!.task).toMatch(/mixed du and Sie[\s\S]*Danke Sie du/);
    startTask(hired.taskId, "worker");
    completeTask(hired.taskId, "It mixes formal and informal German. Add a rule: pick one register and keep it.");
    fileFinished(NOON + 60_000);
    expect(secondOpinionsOn("translator", NOW - 86_400_000)).toEqual(["It mixes formal and informal German. Add a rule: pick one register and keep it."]);
    expect(evidenceFor("translator", NOON + 60_000).opinions).toHaveLength(1);
    expect(nextChore(NOON + 120_000)).toBeNull(); // that test has its second opinion
    expect(testJob).toBeTruthy();
  });
});

describe("hires its own agents: the day's number", () => {
  it("does nothing switched off, and runs on the tick", async () => {
    expect(await upkeepTurn(NOW, {})).toBeNull();
    await tick(NOW, ON);
    expect(recentJobs(5, "upkeep")).toHaveLength(1);
  });
});

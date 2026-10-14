// Autonomy 3, "two agents and a judge": which jobs get a second agent, who it is, how the judge picks, and that the
// customer's payment is never touched. Fake models only: nothing here calls a real one.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createAgent, getAgentById } from "@/lib/agents";
import { createTask, completeTask, getTaskById, startTask, type Task } from "@/lib/tasks";
import { claimTokenFor } from "@/lib/claimToken";
import { startJudge, whyNoJudge, judgeView, closeStale, JUDGE, JUDGE_KEY, type HowItRuns, type JudgeModels } from "@/lib/autonomy3Judge";
import { recentJobs, startJob } from "@/lib/autonomy3";
import { worstDayUsd } from "@/lib/autonomy3Policy";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";
import "@/lib/autonomy3Parts";
import type { Agent } from "@/sdk/types";

// a day's number above the real three, so a test can start more than three judges; the number itself is tested apart
const ON = { AUTONOMY3: "on", AUTONOMY3_JUDGE: "on", AUTONOMY3_JUDGE_A_DAY: "100" };
const PLAIN: HowItRuns = { viaMcp: false, grants: [], localTools: 0, files: 0, report: false, sandbox: false, office: false, browsing: false, building: false, drawing: false, steered: false, followUp: false };
const JOB = "Write a two-line welcome message for new customers of a bike shop.";
const saved = { ...process.env };

function agent(id: string, caps: string[], extra: Partial<Agent> = {}): Agent {
  const a = { agentId: id, name: `Agent ${id}`, capabilities: caps, publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt: new Date().toISOString(), ...extra } as Agent;
  createAgent(a, { describe: false });
  return a;
}

function job(opts: { context?: Record<string, unknown>; payment?: string; from?: string; parentTaskId?: string } = {}): Task {
  const t = createTask({ fromAgent: opts.from ?? "anonymous", toAgent: "hired", task: JOB, context: opts.context ?? { [JUDGE_KEY]: true }, ...(opts.payment ? { payment: opts.payment } : {}), ...(opts.parentTaskId ? { parentTaskId: opts.parentTaskId } : {}) });
  return getTaskById(t.taskId)!;
}

/** Fake models: the second agent answers with `second`, and the grader scores an answer by the number in it. */
function models(second: string | (() => Promise<string>), calls: string[] = []): JudgeModels {
  return {
    answer: async (a) => { calls.push(`answer:${a.agentId}`); return typeof second === "string" ? second : second(); },
    grader: async (_system, prompt) => {
      calls.push("grade");
      const answer = prompt.slice(prompt.indexOf("The answer:"));
      if (/agent/i.test(answer.replace("The answer:", ""))) throw new Error("the grader must not be told who wrote it");
      return JSON.stringify({ score: Number(answer.match(/\[(\d+)\]/)?.[1] ?? 5), feedback: "ok" });
    },
  };
}

beforeEach(() => {
  const db = getDb();
  for (const t of ["tasks", "agents", "agent_capabilities", "autonomy3_jobs", "transactions", "rate_limit_windows"]) db.exec(`DELETE FROM ${t}`);
  agent("hired", ["copywriting", "editing", "translation", "summarization"]);
  agent("second", ["copywriting", "editing", "proofreading"]);
  agent("paid", ["copywriting", "editing", "translation", "summarization"], { price: "0.001 ETH" });
  agent("remote", ["copywriting", "editing", "translation", "summarization"], { endpoint: "https://example.com/agent" });
  agent("thin", ["copywriting"]);
});
afterEach(() => vi.useRealTimers());
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("two agents and a judge: which jobs", () => {
  it("only while switched on, and only a job that asked, or a paid one at or above AUTONOMY3_JUDGE_MIN_ETH", () => {
    expect(whyNoJudge(job(), PLAIN, {})).toBe("switched off");
    expect(whyNoJudge(job(), PLAIN, { AUTONOMY3: "on" })).toBe("switched off");
    expect(whyNoJudge(job(), PLAIN, ON)).toBeNull();
    const big = job({ context: {}, payment: "0.01 ETH" });
    expect(whyNoJudge(big, PLAIN, ON)).toMatch(/did not ask/); // unset: never without being asked
    expect(whyNoJudge(big, PLAIN, { ...ON, AUTONOMY3_JUDGE_MIN_ETH: "0.01" })).toBeNull();
    expect(whyNoJudge(job({ context: {}, payment: "0.005 ETH" }), PLAIN, { ...ON, AUTONOMY3_JUDGE_MIN_ETH: "0.01" })).toMatch(/did not ask/);
    expect(whyNoJudge(job({ context: {} }), PLAIN, { ...ON, AUTONOMY3_JUDGE_MIN_ETH: "0.01" })).toMatch(/did not ask/);
  });

  it("never a follow-up, a workflow step, agent-to-agent work, the network's own job, a job with files or a plan, or a steered one", () => {
    const first = job();
    expect(whyNoJudge(job({ parentTaskId: first.taskId }), PLAIN, ON)).toMatch(/follow-up/);
    expect(whyNoJudge(job(), { ...PLAIN, followUp: true }, ON)).toMatch(/follow-up/);
    expect(whyNoJudge({ ...job(), workflowId: "wf-1" }, PLAIN, ON)).toMatch(/larger/);
    expect(whyNoJudge({ ...job(), quorumId: "q-1" }, PLAIN, ON)).toMatch(/larger/);
    expect(whyNoJudge(job({ from: "thin" }), PLAIN, ON)).toMatch(/an agent hired it/);
    expect(whyNoJudge(job({ context: { [JUDGE_KEY]: true, source: "axon-autonomy-upkeep", automated: true } }), PLAIN, ON)).toMatch(/not a hire/);
    expect(whyNoJudge(job({ context: { [JUDGE_KEY]: true, rescueOf: "t-0" } }), PLAIN, ON)).toMatch(/not a hire/);
    expect(whyNoJudge(job(), { ...PLAIN, files: 1 }, ON)).toMatch(/files/);
    expect(whyNoJudge(job(), { ...PLAIN, report: true }, ON)).toMatch(/files/);
    expect(whyNoJudge(job({ context: { [JUDGE_KEY]: true, planFirst: true } }), PLAIN, ON)).toMatch(/plan/);
    expect(whyNoJudge(job(), { ...PLAIN, steered: true }, ON)).toMatch(/steered/);
    expect(whyNoJudge(job(), { ...PLAIN, viaMcp: true }, ON)).toMatch(/MCP/);
  });

  it("never a job whose agent acts on the world; reading the web is fine", () => {
    for (const acts of [{ browsing: true }, { building: true }, { sandbox: true }, { office: true }, { drawing: true }, { localTools: 2 }, { grants: ["code_execution"] }, { grants: ["web_search", "mcp:calendar"] }]) {
      expect(whyNoJudge(job(), { ...PLAIN, ...acts }, ON)).toMatch(/act on the world/);
    }
    expect(whyNoJudge(job(), { ...PLAIN, grants: ["web_search", "web_fetch"] }, ON)).toBeNull();
  });
});

describe("two agents and a judge: the second agent", () => {
  it("is a free agent on Axon with at least half of the hired agent's skills, never paid, remote or thin", () => {
    const j = startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[5]"))!;
    expect(j.second.agentId).toBe("second");
    j.drop("test over");
  });

  it("is not started past the day's number, for a job too long for its token limit, or twice for one job", () => {
    const t = job();
    const first = startJudge(t, getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[5]"));
    expect(first).not.toBeNull();
    expect(startJudge(t, getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[5]"))).toBeNull(); // one judge per job
    first!.drop("test over");
    expect(startJudge(job(), getAgentByIdOrThrow("hired"), "x".repeat(JUDGE.maxJobChars + 1), PLAIN, ON, models("[5]"))).toBeNull();
    expect(startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, { ...ON, AUTONOMY3_JUDGE_A_DAY: "1" }, models("[5]"))).toBeNull(); // the day's one is used
    expect(recentJobs(10, "judge")).toHaveLength(1);
  });

  it("is not started when no agent fits", () => {
    getDb().exec("DELETE FROM agents WHERE agent_id = 'second'");
    expect(startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[5]"))).toBeNull();
    expect(recentJobs(10, "judge")).toHaveLength(0);
  });
});

describe("two agents and a judge: the verdict", () => {
  it("shows the second answer when it scores higher, records both scores and agents, and the job's view says so", async () => {
    const calls: string[] = [];
    const t = job();
    const j = startJudge(t, getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("Welcome, rider! [9]", calls))!;
    const v = await j.decide("Hello. [4]");
    expect(v).toMatchObject({ shown: "second", output: "Welcome, rider! [9]", outcome: "second-won" });
    expect(calls).toEqual(["answer:second", "grade", "grade"]);
    expect(recentJobs(5, "judge")[0]).toMatchObject({ subject: t.taskId, outcome: "second-won", detail: { hired: "hired", second: "second", hiredScore: 4, secondScore: 9, shown: "second", why: "asked" } });
    startTask(t.taskId, "worker");
    completeTask(t.taskId, v.output);
    expect(judgeView(getTaskById(t.taskId)!)).toEqual({ judged: { shown: "second", secondAgent: { id: "second", name: "Agent second" } } });
  });

  it("keeps the hired agent's answer when it is better, and on a tie", async () => {
    const better = await startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[6]"))!.decide("[8]");
    expect(better).toMatchObject({ shown: "hired", output: "[8]", outcome: "hired-won" });
    const tie = await startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[7] second"))!.decide("[7] hired");
    expect(tie).toMatchObject({ shown: "hired", output: "[7] hired", outcome: "hired-won" });
  });

  it("delivers the hired answer as today when the second agent fails, answers nothing, or the grader cannot be read", async () => {
    const failed = await startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models(async () => { throw new Error("model down"); }))!.decide("[3]");
    expect(failed).toMatchObject({ shown: "hired", output: "[3]", outcome: "second-failed" });
    const empty = await startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("   "))!.decide("[3]");
    expect(empty).toMatchObject({ shown: "hired", outcome: "second-failed" });
    const unread: JudgeModels = { answer: async () => "[9]", grader: async () => "no json here" };
    expect(await startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, unread)!.decide("[3]")).toMatchObject({ shown: "hired", outcome: "ungraded" });
    const long = await startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[9]"))!.decide(`[1] ${"x".repeat(JUDGE.gradeChars)}`);
    expect(long).toMatchObject({ shown: "hired", outcome: "too-long" });
    expect(recentJobs(10, "judge").map((r) => r.outcome).sort()).toEqual(["second-failed", "second-failed", "too-long", "ungraded"]);
  });

  it("waits at most a bounded time for a slow second agent, then delivers the hired answer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = job();
    const j = startJudge(t, getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models(() => new Promise<string>(() => {})))!;
    const pending = j.decide("[2]");
    await vi.advanceTimersByTimeAsync(JUDGE.waitMs);
    expect(await pending).toMatchObject({ shown: "hired", output: "[2]", outcome: "timeout" });
    expect(recentJobs(5, "judge")[0]).toMatchObject({ outcome: "timeout" });
    startTask(t.taskId, "worker");
    completeTask(t.taskId, "[2]");
    expect(judgeView(getTaskById(t.taskId)!)).toEqual({}); // nothing to say: one agent's answer, as always
  });

  it("is not used when the person steered the job while it ran, and is closed when the job ends without an answer", async () => {
    const steered = await startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[9]"))!.decide("[1]", { steered: true });
    expect(steered).toMatchObject({ shown: "hired", output: "[1]", outcome: "not-judged" });
    const j = startJudge(job(), getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[9]"))!;
    j.drop("the job failed");
    expect(await j.decide("[1]")).toMatchObject({ shown: "hired", output: "[1]" }); // a decision after the end changes nothing
    expect(recentJobs(5, "judge").map((r) => r.outcome).sort()).toEqual(["dropped", "not-judged"]);
  });

  it("closes a judge its worker left open", () => {
    const id = startJob("judge", "t-lost", Date.now() - (JUDGE.staleMinutes + 1) * 60_000)!;
    expect(closeStale()).toBe(1);
    expect(recentJobs(5, "judge").find((j) => j.id === id)).toMatchObject({ outcome: "dropped" });
  });
});

describe("two agents and a judge: money", () => {
  it("leaves the customer's payment exactly as it was, whichever answer won", async () => {
    const t = job({ context: {}, payment: "0.01 ETH" });
    getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at) VALUES ('tx-1', ?, 'anonymous', 'hired', 0.01, 'escrow', '0xpaid', 0, 'ETH', ?)")
      .run(t.taskId, new Date().toISOString());
    const before = getDb().prepare("SELECT * FROM transactions").all();
    const v = await startJudge(t, getAgentByIdOrThrow("hired"), JOB, PLAIN, { ...ON, AUTONOMY3_JUDGE_MIN_ETH: "0.01" }, models("[9]"))!.decide("[2]");
    expect(v.shown).toBe("second");
    expect(recentJobs(1, "judge")[0].detail).toMatchObject({ why: "big paid job" });
    expect(getDb().prepare("SELECT * FROM transactions").all()).toEqual(before); // one payment, to the hired agent, untouched
  });
});

describe("two agents and a judge: the hire and the view", () => {
  const post = async (body: unknown) => {
    const res = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.0.1" }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as { taskId?: string; context?: Record<string, unknown> } };
  };

  it("writes bestOfTwo into the job's context where the part is on, refuses it written by the caller, and ignores it where off", async () => {
    Object.assign(process.env, { TRUST_PROXY_HEADERS: "true" });
    delete process.env.AUTONOMY3;
    delete process.env.AUTONOMY3_JUDGE;
    const off = await post({ from: "anonymous", to: "hired", task: JOB, bestOfTwo: true });
    expect(off.status).toBe(201);
    expect(getTaskById(off.body.taskId!)!.context?.[JUDGE_KEY]).toBeUndefined();
    Object.assign(process.env, ON);
    const on = await post({ from: "anonymous", to: "hired", task: JOB, bestOfTwo: true });
    expect(on.status).toBe(201);
    expect(getTaskById(on.body.taskId!)!.context).toMatchObject({ [JUDGE_KEY]: true });
    const forged = await post({ from: "anonymous", to: "hired", task: JOB, context: { [JUDGE_KEY]: true } });
    expect(forged.status).toBe(400);
  });

  it("the view says two agents worked on it, for whoever may read the job", async () => {
    const t = job();
    await startJudge(t, getAgentByIdOrThrow("hired"), JOB, PLAIN, ON, models("[3]"))!.decide("[8]");
    startTask(t.taskId, "worker");
    completeTask(t.taskId, "[8]");
    const res = await taskGet(new NextRequest(`http://x/api/tasks/${t.taskId}`, { headers: { "x-claim-token": claimTokenFor(t.taskId) } }), { params: Promise.resolve({ taskId: t.taskId }) });
    expect(await res.json()).toMatchObject({ output: "[8]", judged: { shown: "hired", secondAgent: { id: "second" } } });
  });
});

describe("two agents and a judge: the day's cost", () => {
  it("keeps the whole day with every part on at or under about $2.20", () => {
    expect(worstDayUsd({})).toBeLessThanOrEqual(2.2);
  });
});

function getAgentByIdOrThrow(id: string): Agent {
  const a = getAgentById(id);
  if (!a) throw new Error(`no agent ${id}`);
  return a;
}

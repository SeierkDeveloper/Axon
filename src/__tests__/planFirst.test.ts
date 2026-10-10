// Work with your agent, phase 4: plan first. A hire that asks for it stops before any work: the agent writes a plan,
// the job waits, and the person approves it, has it changed, or cancels. No model is called here.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { completeTask, createTask, getTaskById, startTask } from "@/lib/tasks";
import { computeReputation } from "@/lib/reputation";
import {
  approvedNote, approveOverdue, decidePlan, keepPlan, maxChanges, openPlan, parkForPlan, planEnabled, planNote, planStage, plannable, plansOf,
  planView, CANCELLED, CHANGE_CHARS, PLAN_CHARS, PLAN_KEY, type Plan,
} from "@/lib/planFirst";
import { askTool, parkForAnswer, questionsOf, answerQuestion, openQuestion } from "@/lib/ask";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";
import { POST as planPost } from "@/app/api/tasks/[taskId]/plan/route";

const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 5_500_000).toString(16).padStart(40, "0")}`;
const AGENT: { provider: string; orchestrator?: boolean } = { provider: "anthropic" };

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}

type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown>; status?: string };
type Seen = { status: string; error?: string; plan?: Plan & { price: string | null; changesLeft: number }; plans?: Plan[]; details?: { refused?: string } };
const hired = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.6.0.1", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Created };
};
const read = async (taskId: string, token: string) =>
  (await (await taskGet(new NextRequest(`http://x/api/tasks/${taskId}`, { headers: { "x-claim-token": token } }), { params: Promise.resolve({ taskId }) })).json()) as Seen;
const decide = async (taskId: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await planPost(new NextRequest(`http://x/api/tasks/${taskId}/plan`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.6.0.2", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ taskId }) });
  return { status: res.status, body: (await res.json()) as Seen };
};
/** A run that writes the plan, as the worker does it: picked up, the plan kept, the job parked. */
const runAndPlan = (taskId: string, text: string, now?: number) => {
  startTask(taskId, "test");
  const plan = keepPlan(taskId, text, now ? { now } : {});
  return { plan, parked: parkForPlan(taskId) };
};
const PLAN = "1. Read the brief.\n2. Draft three options.\n3. Pick one and polish it.\nYou get: the final text.";

beforeEach(() => {
  Object.assign(process.env, { AGENT_PLAN: "on", AGENT_ASK: "on", TRUST_PROXY_HEADERS: "true" });
  delete process.env.AXON_PLAN_MAX_CHANGES;
  delete process.env.AXON_ASK_WAIT_MIN;
  getDb().exec("DELETE FROM task_questions; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("asking for a plan first", () => {
  it("is off unless AGENT_PLAN is on, and a plan may be changed three times unless set otherwise", () => {
    expect(planEnabled({})).toBe(false);
    expect(planEnabled({ AGENT_PLAN: "on" })).toBe(true);
    expect(maxChanges({})).toBe(3);
    expect(maxChanges({ AXON_PLAN_MAX_CHANGES: "0" })).toBe(0);
    expect(maxChanges({ AXON_PLAN_MAX_CHANGES: "9" })).toBe(3);
  });

  it("is a wish on the hire, written into the job; ignored where it is off or the agent cannot write a plan", async () => {
    agent("plan-agent");
    const plain = await hired({ from: "anonymous", to: "plan-agent", task: "Name the product" });
    expect(plain.body.context?.[PLAN_KEY]).toBeUndefined();
    expect(planStage(getTaskById(plain.body.taskId)!, AGENT)).toBeNull();
    const first = await hired({ from: "anonymous", to: "plan-agent", task: "Name the product", planFirst: true });
    expect(first.status).toBe(201);
    expect(first.body.context?.[PLAN_KEY]).toBe(true);
    expect(planStage(getTaskById(first.body.taskId)!, AGENT)).toBe("plan");
    expect((await hired({ from: "anonymous", to: "plan-agent", task: "x", context: { [PLAN_KEY]: true } })).status).toBe(400);

    // an agent that hires specialists, or runs behind an MCP server, is simply run
    expect(plannable({ orchestrator: true })).toBe(false);
    expect(planStage(getTaskById(first.body.taskId)!, { orchestrator: true })).toBeNull();
    expect(planStage(getTaskById(first.body.taskId)!, AGENT, { viaMcp: true })).toBeNull();
    // any model Axon runs can write a plan
    const gpt: { provider: string; orchestrator?: boolean } = { provider: "openai" };
    expect(planStage(getTaskById(first.body.taskId)!, gpt)).toBe("plan");

    process.env.AGENT_PLAN = "off";
    const off = await hired({ from: "anonymous", to: "plan-agent", task: "Name the product", planFirst: true });
    expect(off.body.context?.[PLAN_KEY]).toBeUndefined();
    expect(planStage(getTaskById(first.body.taskId)!, AGENT)).toBeNull();
  });
});

describe("the plan and the decision", () => {
  const planned = async (over: Partial<Agent> = {}) => {
    agent("plan-agent", over);
    const job = await hired({ from: "anonymous", to: "plan-agent", task: "Name the product", planFirst: true });
    const t0 = Date.parse("2026-10-10T12:00:00Z");
    const run = runAndPlan(job.body.taskId, `  ${PLAN}  `, t0);
    return { job: job.body, run, t0 };
  };

  it("the plan is kept, the job waits, and its reader sees the plan with the price and the changes left", async () => {
    const { job, run } = await planned();
    expect(run.plan).toEqual({ n: 1, text: PLAN, madeAt: "2026-10-10T12:00:00.000Z", answerBy: "2026-10-10T13:00:00.000Z" });
    expect(run.parked).toBe(true);
    const seen = await read(job.taskId, job.claimToken!);
    expect(seen.status).toBe("waiting");
    expect(seen.plan).toMatchObject({ n: 1, text: PLAN, price: null, changesLeft: 3 });
    expect(seen.plans).toHaveLength(1);
    expect(planStage(getTaskById(job.taskId)!, AGENT)).toBe("wait");
    // a plan is not a question: nothing shows as asked, and an answer has nothing to answer
    expect(questionsOf(job.taskId)).toEqual([]);
    expect(openQuestion(job.taskId)).toBeNull();
    expect(answerQuestion(job.taskId, "yes")).toMatchObject({ ok: false, refused: "not_waiting" });
    expect(getTaskById(job.taskId)!.status).toBe("waiting");
    // a very long plan is cut to what is kept
    expect(keepPlan("other", "x".repeat(PLAN_CHARS + 50)).text).toHaveLength(PLAN_CHARS);
  });

  it("approved, the same job is queued and the agent is held to the plan", async () => {
    const { job } = await planned();
    const res = await decide(job.taskId, { action: "approve" }, { "x-claim-token": job.claimToken! });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.plan).toBeUndefined();
    expect(res.body.plans?.[0]).toMatchObject({ outcome: "approved" });
    expect(planStage(getTaskById(job.taskId)!, AGENT)).toBe("work");
    const note = approvedNote(job.taskId);
    expect(note).toContain("The person approved this plan for the job. Follow it:");
    expect(note).toContain(PLAN);
    expect(startTask(job.taskId, "worker")?.status).toBe("running");
    expect(completeTask(job.taskId, "Tarn.")?.status).toBe("completed");
  });

  it("changed, the agent writes it again with the change, and only so many times", async () => {
    const { job } = await planned();
    const token = { "x-claim-token": job.claimToken! };
    expect((await decide(job.taskId, { action: "change" }, token)).body.details?.refused).toBe("empty");
    expect((await decide(job.taskId, { action: "change", change: "x".repeat(CHANGE_CHARS + 1) }, token)).body.details?.refused).toBe("too_long");
    const res = await decide(job.taskId, { action: "change", change: " Five options, not three. " }, token);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(planStage(getTaskById(job.taskId)!, AGENT)).toBe("plan");
    expect(approvedNote(job.taskId)).toBe("");
    const told = planNote(plansOf(job.taskId));
    expect(told).toContain("Do not do the job yet");
    expect(told).toContain(`Your earlier plan:\n${PLAN}`);
    expect(told).toContain("The person asked for this change:\nFive options, not three.");
    expect(planNote([])).not.toContain("Your earlier plan");

    // the second plan waits like the first, and says one change is used
    runAndPlan(job.taskId, "1. Draft five options.");
    expect((await read(job.taskId, job.claimToken!)).plan).toMatchObject({ n: 2, changesLeft: 2 });
    process.env.AXON_PLAN_MAX_CHANGES = "1";
    const more = await decide(job.taskId, { action: "change", change: "Seven." }, token);
    expect(more.status).toBe(400);
    expect(more.body.details?.refused).toBe("no_changes_left");
    expect(getTaskById(job.taskId)!.status).toBe("waiting");
    expect((await decide(job.taskId, { action: "approve" }, token)).status).toBe(200);
    expect(approvedNote(job.taskId)).toContain("1. Draft five options.");
  });

  it("cancelled, the job ends without work, whatever was paid is refunded, and the agent's record is untouched", async () => {
    const a = agent("paid-agent", { price: "0.01 ETH" });
    // one finished job on the agent's record, so there is a success rate for a cancellation to spoil
    const earlier = createTask({ fromAgent: "anonymous", toAgent: a.agentId, task: "An earlier job" });
    startTask(earlier.taskId, "test");
    completeTask(earlier.taskId, "Done.");
    // a paid job with its payment held, as the hire route leaves it
    const job = createTask({ fromAgent: "anonymous", toAgent: a.agentId, task: "Name the product", payment: "0.01 ETH", context: { [PLAN_KEY]: true } });
    getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, currency, status, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("tx-plan-1", job.taskId, "anonymous", a.agentId, 0.01, "ETH", "escrow", new Date().toISOString());
    runAndPlan(job.taskId, PLAN);
    expect(planView(getTaskById(job.taskId)!).plan?.price).toBe("0.01 ETH");
    const score = () => { const { lastUpdated: _at, ...rest } = computeReputation(a.agentId); void _at; return rest; };
    const before = score();
    expect(before.successRate).toBe(1);

    const done = decidePlan(job.taskId, "cancel");
    expect(done.ok).toBe(true);
    const after = getTaskById(job.taskId)!;
    expect(after.status).toBe("cancelled");
    expect(after.error).toBe(CANCELLED);
    expect(after.completedAt).toBeTruthy();
    expect(getDb().prepare("SELECT status FROM transactions WHERE tx_id = 'tx-plan-1'").get()).toEqual({ status: "refunded" });
    expect(plansOf(job.taskId)[0]).toMatchObject({ outcome: "cancelled" });
    // neither a success nor a failure of the agent
    expect(score()).toEqual(before);
    // and it stays ended
    expect(startTask(job.taskId, "worker")).toBeNull();
    expect(decidePlan(job.taskId, "approve")).toMatchObject({ ok: false, refused: "not_waiting" });
    expect(planView(after).plan).toBeUndefined();
  });

  it("only whoever hired the job decides, and only while a plan is waiting", async () => {
    const { job } = await planned();
    expect((await decide(job.taskId, { action: "approve" }, { "x-claim-token": "0".repeat(32) })).status).toBe(403);
    expect((await decide(job.taskId, { action: "approve" })).status).toBe(401);
    expect((await decide(job.taskId, { action: "approve" }, { authorization: `Bearer ${createApiKey(wallet(), {}).apiKey}` })).status).toBe(403);
    expect((await decide(job.taskId, { action: "start" }, { "x-claim-token": job.claimToken! })).status).toBe(400);
    expect(getTaskById(job.taskId)!.status).toBe("waiting");
    expect((await decide(job.taskId, { action: "approve" }, { "x-claim-token": job.claimToken! })).status).toBe(200);
    const again = await decide(job.taskId, { action: "cancel" }, { "x-claim-token": job.claimToken! });
    expect(again.status).toBe(409);
    expect(getTaskById(job.taskId)!.status).toBe("queued");

    process.env.AGENT_PLAN = "off";
    expect((await decide(job.taskId, { action: "approve" }, { "x-claim-token": job.claimToken! })).status).toBe(404);
    expect(planView(getTaskById(job.taskId)!)).toEqual({});
  });

  it("with no answer in time the job goes on with the plan as written", async () => {
    const { job, t0 } = await planned();
    expect(approveOverdue(t0 + 59 * 60_000)).toBe(0);
    expect(approveOverdue(t0 + 60 * 60_000)).toBe(1);
    expect(getTaskById(job.taskId)!.status).toBe("queued");
    expect(plansOf(job.taskId)[0]).toMatchObject({ outcome: "timeout" });
    expect(planStage(getTaskById(job.taskId)!, AGENT)).toBe("work");
    expect(approvedNote(job.taskId)).toContain("The person did not answer in time, so go on with it as written:");
    expect(approveOverdue(t0 + 61 * 60_000)).toBe(0);
  });

  it("a job can have a plan and, once at work, still ask a question: the two do not get in each other's way", async () => {
    agent("plan-agent");
    const job = await hired({ from: "anonymous", to: "plan-agent", task: "Name the product", planFirst: true, allowQuestions: true });
    runAndPlan(job.body.taskId, PLAN);
    decidePlan(job.body.taskId, "approve");
    startTask(job.body.taskId, "worker");
    await askTool({ taskId: job.body.taskId, onAsked: () => {} }).run({ question: "Which market is the product for?" });
    expect(parkForAnswer(job.body.taskId)).toBe(true);
    const seen = await read(job.body.taskId, job.body.claimToken!);
    expect(seen.plan).toBeUndefined();
    expect(openPlan(job.body.taskId)).toBeNull();
    expect(decidePlan(job.body.taskId, "approve")).toMatchObject({ ok: false, refused: "not_waiting" });
    expect(answerQuestion(job.body.taskId, "Canada").ok).toBe(true);
    expect(planStage(getTaskById(job.body.taskId)!, AGENT)).toBe("work");
  });
});

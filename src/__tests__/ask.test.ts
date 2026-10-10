// Work with your agent, phase 3: the agent asks. On a hire that allowed it, an agent may stop to ask the person a
// question; the job waits, and goes on when the answer is in or when the time runs out. No model is called here.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { completeTask, getTaskById, startTask } from "@/lib/tasks";
import {
  answerQuestion, askedSoFar, askEnabled, askTool, closeStrays, mayAsk, maxQuestions, openQuestion, parkForAnswer, questionsOf,
  questionsView, resumeOverdue, waitMinutes, withAsk, canAsk, ASK_KEY, ANSWER_CHARS, QUESTION_CHARS, type Question,
} from "@/lib/ask";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";
import { POST as answerPost } from "@/app/api/tasks/[taskId]/answer/route";

const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 6_600_000).toString(16).padStart(40, "0")}`;

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}

type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown>; status?: string };
const hired = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Created };
};
const read = async (taskId: string, token: string) =>
  (await (await taskGet(new NextRequest(`http://x/api/tasks/${taskId}`, { headers: { "x-claim-token": token } }), { params: Promise.resolve({ taskId }) })).json()) as { status: string; question?: Question; questions?: Question[] };
const answer = async (taskId: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await answerPost(new NextRequest(`http://x/api/tasks/${taskId}/answer`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.2", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ taskId }) });
  return { status: res.status, body: (await res.json()) as { status?: string; error?: string; details?: { refused?: string }; questions?: Question[]; question?: Question } };
};
/** A run of the job in which the agent asks, as the worker does it: picked up, the tool used, the job parked. */
const runAndAsk = async (taskId: string, args: Record<string, unknown>, now?: number) => {
  startTask(taskId, "test");
  let asked: Question | null = null;
  const said = await askTool({ taskId, onAsked: (q) => { asked = q; }, ...(now ? { now: () => now } : {}) }).run(args);
  return { asked: asked as Question | null, said, parked: parkForAnswer(taskId) };
};

beforeEach(() => {
  Object.assign(process.env, { AGENT_ASK: "on", TRUST_PROXY_HEADERS: "true" });
  delete process.env.AXON_ASK_MAX;
  delete process.env.AXON_ASK_WAIT_MIN;
  getDb().exec("DELETE FROM task_questions; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the switch and the limits", () => {
  it("off unless AGENT_ASK is on; two questions a job and an hour to answer unless set otherwise", () => {
    expect(askEnabled({})).toBe(false);
    expect(askEnabled({ AGENT_ASK: "on" })).toBe(true);
    expect(maxQuestions({})).toBe(2);
    expect(maxQuestions({ AXON_ASK_MAX: "4" })).toBe(4);
    expect(maxQuestions({ AXON_ASK_MAX: "0" })).toBe(2);
    expect(waitMinutes({})).toBe(60);
    expect(waitMinutes({ AXON_ASK_WAIT_MIN: "5" })).toBe(5);
  });
});

describe("who may be asked", () => {
  it("only a hire that said so: the wish is written into the job, and ignored where asking is off", async () => {
    agent("plan-agent");
    const plain = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch" });
    expect(plain.body.context?.[ASK_KEY]).toBeUndefined();
    const open = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch", allowQuestions: true });
    expect(open.status).toBe(201);
    expect(open.body.context?.[ASK_KEY]).toBe(true);
    // a caller may not write the mark themselves
    expect((await hired({ from: "anonymous", to: "plan-agent", task: "x", context: { [ASK_KEY]: true } })).status).toBe(400);

    const a = { provider: "anthropic" };
    expect(mayAsk(getTaskById(open.body.taskId)!, a)).toBe(true);
    expect(mayAsk(getTaskById(plain.body.taskId)!, a)).toBe(false);
    // only an agent Axon runs in the loop that runs tools
    expect(mayAsk(getTaskById(open.body.taskId)!, { provider: "openai" })).toBe(false);
    expect(mayAsk(getTaskById(open.body.taskId)!, { provider: "anthropic", orchestrator: true })).toBe(false);
    expect(mayAsk(getTaskById(open.body.taskId)!, a, { viaMcp: true })).toBe(false);

    process.env.AGENT_ASK = "off";
    const off = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch", allowQuestions: true });
    expect(off.status).toBe(201);
    expect(off.body.context?.[ASK_KEY]).toBeUndefined();
    expect(mayAsk(getTaskById(open.body.taskId)!, a)).toBe(false);
  });

  it("the tool is added once and found again", () => {
    const tool = askTool({ taskId: "t", onAsked: () => {} });
    const once = withAsk(null, tool);
    expect(canAsk(once)).toBe(true);
    expect(withAsk(once, tool)).toBe(once);
    expect(canAsk(null)).toBe(false);
  });
});

describe("asking and waiting", () => {
  it("the question is written down, the run is told, and the job waits with its question shown", async () => {
    agent("plan-agent");
    const job = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch", allowQuestions: true });
    const t0 = Date.parse("2026-10-10T12:00:00Z");
    const run = await runAndAsk(job.body.taskId, { question: "  Which market is the launch for?  ", choices: ["Canada", "Germany", "Canada", "", 7] }, t0);
    expect(run.said).toContain("Stop now");
    expect(run.asked).toEqual({ n: 1, text: "Which market is the launch for?", choices: ["Canada", "Germany"], askedAt: "2026-10-10T12:00:00.000Z", answerBy: "2026-10-10T13:00:00.000Z" });
    expect(run.parked).toBe(true);

    const seen = await read(job.body.taskId, job.body.claimToken!);
    expect(seen.status).toBe("waiting");
    expect(seen.question).toMatchObject({ n: 1, text: "Which market is the launch for?", choices: ["Canada", "Germany"] });
    expect(seen.questions).toHaveLength(1);
    // a waiting job is not picked up, and cannot be completed behind the question's back
    expect(startTask(job.body.taskId, "worker")).toBeNull();
    expect(completeTask(job.body.taskId, "done anyway")).toBeNull();
  });

  it("a question must be a real one, and a run asks once", async () => {
    agent("plan-agent");
    const job = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch", allowQuestions: true });
    startTask(job.body.taskId, "test");
    const tool = askTool({ taskId: job.body.taskId, onAsked: () => {} });
    await expect(tool.run({ question: "Why?" })).rejects.toThrow(/full sentence/);
    await expect(tool.run({ question: "x".repeat(QUESTION_CHARS.max + 1) })).rejects.toThrow(/under/);
    await expect(tool.run({})).rejects.toThrow(/full sentence/);
    expect(questionsOf(job.body.taskId)).toEqual([]);
    // one choice is not a choice
    await tool.run({ question: "Which market is it for?", choices: ["Canada"] });
    expect(questionsOf(job.body.taskId)[0].choices).toBeUndefined();
    await expect(tool.run({ question: "And which month is it?" })).rejects.toThrow(/already asked/);
    expect(questionsOf(job.body.taskId)).toHaveLength(1);
  });

  it("nothing waits without a question, and a job that is not running does not start waiting", async () => {
    agent("plan-agent");
    const job = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch", allowQuestions: true });
    startTask(job.body.taskId, "test");
    expect(parkForAnswer(job.body.taskId)).toBe(false);
    expect(getTaskById(job.body.taskId)!.status).toBe("running");
    const queued = await hired({ from: "anonymous", to: "plan-agent", task: "Another", allowQuestions: true });
    await askTool({ taskId: queued.body.taskId, onAsked: () => {} }).run({ question: "Which market is it for?" });
    expect(parkForAnswer(queued.body.taskId)).toBe(false);
  });
});

describe("the answer", () => {
  const waiting = async () => {
    agent("plan-agent");
    const job = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch", allowQuestions: true });
    await runAndAsk(job.body.taskId, { question: "Which market is the launch for?", choices: ["Canada", "Germany"] });
    return job.body;
  };

  it("from whoever hired the job queues it again, and the agent is told what it asked and what came back", async () => {
    const job = await waiting();
    const res = await answer(job.taskId, { answer: " Canada, and Mexico later. " }, { "x-claim-token": job.claimToken! });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("queued");
    expect(res.body.question).toBeUndefined();
    expect(res.body.questions?.[0]).toMatchObject({ n: 1, answer: "Canada, and Mexico later.", answeredHow: "person" });
    expect(openQuestion(job.taskId)).toBeNull();
    const told = askedSoFar(job.taskId);
    expect(told).toContain("You asked: Which market is the launch for?");
    expect(told).toContain("The person answered: Canada, and Mexico later.");
    expect(told).toContain("Do not ask the same thing again.");
    // it is the same job, picked up again and finished
    expect(startTask(job.taskId, "worker")?.status).toBe("running");
    expect(completeTask(job.taskId, "The plan for Canada.")?.status).toBe("completed");
    expect((await read(job.taskId, job.claimToken!)).question).toBeUndefined();
  });

  it("is refused from anyone else, when empty or far too long, and when nothing is being asked", async () => {
    const job = await waiting();
    expect((await answer(job.taskId, { answer: "Canada" }, { "x-claim-token": "0".repeat(32) })).status).toBe(403);
    expect((await answer(job.taskId, { answer: "Canada" })).status).toBe(401);
    const stranger = createApiKey(wallet(), {}).apiKey;
    expect((await answer(job.taskId, { answer: "Canada" }, { authorization: `Bearer ${stranger}` })).status).toBe(403);
    expect((await answer("no-such-job", { answer: "Canada" }, { "x-claim-token": job.claimToken! })).status).toBe(404);
    expect((await answer(job.taskId, { answer: "   " }, { "x-claim-token": job.claimToken! })).body.details?.refused).toBe("empty");
    expect((await answer(job.taskId, { answer: "x".repeat(ANSWER_CHARS + 1) }, { "x-claim-token": job.claimToken! })).body.details?.refused).toBe("too_long");
    expect((await answer(job.taskId, { reply: "Canada" }, { "x-claim-token": job.claimToken! })).status).toBe(400);
    expect(getTaskById(job.taskId)!.status).toBe("waiting");

    expect((await answer(job.taskId, { answer: "Canada" }, { "x-claim-token": job.claimToken! })).status).toBe(200);
    const again = await answer(job.taskId, { answer: "Germany" }, { "x-claim-token": job.claimToken! });
    expect(again.status).toBe(409);
    expect(again.body.details?.refused).toBe("not_waiting");
    expect(questionsOf(job.taskId)[0].answer).toBe("Canada");
  });

  it("a signed-in hirer answers with their key; the agent's owner may read the job but not answer for them", async () => {
    const a = agent("plan-agent");
    const me = wallet();
    const { apiKey: myKey } = createApiKey(me, {});
    const { apiKey: ownerKey } = createApiKey(a.walletAddress!, {});
    const job = await hired({ from: me.toLowerCase(), to: "plan-agent", task: "Plan the launch", allowQuestions: true }, { authorization: `Bearer ${myKey}` });
    expect(job.status).toBe(201);
    await runAndAsk(job.body.taskId, { question: "Which market is the launch for?" });
    expect((await answer(job.body.taskId, { answer: "Canada" }, { authorization: `Bearer ${ownerKey}` })).status).toBe(403);
    expect((await answer(job.body.taskId, { answer: "Canada" }, { authorization: `Bearer ${myKey}` })).status).toBe(200);
  });

  it("is not there at all while asking is off", async () => {
    const job = await waiting();
    process.env.AGENT_ASK = "off";
    expect((await answer(job.taskId, { answer: "Canada" }, { "x-claim-token": job.claimToken! })).status).toBe(404);
    expect(questionsView(getTaskById(job.taskId)!)).toEqual({});
  });
});

describe("when nobody answers", () => {
  it("the job goes on after its time, and the agent is told to use its best guess and say so", async () => {
    agent("plan-agent");
    const job = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch", allowQuestions: true });
    const t0 = Date.parse("2026-10-10T12:00:00Z");
    await runAndAsk(job.body.taskId, { question: "Which market is the launch for?" }, t0);
    expect(resumeOverdue(t0 + 59 * 60_000)).toBe(0);
    expect(getTaskById(job.body.taskId)!.status).toBe("waiting");
    expect(resumeOverdue(t0 + 60 * 60_000)).toBe(1);
    expect(getTaskById(job.body.taskId)!.status).toBe("queued");
    expect(questionsOf(job.body.taskId)[0]).toMatchObject({ answeredHow: "timeout" });
    expect(questionsOf(job.body.taskId)[0].answer).toBeUndefined();
    expect(askedSoFar(job.body.taskId)).toContain("No answer came in time. Go on with your best assumption");
    expect(resumeOverdue(t0 + 61 * 60_000)).toBe(0);
  });

  it("a job asks only so many times, and a question a dead run left open is closed, not left to answer", async () => {
    agent("plan-agent");
    const job = await hired({ from: "anonymous", to: "plan-agent", task: "Plan the launch", allowQuestions: true });
    const task = () => getTaskById(job.body.taskId)!;
    await runAndAsk(job.body.taskId, { question: "Which market is the launch for?" });
    answerQuestion(job.body.taskId, "Canada");
    expect(mayAsk(task(), { provider: "anthropic" })).toBe(true);
    await runAndAsk(job.body.taskId, { question: "And which month is the launch?" });
    answerQuestion(job.body.taskId, "March");
    expect(mayAsk(task(), { provider: "anthropic" })).toBe(false);
    startTask(job.body.taskId, "test");
    await expect(askTool({ taskId: job.body.taskId, onAsked: () => {} }).run({ question: "One more thing, which city?" })).rejects.toThrow(/asked all it may/);
    expect(askedSoFar(job.body.taskId).match(/You asked:/g)).toHaveLength(2);

    // a run that asked and died before the job could wait: the job is running again, nobody is being asked
    process.env.AXON_ASK_MAX = "3";
    await askTool({ taskId: job.body.taskId, onAsked: () => {} }).run({ question: "One more thing, which city?" });
    expect(openQuestion(job.body.taskId)?.n).toBe(3);
    expect(closeStrays(job.body.taskId)).toBe(1);
    expect(openQuestion(job.body.taskId)).toBeNull();
    expect(questionsOf(job.body.taskId)[2]).toMatchObject({ answeredHow: "timeout" });
  });
});

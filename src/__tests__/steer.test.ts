// Work with your agent, phase 5: stop and steer. While a job runs, whoever hired it can send the agent a note, which
// it reads at its next step or before it finishes, and can stop the job outright. The model SDK is replaced with a
// stub, so what is checked is our side of it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

const sdk = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  const Stub = class {
    messages = { create: vi.fn(), stream: sdk.stream };
    beta = { files: { upload: vi.fn(), retrieveMetadata: vi.fn(), download: vi.fn(), delete: vi.fn() } };
  };
  (Stub as unknown as { BadRequestError: unknown }).BadRequestError = class BadRequestError extends Error {};
  return { default: Stub, toFile: async () => ({}) };
});
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { completeTask, createTask, getTaskById, startTask } from "@/lib/tasks";
import { computeReputation } from "@/lib/reputation";
import { getProvider } from "@/lib/providers";
import type { ResolvedTools } from "@/lib/agentTools";
import { maxNotes, notesAtStart, notesMidway, notesOf, sendNote, steerEnabled, steerView, stopJob, takeNotes, wasStopped, NOTE_CHARS, STOPPED, type Note } from "@/lib/steer";
import { askTool, openQuestion, parkForAnswer } from "@/lib/ask";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";
import { POST as steerPost } from "@/app/api/tasks/[taskId]/steer/route";
import { POST as stopPost } from "@/app/api/tasks/[taskId]/stop/route";

const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 4_400_000).toString(16).padStart(40, "0")}`;

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
type Created = { taskId: string; claimToken?: string };
type Seen = { status: string; error?: string; steer?: { open: boolean; stoppable: boolean; notesLeft: number }; notes?: Note[]; note?: Note; details?: { refused?: string } };
const hired = async (body: unknown) => (await (await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.0.1" }, body: JSON.stringify(body) }))).json()) as Created;
const read = async (taskId: string, token: string) =>
  (await (await taskGet(new NextRequest(`http://x/api/tasks/${taskId}`, { headers: { "x-claim-token": token } }), { params: Promise.resolve({ taskId }) })).json()) as Seen;
const call = async (route: typeof steerPost, path: string, taskId: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await route(new NextRequest(`http://x/api/tasks/${taskId}/${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.0.2", ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ taskId }) });
  return { status: res.status, body: (await res.json()) as Seen };
};
const steer = (taskId: string, body: unknown, headers?: Record<string, string>) => call(steerPost, "steer", taskId, body, headers);
const stop = (taskId: string, headers?: Record<string, string>) => call(stopPost, "stop", taskId, {}, headers);

beforeEach(() => {
  Object.assign(process.env, { AGENT_STEER: "on", AGENT_ASK: "on", TRUST_PROXY_HEADERS: "true", ANTHROPIC_API_KEY: "test-key-mock" });
  delete process.env.AXON_STEER_MAX;
  getDb().exec("DELETE FROM task_notes; DELETE FROM task_questions; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
});
afterEach(() => {
  sdk.stream.mockReset();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("a note to a running job", () => {
  it("is off unless AGENT_STEER is on, and a job takes five notes unless set otherwise", () => {
    expect(steerEnabled({})).toBe(false);
    expect(steerEnabled({ AGENT_STEER: "on" })).toBe(true);
    expect(maxNotes({})).toBe(5);
    expect(maxNotes({ AXON_STEER_MAX: "2" })).toBe(2);
    expect(maxNotes({ AXON_STEER_MAX: "0" })).toBe(5);
  });

  it("is kept until the agent is handed it, then marked as read, once", async () => {
    agent("data-agent");
    const job = await hired({ from: "anonymous", to: "data-agent", task: "Analyse the sales" });
    const token = { "x-claim-token": job.claimToken! };
    // a job still in the queue takes a note too: it goes in with the job's own words
    const first = await steer(job.taskId, { note: "  Use the second sheet.  " }, token);
    expect(first.status).toBe(200);
    expect(first.body.note).toMatchObject({ n: 1, text: "Use the second sheet." });
    expect(first.body.steer).toEqual({ open: true, stoppable: true, notesLeft: 4 });
    startTask(job.taskId, "worker");
    await steer(job.taskId, { note: "Leave out the prices." }, token);
    expect((await read(job.taskId, job.claimToken!)).notes?.map((x) => Boolean(x.deliveredAt))).toEqual([false, false]);

    const got = takeNotes(job.taskId);
    expect(got.map((x) => x.text)).toEqual(["Use the second sheet.", "Leave out the prices."]);
    expect(got.every((x) => x.deliveredAt)).toBe(true);
    expect(takeNotes(job.taskId)).toEqual([]);
    expect((await read(job.taskId, job.claimToken!)).notes?.map((x) => Boolean(x.deliveredAt))).toEqual([true, true]);
    expect(notesAtStart(got)).toBe("\n\nThe person added this after hiring you:\n- Use the second sheet.\n- Leave out the prices.");
    expect(notesAtStart([])).toBe("");
    expect(notesMidway(got)).toContain("sent while you work");
  });

  it("is refused when empty, too long, one too many, from anyone else, or once the job has finished or is waiting", async () => {
    agent("data-agent");
    const job = await hired({ from: "anonymous", to: "data-agent", task: "Analyse the sales", allowQuestions: true });
    const token = { "x-claim-token": job.claimToken! };
    startTask(job.taskId, "worker");
    expect((await steer(job.taskId, { note: "  " }, token)).body.details?.refused).toBe("empty");
    expect((await steer(job.taskId, { note: "x".repeat(NOTE_CHARS + 1) }, token)).body.details?.refused).toBe("too_long");
    expect((await steer(job.taskId, { text: "hello" }, token)).status).toBe(400);
    expect((await steer(job.taskId, { note: "hello" }, { "x-claim-token": "0".repeat(32) })).status).toBe(403);
    expect((await steer(job.taskId, { note: "hello" })).status).toBe(401);
    expect((await steer(job.taskId, { note: "hello" }, { authorization: `Bearer ${createApiKey(wallet(), {}).apiKey}` })).status).toBe(403);
    expect(notesOf(job.taskId)).toEqual([]);

    process.env.AXON_STEER_MAX = "1";
    expect((await steer(job.taskId, { note: "First." }, token)).status).toBe(200);
    const more = await steer(job.taskId, { note: "Second." }, token);
    expect(more.body.details?.refused).toBe("too_many");
    expect((await read(job.taskId, job.claimToken!)).steer).toEqual({ open: false, stoppable: true, notesLeft: 0 });
    delete process.env.AXON_STEER_MAX;

    // waiting on the person: they answer there, they do not send a note
    await askTool({ taskId: job.taskId, onAsked: () => {} }).run({ question: "Which sheet do you mean?" });
    parkForAnswer(job.taskId);
    const waiting = await steer(job.taskId, { note: "The second." }, token);
    expect(waiting.status).toBe(409);
    expect(waiting.body.details?.refused).toBe("waiting");
    expect((await read(job.taskId, job.claimToken!)).steer).toMatchObject({ open: false, stoppable: true });

    const done = await hired({ from: "anonymous", to: "data-agent", task: "Another" });
    startTask(done.taskId, "worker");
    completeTask(done.taskId, "Done.");
    const late = await steer(done.taskId, { note: "Too late." }, { "x-claim-token": done.claimToken! });
    expect(late.status).toBe(409);
    expect(late.body.details?.refused).toBe("finished");
    expect((await read(done.taskId, done.claimToken!)).steer).toEqual({ open: false, stoppable: false, notesLeft: 5 });

    process.env.AGENT_STEER = "off";
    expect((await steer(job.taskId, { note: "hello" }, token)).status).toBe(404);
    expect(sendNote(job.taskId, "hello")).toMatchObject({ ok: false, refused: "off" });
    expect(steerView(getTaskById(job.taskId)!)).toEqual({});
  });
});

describe("the note reaches the agent", () => {
  const who: Agent = { agentId: "loop-agent", name: "Loop Agent", capabilities: ["analysis"], publicKey: "pk", provider: "anthropic", reputation: 0, createdAt: new Date().toISOString() };
  const reply = (content: unknown[], over: Record<string, unknown> = {}) => ({ finalMessage: async () => ({ content, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 }, ...over }) });
  const lookup = { name: "lookup", label: "lookup", description: "Look something up", inputSchema: { type: "object", properties: {} }, run: async () => "42" };
  const tools: ResolvedTools = { serverTools: [], localTools: [lookup], grants: ["lookup"] };
  type Sent = { messages: { role: string; content: unknown }[] };
  const sent = (i: number) => (sdk.stream.mock.calls[i][0] as Sent).messages;

  it("between two of its steps, with the results of the tools it just used", async () => {
    sdk.stream
      .mockReturnValueOnce(reply([{ type: "tool_use", id: "tu_1", name: "lookup", input: {} }], { stop_reason: "tool_use" }))
      .mockReturnValueOnce(reply([{ type: "text", text: "Done, without prices." }]));
    const queue = ["A note: leave out the prices."];
    const out = await getProvider(who).completeWithTools!("system", "Analyse the sales", 500, tools, { notes: () => queue.shift() ?? null });
    expect(out).toBe("Done, without prices.");
    expect(sdk.stream).toHaveBeenCalledTimes(2);
    const back = sent(1).at(-1)!;
    expect(back.role).toBe("user");
    expect(back.content).toEqual([{ type: "tool_result", tool_use_id: "tu_1", content: "42" }, { type: "text", text: "A note: leave out the prices." }]);
  });

  it("and when it was about to finish: it gets the note and one more round", async () => {
    sdk.stream
      .mockReturnValueOnce(reply([{ type: "text", text: "Here is the long version." }]))
      .mockReturnValueOnce(reply([{ type: "text", text: "Here is the short version." }]));
    const queue = ["A note: make it shorter."];
    const out = await getProvider(who).completeWithTools!("system", "Write it up", 500, tools, { notes: () => queue.shift() ?? null });
    expect(out).toBe("Here is the short version.");
    expect(sent(1).slice(-2)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Here is the long version." }] },
      { role: "user", content: "A note: make it shorter." },
    ]);
  });

  it("nothing changes for a job nobody wrote to, or when reading the notes fails", async () => {
    sdk.stream.mockReturnValue(reply([{ type: "text", text: "The answer." }]));
    expect(await getProvider(who).completeWithTools!("system", "Do it", 500, tools, { notes: () => null })).toBe("The answer.");
    expect(await getProvider(who).completeWithTools!("system", "Do it", 500, tools, { notes: () => { throw new Error("db gone"); } })).toBe("The answer.");
    expect(await getProvider(who).completeWithTools!("system", "Do it", 500, tools, {})).toBe("The answer.");
    expect(sdk.stream).toHaveBeenCalledTimes(3);
  });
});

describe("stopping a job", () => {
  it("ends it as cancelled, refunds what was paid, leaves the agent's record alone, and a run in progress can tell", async () => {
    const a = agent("paid-agent", { price: "0.01 ETH" });
    const earlier = createTask({ fromAgent: "anonymous", toAgent: a.agentId, task: "An earlier job" });
    startTask(earlier.taskId, "test");
    completeTask(earlier.taskId, "Done.");
    const job = createTask({ fromAgent: "anonymous", toAgent: a.agentId, task: "A long analysis", payment: "0.01 ETH" });
    getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, currency, status, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("tx-stop-1", job.taskId, "anonymous", a.agentId, 0.01, "ETH", "escrow", new Date().toISOString());
    startTask(job.taskId, "worker");
    const score = () => { const { lastUpdated: _at, ...rest } = computeReputation(a.agentId); void _at; return rest; };
    const before = score();
    expect(wasStopped(job.taskId)).toBe(false);

    const done = stopJob(job.taskId);
    expect(done.ok).toBe(true);
    const after = getTaskById(job.taskId)!;
    expect(after.status).toBe("cancelled");
    expect(after.error).toBe(STOPPED);
    expect(wasStopped(job.taskId)).toBe(true);
    expect(getDb().prepare("SELECT status FROM transactions WHERE tx_id = 'tx-stop-1'").get()).toEqual({ status: "refunded" });
    expect(score()).toEqual(before);
    // the run that was in progress cannot deliver into a stopped job
    expect(completeTask(job.taskId, "Finished anyway.")).toBeNull();
    expect(getTaskById(job.taskId)!.output).toBeUndefined();
    expect(stopJob(job.taskId)).toMatchObject({ ok: false, refused: "finished" });
  });

  it("works on a job in the queue and on one waiting for an answer, which nobody is asked any more", async () => {
    agent("data-agent");
    const queued = await hired({ from: "anonymous", to: "data-agent", task: "Analyse the sales" });
    expect((await stop(queued.taskId, { "x-claim-token": queued.claimToken! })).body.status).toBe("cancelled");
    expect(startTask(queued.taskId, "worker")).toBeNull();

    const asking = await hired({ from: "anonymous", to: "data-agent", task: "Analyse the sales", allowQuestions: true });
    startTask(asking.taskId, "worker");
    await askTool({ taskId: asking.taskId, onAsked: () => {} }).run({ question: "Which sheet do you mean?" });
    parkForAnswer(asking.taskId);
    expect((await stop(asking.taskId, { "x-claim-token": asking.claimToken! })).status).toBe(200);
    expect(openQuestion(asking.taskId)).toBeNull();
    expect((await read(asking.taskId, asking.claimToken!)).status).toBe("cancelled");
  });

  it("only by whoever hired the job, and not once it has finished", async () => {
    const a = agent("data-agent");
    const job = await hired({ from: "anonymous", to: "data-agent", task: "Analyse the sales" });
    startTask(job.taskId, "worker");
    expect((await stop(job.taskId, { "x-claim-token": "0".repeat(32) })).status).toBe(403);
    expect((await stop(job.taskId)).status).toBe(401);
    // the agent's owner may read the job, but does not get to stop it
    expect((await stop(job.taskId, { authorization: `Bearer ${createApiKey(a.walletAddress!, {}).apiKey}` })).status).toBe(403);
    expect(getTaskById(job.taskId)!.status).toBe("running");
    completeTask(job.taskId, "Done.");
    const late = await stop(job.taskId, { "x-claim-token": job.claimToken! });
    expect(late.status).toBe(409);
    expect(getTaskById(job.taskId)!.status).toBe("completed");

    process.env.AGENT_STEER = "off";
    expect((await stop(job.taskId, { "x-claim-token": job.claimToken! })).status).toBe(404);
  });
});

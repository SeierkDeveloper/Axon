// Work with your agent, phase 1: a follow-up. A finished job can be continued by whoever hired it: the same agent is
// hired again, the new job names the one it follows, carries the files from before, and the agent is given the
// conversation so far. No model is called here.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { completeTask, createTask, getTaskById, startTask } from "@/lib/tasks";
import { storeFile, keepOutput, filesOfTask, CONTEXT_KEY, type StoreResult } from "@/lib/agentFiles";
import { checkFollowUp, conversationBefore, earlierTurns, followUpEnabled, followUpView, maxTurns, turnOf, FOLLOW_KEY, HISTORY } from "@/lib/followUp";
import { getPublicReceipt } from "@/lib/receipts";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const CSV = Buffer.from("Quarter,Revenue\nQ1,120\nQ2,180\n");

let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 9_900_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult | null) => { if (!r || !r.ok) throw new Error(`refused: ${r ? r.reason : "nothing kept"}`); return r; };

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}

type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown>; parentTaskId?: string; threadId?: string; toAgent?: string; error?: string; details?: { refused?: string } };
const post = (body: unknown, headers: Record<string, string> = {}) =>
  hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.3.0.1", ...headers }, body: JSON.stringify(body) }));
const hired = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await post(body, headers);
  return { status: res.status, body: (await res.json()) as Created };
};
/** The job done, with this answer. */
const finish = (taskId: string, answer: string) => { startTask(taskId, "test"); completeTask(taskId, answer); };
const read = async (taskId: string, token: string) =>
  (await (await taskGet(new NextRequest(`http://x/api/tasks/${taskId}`, { headers: { "x-claim-token": token } }), { params: Promise.resolve({ taskId }) })).json()) as { followUp?: { thread: string; turn: number; of?: string; open: boolean; turnsLeft: number } };

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-follow-up-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FOLLOWUP: "on", AGENT_FILES: "on", AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
  delete process.env.AXON_FOLLOWUP_MAX_TURNS;
  getDb().exec("DELETE FROM task_files; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the switch", () => {
  it("is off unless AGENT_FOLLOWUP is on, and a conversation runs 12 turns unless set otherwise", () => {
    expect(followUpEnabled({})).toBe(false);
    expect(followUpEnabled({ AGENT_FOLLOWUP: "ON " })).toBe(true);
    expect(maxTurns({})).toBe(12);
    expect(maxTurns({ AXON_FOLLOWUP_MAX_TURNS: "4" })).toBe(4);
    expect(maxTurns({ AXON_FOLLOWUP_MAX_TURNS: "1" })).toBe(12);
    expect(maxTurns({ AXON_FOLLOWUP_MAX_TURNS: "lots" })).toBe(12);
  });

  it("off: a hire that names a job to follow is refused, every other hire is as before, and a job says nothing about follow-ups", async () => {
    agent("sum-agent");
    const first = await hired({ from: "anonymous", to: "sum-agent", task: "Add these up" });
    expect(first.status).toBe(201);
    finish(first.body.taskId, "The total is 300.");
    process.env.AGENT_FOLLOWUP = "off";
    const refused = await hired({ from: "anonymous", task: "And the average?", followUpOf: first.body.taskId, followUpToken: first.body.claimToken });
    expect(refused.status).toBe(400);
    expect(refused.body.details?.refused).toBe("off");
    expect((await read(first.body.taskId, first.body.claimToken!)).followUp).toBeUndefined();
    // a caller's own context key of that name is theirs again while the feature is off
    const plain = await hired({ from: "anonymous", to: "sum-agent", task: "Another", context: { [FOLLOW_KEY]: "mine" } });
    expect(plain.status).toBe(201);
    expect(plain.body.parentTaskId).toBeUndefined();
  });
});

describe("following up a finished job", () => {
  it("a visitor follows their own hire with its token: the same agent, the job named, turn two", async () => {
    agent("sum-agent");
    const first = await hired({ from: "anonymous", to: "sum-agent", task: "Add these up" });
    finish(first.body.taskId, "The total is 300.");
    expect((await read(first.body.taskId, first.body.claimToken!)).followUp).toEqual({ thread: first.body.taskId, turn: 1, open: true, turnsLeft: 11 });

    // the agent is not named: the job being followed names it
    const second = await hired({ from: "anonymous", task: "And the average?", followUpOf: first.body.taskId, followUpToken: first.body.claimToken });
    expect(second.status).toBe(201);
    expect(second.body.toAgent).toBe("sum-agent");
    expect(second.body.parentTaskId).toBe(first.body.taskId);
    expect(second.body.threadId).toBe(first.body.taskId);
    expect(second.body.context?.[FOLLOW_KEY]).toEqual({ of: first.body.taskId, thread: first.body.taskId, turn: 2 });
    expect(second.body.claimToken).toBeTruthy();
    // it is a job of its own, and while it runs it cannot itself be followed
    const view = (await read(second.body.taskId, second.body.claimToken!)).followUp!;
    expect(view).toMatchObject({ thread: first.body.taskId, turn: 2, of: first.body.taskId, open: false });

    // a third turn follows the second and stays in the same conversation
    finish(second.body.taskId, "The average is 150.");
    const third = await hired({ from: "anonymous", to: "sum-agent", task: "Round it", followUpOf: second.body.taskId, followUpToken: second.body.claimToken });
    expect(third.status).toBe(201);
    expect(third.body.threadId).toBe(first.body.taskId);
    expect((third.body.context?.[FOLLOW_KEY] as { turn: number }).turn).toBe(3);
    expect(earlierTurns(getTaskById(third.body.taskId)!).map((t) => t.taskId)).toEqual([first.body.taskId, second.body.taskId]);
  });

  it("refuses a job that is not the caller's exactly like one that does not exist", async () => {
    agent("sum-agent");
    const first = await hired({ from: "anonymous", to: "sum-agent", task: "Add these up" });
    finish(first.body.taskId, "300");
    const other = await hired({ from: "anonymous", to: "sum-agent", task: "Something else" });

    const noToken = await hired({ from: "anonymous", task: "More", followUpOf: first.body.taskId });
    const wrongToken = await hired({ from: "anonymous", task: "More", followUpOf: first.body.taskId, followUpToken: other.body.claimToken });
    const missing = await hired({ from: "anonymous", task: "More", followUpOf: "no-such-job", followUpToken: first.body.claimToken });
    for (const r of [noToken, wrongToken, missing]) {
      expect(r.status).toBe(404);
      expect(r.body.details?.refused).toBe("not_found");
      expect(r.body.error).toBe("That job was not found, or it is not yours to follow up.");
    }
    // a signed-in wallet may not follow a visitor's hire, token or not
    const w = wallet();
    const { apiKey } = createApiKey(w, {});
    const asWallet = await hired({ from: w.toLowerCase(), task: "More", followUpOf: first.body.taskId, followUpToken: first.body.claimToken }, { authorization: `Bearer ${apiKey}` });
    expect(asWallet.status).toBe(404);
    expect(getDb().prepare("SELECT COUNT(*) n FROM tasks WHERE parent_task_id IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("a signed-in wallet follows its own job without a token, and nobody else's", async () => {
    agent("sum-agent");
    const mine = wallet(), theirs = wallet();
    const { apiKey: myKey } = createApiKey(mine, {});
    const { apiKey: theirKey } = createApiKey(theirs, {});
    const first = await hired({ from: mine.toLowerCase(), to: "sum-agent", task: "Add these up" }, { authorization: `Bearer ${myKey}` });
    expect(first.status).toBe(201);
    finish(first.body.taskId, "300");

    const stranger = await hired({ from: theirs.toLowerCase(), task: "More", followUpOf: first.body.taskId }, { authorization: `Bearer ${theirKey}` });
    expect(stranger.status).toBe(404);
    const second = await hired({ from: mine.toLowerCase(), task: "And the average?", followUpOf: first.body.taskId }, { authorization: `Bearer ${myKey}` });
    expect(second.status).toBe(201);
    expect(second.body.parentTaskId).toBe(first.body.taskId);
    // an address is the same wallet however its letters are cased
    expect(checkFollowUp({ parentId: first.body.taskId, from: mine.toLowerCase().replace("0x", "0X").replace("0X", "0x").toUpperCase().replace("0X", "0x"), tokenOk: false }).ok).toBe(true);
  });

  it("only a finished single hire can be followed, by the agent that did it, and only so many times", async () => {
    agent("sum-agent");
    agent("other-agent");
    const first = await hired({ from: "anonymous", to: "sum-agent", task: "Add these up" });
    const token = first.body.claimToken;

    const early = await hired({ from: "anonymous", task: "More", followUpOf: first.body.taskId, followUpToken: token });
    expect(early.status).toBe(409);
    expect(early.body.details?.refused).toBe("not_finished");

    finish(first.body.taskId, "300");
    const elsewhere = await hired({ from: "anonymous", to: "other-agent", task: "More", followUpOf: first.body.taskId, followUpToken: token });
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.body.details?.refused).toBe("other_agent");

    const ownNote = await hired({ from: "anonymous", task: "More", followUpOf: first.body.taskId, followUpToken: token, context: { [FOLLOW_KEY]: { of: "x" } } });
    expect(ownNote.status).toBe(400);

    // a step of a crew or a workflow is not a conversation with one agent
    const step = createTask({ fromAgent: "anonymous", toAgent: "sum-agent", task: "step", workflowId: "wf-1", stepIndex: 0 });
    finish(step.taskId, "done");
    expect(checkFollowUp({ parentId: step.taskId, from: "anonymous", tokenOk: true })).toMatchObject({ ok: false, refused: "kind" });

    process.env.AXON_FOLLOWUP_MAX_TURNS = "2";
    const second = await hired({ from: "anonymous", task: "More", followUpOf: first.body.taskId, followUpToken: token });
    expect(second.status).toBe(201);
    finish(second.body.taskId, "150");
    const third = await hired({ from: "anonymous", task: "Again", followUpOf: second.body.taskId, followUpToken: second.body.claimToken });
    expect(third.status).toBe(400);
    expect(third.body.details?.refused).toBe("too_long");
    expect((await read(second.body.taskId, second.body.claimToken!)).followUp).toMatchObject({ turn: 2, open: false, turnsLeft: 0 });
  });
});

describe("the files from before", () => {
  it("go with the follow-up: what the agent made first, then what it was given, listed in the job's context", async () => {
    agent("chart-agent");
    const sheet = got(storeFile({ bytes: CSV, name: "revenue.csv" }));
    const first = await hired({ from: "anonymous", to: "chart-agent", task: "Chart this", files: [{ id: sheet.file.id, token: sheet.token }] });
    expect(first.status).toBe(201);
    got(keepOutput({ taskId: first.body.taskId, bytes: PNG, name: "chart.png", wallet: null }));
    finish(first.body.taskId, "Here is the chart.");

    const second = await hired({ from: "anonymous", task: "Make the bars blue", followUpOf: first.body.taskId, followUpToken: first.body.claimToken });
    expect(second.status).toBe(201);
    const carried = filesOfTask(second.body.taskId);
    expect(carried.map((f) => f.name)).toEqual(["chart.png", "revenue.csv"]);
    expect((second.body.context?.[CONTEXT_KEY] as { name: string }[]).map((f) => f.name)).toEqual(["chart.png", "revenue.csv"]);
    expect((second.body.context?.[FOLLOW_KEY] as { notCarried?: unknown }).notCarried).toBeUndefined();
    // the first job keeps its own files: nothing was moved
    expect(filesOfTask(first.body.taskId).map((f) => f.name)).toEqual(["revenue.csv"]);
    expect(filesOfTask(first.body.taskId, "out").map((f) => f.name)).toEqual(["chart.png"]);
  });

  it("a file sent with the follow-up comes first, and what one hire cannot carry is left behind and named", async () => {
    agent("chart-agent");
    const sheet = got(storeFile({ bytes: CSV, name: "revenue.csv" }));
    const first = await hired({ from: "anonymous", to: "chart-agent", task: "Chart this", files: [{ id: sheet.file.id, token: sheet.token }] });
    got(keepOutput({ taskId: first.body.taskId, bytes: PNG, name: "chart.png", wallet: null }));
    finish(first.body.taskId, "Here is the chart.");

    const extra = got(storeFile({ bytes: Buffer.from("Quarter,Costs\nQ1,80\n"), name: "costs.csv" }));
    const second = await hired({ from: "anonymous", task: "Add costs", followUpOf: first.body.taskId, followUpToken: first.body.claimToken, files: [{ id: extra.file.id, token: extra.token }] });
    expect(second.status).toBe(201);
    // a free hire carries two files: the new one and the chart; the old sheet stays behind
    expect(filesOfTask(second.body.taskId).map((f) => f.name).sort()).toEqual(["chart.png", "costs.csv"]);
    const note = second.body.context?.[FOLLOW_KEY] as { notCarried?: { name: string; why: string }[] };
    expect(note.notCarried).toEqual([{ name: "revenue.csv", why: "a hire carries at most 2 files" }]);
    expect(conversationBefore(getTaskById(second.body.taskId)!)).toContain("Not carried over from before: revenue.csv (a hire carries at most 2 files).");
  });

  it("with files switched off a follow-up still works and carries none", async () => {
    agent("sum-agent");
    const first = await hired({ from: "anonymous", to: "sum-agent", task: "Add these up" });
    finish(first.body.taskId, "300");
    process.env.AGENT_FILES = "off";
    const second = await hired({ from: "anonymous", task: "More", followUpOf: first.body.taskId, followUpToken: first.body.claimToken });
    expect(second.status).toBe(201);
    expect(second.body.context?.[CONTEXT_KEY]).toBeUndefined();
  });
});

describe("what the agent is told", () => {
  const chain = (answers: string[]) => {
    let parent: string | undefined, thread: string | undefined;
    const ids: string[] = [];
    answers.forEach((a, i) => {
      const t = createTask({ fromAgent: "anonymous", toAgent: "sum-agent", task: `Question ${i + 1}`, ...(parent ? { parentTaskId: parent, threadId: thread } : {}) });
      finish(t.taskId, a);
      parent = t.taskId;
      thread = thread ?? t.taskId;
      ids.push(t.taskId);
    });
    return createTask({ fromAgent: "anonymous", toAgent: "sum-agent", task: "The new message", parentTaskId: parent, threadId: thread });
  };

  it("nothing extra on a hire that follows nothing", () => {
    agent("sum-agent");
    const t = createTask({ fromAgent: "anonymous", toAgent: "sum-agent", task: "Hello" });
    expect(conversationBefore(t)).toBe("");
    expect(turnOf(t)).toBe(1);
  });

  it("the conversation so far, in order, ending where the person's new words begin", () => {
    agent("sum-agent");
    const t = chain(["The total is 300.", "The average is 150."]);
    const said = conversationBefore(t);
    expect(said.startsWith("This is a follow-up.")).toBe(true);
    expect(said.endsWith("The person now says:\n")).toBe(true);
    const order = ["[Turn 1] The person asked:\nQuestion 1", "You answered:\nThe total is 300.", "[Turn 2] The person asked:\nQuestion 2", "You answered:\nThe average is 150."].map((x) => said.indexOf(x));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(said).not.toContain("left out");
    expect(turnOf(t)).toBe(3);
  });

  it("a long answer is cut and says so; a long conversation loses its oldest turns and says so", () => {
    agent("sum-agent");
    const long = "x".repeat(HISTORY.answer + 500);
    const cutOne = conversationBefore(chain([long]));
    expect(cutOne).toContain("[The rest is left out here: 500 more characters.]");
    expect(cutOne).not.toContain("x".repeat(HISTORY.answer + 1));

    const many = conversationBefore(chain(Array.from({ length: 8 }, () => long)));
    expect(many.length).toBeLessThan(HISTORY.total + 2_000);
    expect(many).toMatch(/\(\d earlier turns are left out to keep this short\.\)/);
    // the latest turn is always there
    expect(many).toContain("[Turn 8] The person asked:\nQuestion 8");
    expect(many).not.toContain("[Turn 1] The person asked:");
  });
});

describe("the receipt", () => {
  it("of a follow-up names the job it continues; every other receipt is as it was", async () => {
    agent("sum-agent");
    const first = await hired({ from: "anonymous", to: "sum-agent", task: "Add these up" });
    finish(first.body.taskId, "300");
    const second = await hired({ from: "anonymous", task: "More", followUpOf: first.body.taskId, followUpToken: first.body.claimToken });
    expect(getPublicReceipt(second.body.taskId)).toMatchObject({ followUpOf: first.body.taskId, turn: 2 });
    const plain = getPublicReceipt(first.body.taskId)!;
    expect("followUpOf" in plain).toBe(false);
    expect("turn" in plain).toBe(false);
    expect(followUpView(getTaskById(first.body.taskId)!)).toMatchObject({ turn: 1, open: true });
  });
});

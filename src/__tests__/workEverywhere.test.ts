// Work with your agent, phase 10: everywhere. What a hire can do on the site it can do from an assistant (the tool
// layer), from Mylo and from the SDK. This file is the tool layer and the hire route's part in it. No model is called.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import type { Agent } from "@/sdk/types";
import { completeTask, getTaskById, startTask } from "@/lib/tasks";
import { keepOutput, type StoreResult } from "@/lib/agentFiles";
import { askTool, parkForAnswer } from "@/lib/ask";
import { keepPlan, parkForPlan } from "@/lib/planFirst";
import { notesOf } from "@/lib/steer";
import { memoryOwnerOf } from "@/lib/agentMemory";
import { libraryOwnerOf } from "@/lib/library";
import { handleMcpMessage, claimTokenFor, mcpTools, agentToolset, MCP_TOOLS } from "@/lib/mcpServer";
import { POST as hire } from "@/app/api/tasks/route";

afterEach(() => { vi.unstubAllEnvs(); });

const SWITCHES = { AGENT_FOLLOWUP: "on", AGENT_BRINGIN: "on", AGENT_ASK: "on", AGENT_PLAN: "on", AGENT_STEER: "on", AGENT_MEMORY: "on", AGENT_LIBRARY: "on", AGENT_FILES: "on", AGENT_OFFICE: "on" };
const KEY = "k".repeat(40);
let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 4_400_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult | null) => { if (!r || !r.ok) throw new Error("refused"); return r; };

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
type Out = Record<string, unknown> & { taskId?: string; claimToken?: string; error?: string; status?: string };
const call = async (name: string, args: Record<string, unknown>, apiKey: string | null = null, scope: string | null = null) => {
  const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "10.10.0.1", apiKey, scope);
  const r = res as { result?: { content: { text: string }[] }; error?: { message: string } };
  if (!r.result) return { error: `rpc: ${r.error?.message}` } as Out;
  return JSON.parse(r.result.content[0].text) as Out;
};
const finish = (taskId: string, answer: string) => { startTask(taskId, "test"); completeTask(taskId, answer); };
const names = () => mcpTools().map((t) => t.name);

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-everywhere-")); });
beforeEach(() => {
  Object.assign(process.env, { ...SWITCHES, AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM task_files; DELETE FROM task_questions; DELETE FROM task_notes; DELETE FROM agent_memories; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the tool list", () => {
  it("with every switch off it is exactly what it was", () => {
    // the shop adds tools of its own (AGENT_SHOP): this list is the one without it
    vi.stubEnv("AGENT_SHOP", "off");
    for (const k of Object.keys(SWITCHES)) process.env[k] = "off";
    expect(mcpTools()).toEqual(MCP_TOOLS);
  });

  it("each feature adds its own part and nothing else", () => {
    // the shop adds tools of its own (AGENT_SHOP): this list is the one without it
    vi.stubEnv("AGENT_SHOP", "off");
    for (const k of Object.keys(SWITCHES)) process.env[k] = "off";
    const hireProps = () => Object.keys(mcpTools().find((t) => t.name === "hire_agent")!.inputSchema.properties);
    const before = hireProps();
    process.env.AGENT_ASK = "on";
    expect(names()).toContain("answer_agent");
    expect(names()).not.toContain("decide_plan");
    expect(hireProps()).toEqual([...before, "allowQuestions"]);
    process.env.AGENT_PLAN = "on";
    process.env.AGENT_STEER = "on";
    process.env.AGENT_LIBRARY = "on";
    expect(names().slice(-4)).toEqual(["answer_agent", "decide_plan", "steer_task", "get_library"]);
    process.env.AGENT_FOLLOWUP = "on";
    const hireTool = mcpTools().find((t) => t.name === "hire_agent")!;
    expect(Object.keys(hireTool.inputSchema.properties)).toEqual(expect.arrayContaining(["followUpOf", "followUpToken", "planFirst"]));
    // with a job to follow, the agent may be left out
    expect(hireTool.inputSchema.required).toEqual(["task"]);
    expect(hireTool.description).toMatch(/followUpOf/);
    expect(hireTool.description).not.toMatch(/—/);
  });

  it("one agent's own link carries the same tools", () => {
    agent("quill");
    const set = agentToolset("quill")!;
    expect(set.tools.map((t) => t.name)).toEqual(["quill", "get_task_result", "get_allowance", "get_receipt", "answer_agent", "decide_plan", "steer_task", "get_library"].sort((a, b) => set.tools.findIndex((t) => t.name === a) - set.tools.findIndex((t) => t.name === b)));
    expect(Object.keys(set.tools[0].inputSchema.properties)).toEqual(expect.arrayContaining(["followUpOf", "allowQuestions", "planFirst", "memory"]));
    expect(Object.keys(set.tools[0].inputSchema.properties)).not.toContain("agentId");
  });
});

describe("a conversation from an assistant", () => {
  it("follows a finished job up with its token, the agent left out", async () => {
    agent("quill");
    const first = await call("hire_agent", { agentId: "quill", task: "Write a line" });
    expect(first.claimToken).toBeTruthy();
    finish(first.taskId!, "A line.");
    const read = await call("get_task_result", { taskId: first.taskId, claimToken: first.claimToken });
    expect(read.conversation).toMatchObject({ thread: first.taskId, turn: 1 });
    expect(String((read.followUp as { next: string }).next)).toMatch(/followUpOf/);

    const next = await call("hire_agent", { task: "Shorter", followUpOf: first.taskId, followUpToken: first.claimToken });
    expect(next.error).toBeUndefined();
    const t = getTaskById(next.taskId!)!;
    expect(t).toMatchObject({ toAgent: "quill", parentTaskId: first.taskId, threadId: first.taskId });
    expect((await call("get_task_result", { taskId: next.taskId, claimToken: next.claimToken })).conversation).toMatchObject({ turn: 2, follows: first.taskId });
    // without the token the job is nobody's to follow
    expect((await call("hire_agent", { task: "Again", followUpOf: first.taskId })).error).toMatch(/not found|not yours/i);
    expect((await call("hire_agent", { task: "Again", followUpOf: first.taskId, followUpToken: "0".repeat(32) })).error).toMatch(/not found|not yours/i);
  });

  it("brings another agent into the conversation by naming it", async () => {
    agent("Data Agent");
    agent("Design Agent");
    const first = await call("hire_agent", { agentId: "Data Agent", task: "Chart revenue" });
    finish(first.taskId!, "Here is the chart.");
    const other = await call("hire_agent", { agentId: "Design Agent", task: "Restyle it", followUpOf: first.taskId, followUpToken: first.claimToken });
    expect(getTaskById(other.taskId!)).toMatchObject({ toAgent: "Design Agent", threadId: first.taskId });
  });

  it("the job's token proves the hirer whatever name the follow-up is made under", async () => {
    agent("quill");
    const first = await call("hire_agent", { agentId: "quill", task: "Write a line" });
    finish(first.taskId!, "A line.");
    const w = wallet(), { apiKey } = createApiKey(w, {});
    const post = (body: unknown, headers: Record<string, string> = {}) => hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.10.0.1", ...headers }, body: JSON.stringify(body) }));
    // signed in, with the token: theirs to follow
    expect((await post({ from: w.toLowerCase(), to: "quill", task: "Shorter", followUpOf: first.taskId, followUpToken: first.claimToken }, { authorization: `Bearer ${apiKey}` })).status).toBe(201);
    // signed in, without it: a job hired without signing in is not theirs
    expect((await post({ from: w.toLowerCase(), to: "quill", task: "Shorter", followUpOf: first.taskId }, { authorization: `Bearer ${apiKey}` })).status).toBe(404);
  });

  it("answers the question a job waits on", async () => {
    agent("quill");
    const job = await call("hire_agent", { agentId: "quill", task: "Write a line", allowQuestions: true });
    expect(getTaskById(job.taskId!)!.context).toMatchObject({ mayAsk: true });
    startTask(job.taskId!, "test");
    await askTool({ taskId: job.taskId!, onAsked: () => {} }).run({ question: "Which language?", choices: ["English", "Swedish"] });
    expect(parkForAnswer(job.taskId!)).toBe(true);
    const waiting = await call("get_task_result", { taskId: job.taskId, claimToken: job.claimToken });
    expect(waiting.status).toBe("waiting");
    expect(waiting.question).toMatchObject({ text: "Which language?", choices: ["English", "Swedish"] });
    expect((await call("answer_agent", { taskId: job.taskId, claimToken: "wrong", answer: "Swedish" })).error).toMatch(/claim token/);
    const empty = await call("answer_agent", { taskId: job.taskId, claimToken: job.claimToken, answer: " " });
    expect(empty.error).toBeTruthy();
    const answered = await call("answer_agent", { taskId: job.taskId, claimToken: job.claimToken, answer: "Swedish" });
    expect(answered.status).toBe("queued");
    const after = await call("get_task_result", { taskId: job.taskId, claimToken: job.claimToken });
    expect(after.question).toBeUndefined();
    expect(after.asked).toEqual([{ question: "Which language?", answer: "Swedish", answeredBy: "you" }]);
    // nothing waits now
    expect((await call("answer_agent", { taskId: job.taskId, claimToken: job.claimToken, answer: "English" })).error).toBeTruthy();
  });

  it("approves, changes or cancels a plan", async () => {
    agent("quill");
    const plan = async () => {
      const job = await call("hire_agent", { agentId: "quill", task: "Write a long report on shipping lanes", planFirst: true });
      expect(getTaskById(job.taskId!)!.context).toMatchObject({ planFirst: true });
      startTask(job.taskId!, "test");
      keepPlan(job.taskId!, "1. Read. 2. Write.");
      expect(parkForPlan(job.taskId!)).toBe(true);
      return job;
    };
    const a = await plan();
    const waiting = await call("get_task_result", { taskId: a.taskId, claimToken: a.claimToken });
    expect(waiting.plan).toMatchObject({ text: "1. Read. 2. Write." });
    expect((await call("decide_plan", { taskId: a.taskId, claimToken: a.claimToken, decision: "maybe" })).error).toMatch(/approve, change or cancel/);
    expect((await call("decide_plan", { taskId: a.taskId, claimToken: a.claimToken, decision: "change" })).error).toBeTruthy();
    expect((await call("decide_plan", { taskId: a.taskId, claimToken: a.claimToken, decision: "change", change: "Shorter, two pages" })).status).toBe("queued");
    const b = await plan();
    expect((await call("decide_plan", { taskId: b.taskId, claimToken: b.claimToken, decision: "approve" })).status).toBe("queued");
    const c = await plan();
    const cancelled = await call("decide_plan", { taskId: c.taskId, claimToken: c.claimToken, decision: "cancel" });
    expect(cancelled.status).toBe("cancelled");
    expect(String((await call("get_task_result", { taskId: c.taskId, claimToken: c.claimToken })).cancelled)).toMatch(/refunded/);
  });

  it("sends a running job a note, and stops one", async () => {
    agent("quill");
    const job = await call("hire_agent", { agentId: "quill", task: "Write a long report" });
    startTask(job.taskId!, "test");
    expect((await call("get_task_result", { taskId: job.taskId, claimToken: job.claimToken })).whileItRuns).toMatchObject({ stoppable: true });
    expect((await call("steer_task", { taskId: job.taskId, claimToken: job.claimToken })).error).toMatch(/note/);
    const sent = await call("steer_task", { taskId: job.taskId, claimToken: job.claimToken, note: "Use euros" });
    expect(sent.sent).toBe("Use euros");
    expect(notesOf(job.taskId!).map((x) => x.text)).toEqual(["Use euros"]);
    expect((await call("get_task_result", { taskId: job.taskId, claimToken: job.claimToken })).notes).toEqual([{ text: "Use euros", read: false }]);
    const stopped = await call("steer_task", { taskId: job.taskId, claimToken: job.claimToken, stop: true });
    expect(stopped.status).toBe("cancelled");
    expect((await call("steer_task", { taskId: job.taskId, claimToken: job.claimToken, note: "Too late" })).error).toBeTruthy();
  });
});

describe("who the hirer is", () => {
  it("a key on the connection names the memory and the library of a free hire, and pays nothing", async () => {
    agent("quill");
    const w = wallet(), { apiKey } = createApiKey(w, {});
    const job = await call("hire_agent", { agentId: "quill", task: "Write a line", memory: true }, apiKey);
    expect(job.error).toBeUndefined();
    expect(getTaskById(job.taskId!)!.fromAgent).toBe("anonymous");
    expect(libraryOwnerOf(job.taskId!)).toBe(`w:${w.toLowerCase()}`);
    expect(memoryOwnerOf(job.taskId!)).toBe(`w:${w.toLowerCase()}`);
    // no memory asked for: the library still knows whose it is, the agent's memory is left alone
    const plain = await call("hire_agent", { agentId: "quill", task: "Another" }, apiKey);
    expect(libraryOwnerOf(plain.taskId!)).toBe(`w:${w.toLowerCase()}`);
    expect(memoryOwnerOf(plain.taskId!)).toBeNull();
  });

  it("without a key, the memoryKey it sends", async () => {
    agent("quill");
    const job = await call("hire_agent", { agentId: "quill", task: "Write a line", memory: true, memoryKey: KEY });
    expect(libraryOwnerOf(job.taskId!)).toMatch(/^v:/);
    expect(memoryOwnerOf(job.taskId!)).toBe(libraryOwnerOf(job.taskId!));
    expect(libraryOwnerOf((await call("hire_agent", { agentId: "quill", task: "Nobody's" })).taskId!)).toBeNull();
  });
});

describe("the library from an assistant", () => {
  it("lists conversations, reads one with the tokens that carry it on, and lists files", async () => {
    agent("quill");
    const w = wallet(), { apiKey } = createApiKey(w, {});
    const first = await call("hire_agent", { agentId: "quill", task: "Make the table" }, apiKey);
    finish(first.taskId!, "Done.");
    got(keepOutput({ taskId: first.taskId!, bytes: Buffer.from("a,b\n1,2\n"), name: "table.csv", wallet: null }));
    const listed = await call("get_library", {}, apiKey);
    expect(listed.conversations).toEqual([expect.objectContaining({ thread: first.taskId, agents: ["quill"], began: "Make the table", turns: 1, files: 1, status: "completed" })]);
    const whole = await call("get_library", { thread: first.taskId }, apiKey);
    const turn = (whole.turns as { taskId: string; claimToken: string; answer: string; files: { name: string; url: string }[] }[])[0];
    expect(turn).toMatchObject({ taskId: first.taskId, claimToken: claimTokenFor(first.taskId!), answer: "Done." });
    expect(turn.files[0].url).toMatch(/\/api\/files\/f_[0-9a-f]{32}\/content\?token=/);
    // and carries on from there
    expect((await call("hire_agent", { task: "Add a row", followUpOf: turn.taskId, followUpToken: turn.claimToken }, apiKey)).error).toBeUndefined();
    expect((await call("get_library", { files: true }, apiKey)).files).toEqual([expect.objectContaining({ name: "table.csv", version: 1, madeBy: "quill" })]);
    expect((await call("get_library", { thread: "no-such-thread" }, apiKey)).error).toMatch(/No such conversation/);
  });

  it("is read with a full key or the hires' own key, never with an allowance key or nothing", async () => {
    agent("quill");
    const w = wallet(), full = createApiKey(w, {}).apiKey, assistant = createApiKey(w, { scope: "allowance" }).apiKey;
    await call("hire_agent", { agentId: "quill", task: "By key" }, full);
    await call("hire_agent", { agentId: "quill", task: "By memory key", memoryKey: KEY });
    expect((await call("get_library", {})).error).toMatch(/full Axon key/);
    expect((await call("get_library", {}, assistant)).error).toMatch(/allowance key/);
    expect((await call("get_library", {}, "not-a-key")).error).toBeTruthy();
    expect(((await call("get_library", { memoryKey: KEY })).conversations as { began: string }[]).map((c) => c.began)).toEqual(["By memory key"]);
    expect(((await call("get_library", { memoryKey: KEY }, full)).conversations as { began: string }[]).map((c) => c.began).sort()).toEqual(["By key", "By memory key"]);
    // an assistant's own key may still pass the hires' key
    expect(((await call("get_library", { memoryKey: KEY }, assistant)).conversations as unknown[]).length).toBe(1);
  });

  it("off, the tools are not there at all", async () => {
    agent("quill");
    process.env.AGENT_LIBRARY = "off";
    process.env.AGENT_ASK = "off";
    expect((await call("get_library", {})).error).toMatch(/rpc|unknown/i);
    expect((await call("answer_agent", { taskId: "x", claimToken: "y", answer: "z" })).error).toMatch(/rpc|unknown/i);
  });
});

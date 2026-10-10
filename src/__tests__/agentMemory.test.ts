// Work with your agent, phase 6: it remembers you. An agent keeps what it noted about a person and is reminded of
// the work it did for them; the person sees it, deletes it, or leaves it out of a hire. No model is called here.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { completeTask, startTask } from "@/lib/tasks";
import {
  canNote, canRemember, forget, memoriesOf, memoryEnabled, memoryNote, memoryOwnerFor, memoryOwnerOf, memoryView, pastWork, remember, rememberedBy,
  rememberTool, validMemoryKey, withRemember, MEMORY,
} from "@/lib/agentMemory";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";
import { GET as memoryGet, DELETE as memoryForget } from "@/app/api/agents/[agentId]/memory/route";
import { DELETE as lineDelete } from "@/app/api/agents/[agentId]/memory/[lineId]/route";

const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 3_300_000).toString(16).padStart(40, "0")}`;
const KEY = "k".repeat(40), OTHER = "z".repeat(40);

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["writing"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown>; error?: string };
const hired = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.8.0.1", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Created };
};
const finish = (taskId: string, answer: string) => { startTask(taskId, "test"); completeTask(taskId, answer); };
type View = { lines: { id: string; text: string }[]; jobs: number; most: number; forgotten?: number };
const readMemory = async (agentId: string, headers: Record<string, string>) => {
  const res = await memoryGet(new NextRequest(`http://x/api/agents/${agentId}/memory`, { headers: { "x-forwarded-for": "10.8.0.2", ...headers } }), { params: Promise.resolve({ agentId }) });
  return { status: res.status, body: (await res.json()) as View };
};

beforeEach(() => {
  Object.assign(process.env, { AGENT_MEMORY: "on", AGENT_FOLLOWUP: "on", TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM agent_memories; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("whose memory it is", () => {
  it("is off unless AGENT_MEMORY is on", () => {
    expect(memoryEnabled({})).toBe(false);
    expect(memoryEnabled({ AGENT_MEMORY: "on" })).toBe(true);
  });

  it("a wallet's own, else a key the browser keeps, stored only as a hash; else nobody's", () => {
    const w = wallet();
    expect(memoryOwnerFor({ wallet: w })).toBe(`w:${w.toLowerCase()}`);
    // signed in, the memory is the wallet's whatever key came along
    expect(memoryOwnerFor({ wallet: w.toUpperCase().replace("0X", "0x"), key: KEY })).toBe(`w:${w.toLowerCase()}`);
    const byKey = memoryOwnerFor({ key: KEY })!;
    expect(byKey).toMatch(/^v:[0-9a-f]{64}$/);
    expect(byKey).not.toContain(KEY);
    expect(memoryOwnerFor({ key: KEY })).toBe(byKey);
    expect(memoryOwnerFor({ key: OTHER })).not.toBe(byKey);
    expect(memoryOwnerFor({})).toBeNull();
    expect(memoryOwnerFor({ key: "short" })).toBeNull();
    expect(validMemoryKey("a b".repeat(20))).toBe(false);
  });

  it("a hire reads and adds to memory only when it asks to, and a follow-up keeps the memory of the job it follows", async () => {
    agent("quill");
    const plain = await hired({ from: "anonymous", to: "quill", task: "Write a line" });
    expect(memoryOwnerOf(plain.body.taskId)).toBeNull();
    const withKey = await hired({ from: "anonymous", to: "quill", task: "Write a line", memory: true, memoryKey: KEY });
    expect(withKey.status).toBe(201);
    expect(memoryOwnerOf(withKey.body.taskId)).toBe(memoryOwnerFor({ key: KEY }));
    // whose memory it is stays off the job's context: it is nobody's business but the hirer's
    expect(JSON.stringify(withKey.body)).not.toContain(KEY);
    expect(JSON.stringify(withKey.body)).not.toContain("v:");
    expect(memoryOwnerOf((await hired({ from: "anonymous", to: "quill", task: "x", memory: false, memoryKey: KEY })).body.taskId)).toBeNull();
    expect((await hired({ from: "anonymous", to: "quill", task: "x", memoryKey: "too short" })).status).toBe(400);
    // asked for with no key and no wallet: there is nobody to remember
    expect(memoryOwnerOf((await hired({ from: "anonymous", to: "quill", task: "x", memory: true })).body.taskId)).toBeNull();

    const w = wallet();
    const { apiKey } = createApiKey(w, {});
    const signedIn = await hired({ from: w.toLowerCase(), to: "quill", task: "Write a line", memory: true }, { authorization: `Bearer ${apiKey}` });
    expect(memoryOwnerOf(signedIn.body.taskId)).toBe(`w:${w.toLowerCase()}`);
    // an API hire that does not ask is as it always was
    expect(memoryOwnerOf((await hired({ from: w.toLowerCase(), to: "quill", task: "x" }, { authorization: `Bearer ${apiKey}` })).body.taskId)).toBeNull();

    finish(withKey.body.taskId, "A line.");
    const follow = await hired({ from: "anonymous", task: "Another", followUpOf: withKey.body.taskId, followUpToken: withKey.body.claimToken });
    expect(memoryOwnerOf(follow.body.taskId)).toBe(memoryOwnerFor({ key: KEY }));

    process.env.AGENT_MEMORY = "off";
    expect(memoryOwnerOf((await hired({ from: "anonymous", to: "quill", task: "x", memory: true, memoryKey: KEY })).body.taskId)).toBeNull();
  });
});

describe("what is kept", () => {
  const owner = memoryOwnerFor({ key: KEY })!;

  it("one short line at a time, not twice, never a secret, and only so many", () => {
    agent("quill");
    expect(remember({ owner, agentId: "quill", text: "  Wants every answer   in Swedish. " }, { now: Date.parse("2026-10-10T11:00:00Z") })).toMatchObject({ ok: true, line: { text: "Wants every answer in Swedish." } });
    expect(remember({ owner, agentId: "quill", text: "wants every answer in swedish" })).toMatchObject({ ok: false, refused: "known" });
    expect(remember({ owner, agentId: "quill", text: "ok" })).toMatchObject({ ok: false, refused: "empty" });
    expect(remember({ owner, agentId: "quill", text: "x".repeat(MEMORY.lineChars + 1) })).toMatchObject({ ok: false, refused: "too_long" });
    for (const secret of ["Their password: hunter2hunter2", "API key is sk-abcdefghijklmnopqrstuvwx", `Wallet key ${"ab".repeat(32)}`, "Card 4242 4242 4242 4242 expires soon"]) {
      expect(remember({ owner, agentId: "quill", text: secret })).toMatchObject({ ok: false, refused: "secret" });
    }
    expect(memoriesOf(owner, "quill").map((m) => m.text)).toEqual(["Wants every answer in Swedish."]);
    // kept per person and per agent
    agent("other-agent");
    expect(memoriesOf(owner, "other-agent")).toEqual([]);
    expect(memoriesOf(memoryOwnerFor({ key: OTHER })!, "quill")).toEqual([]);

    for (let i = 0; i < MEMORY.lines + 2; i++) remember({ owner, agentId: "quill", text: `Fact number ${i} about the project.` }, { now: Date.parse("2026-10-10T12:00:00Z") + i * 1000 });
    const kept = memoriesOf(owner, "quill");
    expect(kept).toHaveLength(MEMORY.lines);
    // the oldest went first
    expect(kept.some((m) => m.text === "Wants every answer in Swedish.")).toBe(false);
    expect(kept.at(-1)!.text).toBe(`Fact number ${MEMORY.lines + 1} about the project.`);
  });

  it("the agent notes things with its tool, a few a job, and the job says what it noted", async () => {
    agent("quill");
    const job = await hired({ from: "anonymous", to: "quill", task: "Write a line, in Swedish from now on", memory: true, memoryKey: KEY });
    const heard: string[] = [];
    const tool = rememberTool({ owner, agentId: "quill", taskId: job.body.taskId, onNoted: (l) => heard.push(l.text) });
    expect(await tool.run({ note: "Wants every answer in Swedish." })).toContain("Noted for next time");
    expect(await tool.run({ note: "Wants every answer in Swedish." })).toContain("Already remembered");
    await expect(tool.run({ note: "token: abcdefghijklmnop1234" })).rejects.toThrow(/secret/);
    await tool.run({ note: "Their shop is called Tarn." });
    await tool.run({ note: "Prefers metric units." });
    await expect(tool.run({ note: "Writes to customers informally." })).rejects.toThrow(/at most 3/);
    expect(heard).toEqual(["Wants every answer in Swedish.", "Their shop is called Tarn.", "Prefers metric units."]);
    expect(rememberedBy(job.body.taskId)).toHaveLength(3);
    const seen = (await (await taskGet(new NextRequest(`http://x/api/tasks/${job.body.taskId}`, { headers: { "x-claim-token": job.body.claimToken! } }), { params: Promise.resolve({ taskId: job.body.taskId }) })).json()) as { remembered?: { text: string }[] };
    expect(seen.remembered?.map((m) => m.text)).toEqual(heard);

    const once = withRemember(null, tool);
    expect(canRemember(once)).toBe(true);
    expect(withRemember(once, tool)).toBe(once);
    expect(canNote({ provider: "anthropic" })).toBe(true);
    expect(canNote({ provider: "openai" })).toBe(false);
    expect(canNote({ provider: "anthropic", orchestrator: true })).toBe(false);
    expect(canNote({ provider: "anthropic" }, { viaMcp: true })).toBe(false);
  });
});

describe("what the agent is told next time", () => {
  const owner = memoryOwnerFor({ key: KEY })!;

  it("nothing about a stranger; what it noted and the work it did for somebody it knows", async () => {
    agent("quill");
    expect(memoryNote(owner, "quill")).toBe("");
    const first = await hired({ from: "anonymous", to: "quill", task: "Write a product line for a steel bottle called Tarn", memory: true, memoryKey: KEY });
    remember({ owner, agentId: "quill", text: "Wants every answer in Swedish.", taskId: first.body.taskId });
    finish(first.body.taskId, "Tarn håller drycken kall i 24 timmar.");
    // somebody else's job with the same agent, and a job of theirs that is not finished: neither is recalled
    const stranger = await hired({ from: "anonymous", to: "quill", task: "A stranger's job", memory: true, memoryKey: OTHER });
    finish(stranger.body.taskId, "A stranger's answer.");
    await hired({ from: "anonymous", to: "quill", task: "Still running", memory: true, memoryKey: KEY });

    const second = await hired({ from: "anonymous", to: "quill", task: "Now one for a mug", memory: true, memoryKey: KEY });
    const note = memoryNote(owner, "quill", { taskId: second.body.taskId });
    expect(note).toContain("You have worked for this person before.");
    expect(note).toContain("- Wants every answer in Swedish.");
    expect(note).toContain(`they asked "Write a product line for a steel bottle called Tarn". You answered: "Tarn håller drycken kall i 24 timmar."`);
    expect(note).not.toContain("stranger");
    expect(note).not.toContain("Still running");
    expect(note).toContain("Do not recite it back to them.");
    expect(pastWork(owner, "quill", second.body.taskId).map((j) => j.taskId)).toEqual([first.body.taskId]);
    // a follow-up has the conversation itself: it is told what was noted, not the earlier work again
    const brief = memoryNote(owner, "quill", { taskId: second.body.taskId, withWork: false });
    expect(brief).toContain("- Wants every answer in Swedish.");
    expect(brief).not.toContain("Earlier jobs");
    expect(memoryNote(memoryOwnerFor({ key: OTHER })!, "quill", { withWork: false })).toBe("");
  });

  it("long asks and answers are clipped, and only the last few jobs are recalled", async () => {
    agent("quill");
    for (let i = 0; i < MEMORY.jobs + 2; i++) {
      const job = await hired({ from: "anonymous", to: "quill", task: `Job ${i} ${"a".repeat(400)}`, memory: true, memoryKey: KEY });
      finish(job.body.taskId, "b".repeat(900));
      getDb().prepare("UPDATE tasks SET completed_at = ? WHERE task_id = ?").run(new Date(Date.parse("2026-10-01T00:00:00Z") + i * 86_400_000).toISOString(), job.body.taskId);
    }
    const work = pastWork(owner, "quill");
    expect(work).toHaveLength(MEMORY.jobs);
    expect(work[0].asked.startsWith(`Job ${MEMORY.jobs + 1} `)).toBe(true);
    expect(work[0].when).toBe("2026-10-06");
    expect(work.every((j) => j.asked.length <= MEMORY.askChars && j.answered.length <= MEMORY.answerChars)).toBe(true);
  });
});

describe("the person's say over it", () => {
  it("they read it with their key, delete a line, or have the agent forget them; nobody else can", async () => {
    agent("quill");
    const owner = memoryOwnerFor({ key: KEY })!;
    const job = await hired({ from: "anonymous", to: "quill", task: "Write a line", memory: true, memoryKey: KEY });
    remember({ owner, agentId: "quill", text: "Wants every answer in Swedish.", taskId: job.body.taskId });
    remember({ owner, agentId: "quill", text: "Their shop is called Tarn.", taskId: job.body.taskId });
    finish(job.body.taskId, "En rad.");

    const mine = await readMemory("quill", { "x-memory-key": KEY });
    expect(mine.status).toBe(200);
    expect(mine.body.lines.map((l) => l.text)).toEqual(["Wants every answer in Swedish.", "Their shop is called Tarn."]);
    expect(mine.body).toMatchObject({ jobs: 1, most: MEMORY.lines });
    expect((await readMemory("quill", { "x-memory-key": OTHER })).body).toMatchObject({ lines: [], jobs: 0 });
    expect((await readMemory("quill", {})).status).toBe(401);
    expect((await readMemory("no-such-agent", { "x-memory-key": KEY })).status).toBe(404);
    // a wallet reads its own memory, which is not this one
    expect((await readMemory("quill", { authorization: `Bearer ${createApiKey(wallet(), {}).apiKey}` })).body.lines).toEqual([]);

    const drop = (lineId: string, key: string) => lineDelete(new NextRequest(`http://x/api/agents/quill/memory/${lineId}`, { method: "DELETE", headers: { "x-memory-key": key, "x-forwarded-for": "10.8.0.3" } }), { params: Promise.resolve({ agentId: "quill", lineId }) });
    expect((await drop(mine.body.lines[0].id, OTHER)).status).toBe(404);
    const dropped = await drop(mine.body.lines[0].id, KEY);
    expect(dropped.status).toBe(200);
    expect(((await dropped.json()) as View).lines.map((l) => l.text)).toEqual(["Their shop is called Tarn."]);

    const gone = await memoryForget(new NextRequest("http://x/api/agents/quill/memory", { method: "DELETE", headers: { "x-memory-key": KEY, "x-forwarded-for": "10.8.0.4" } }), { params: Promise.resolve({ agentId: "quill" }) });
    expect((await gone.json()) as View).toMatchObject({ forgotten: 1, lines: [], jobs: 0 });
    // forgotten means the earlier work is no longer recalled either; the job itself is untouched
    expect(memoryNote(owner, "quill")).toBe("");
    expect(pastWork(owner, "quill")).toEqual([]);
    expect(memoryView(owner, "quill")).toEqual({ lines: [], jobs: 0, most: MEMORY.lines });
    expect(forget(owner, "quill")).toBe(0);

    process.env.AGENT_MEMORY = "off";
    expect((await readMemory("quill", { "x-memory-key": KEY })).status).toBe(404);
  });
});

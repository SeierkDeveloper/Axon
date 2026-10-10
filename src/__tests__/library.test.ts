// Work with your agent, phase 9: your library, and starter jobs. Every conversation, file and version a person had
// done, listed back to them and nobody else, each with its receipt; and the jobs an agent is offered as one tap.
// No model is called here.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
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
import { completeTask, failTask, getTaskById, startTask } from "@/lib/tasks";
import { keepOutput, storeFile, filesOfTask, type StoreResult } from "@/lib/agentFiles";
import { markRevision } from "@/lib/revisions";
import { memoryOwnerFor, memoryOwnerOf } from "@/lib/agentMemory";
import { claimTokenValid } from "@/lib/mcpServer";
import { getPublicReceipt } from "@/lib/receipts";
import { conversationOf, conversationsOf, filesOf, libraryEnabled, libraryOwnerOf } from "@/lib/library";
import { startersEnabled, startersFor, STARTERS } from "@/lib/starterJobs";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as listLibrary } from "@/app/api/library/route";
import { GET as readThread, DELETE as removeThread } from "@/app/api/library/[thread]/route";

const KEY = "k".repeat(40), OTHER = "o".repeat(40);
const CSV = Buffer.from("Quarter,Revenue\nQ1,120\nQ2,180\n");
let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 3_300_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult | null) => { if (!r || !r.ok) throw new Error(`refused: ${r ? r.reason : "nothing kept"}`); return r; };

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
type Created = { taskId: string; claimToken?: string; error?: string };
const hired = async (body: unknown, headers: Record<string, string> = {}) => {
  const res = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.0.9", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Created };
};
const finish = (taskId: string, answer: string) => { startTask(taskId, "test"); completeTask(taskId, answer); };
const req = (url: string, headers: Record<string, string>, method = "GET") => new NextRequest(`http://x${url}`, { method, headers: { "x-forwarded-for": "10.9.0.9", ...headers } });
type Listed = { conversations?: { thread: string; asked: string; turns: number; files: number; agents: string[]; lastAgent: { id: string }; status: string; onSite: boolean }[]; files?: { name: string; version?: number; thread: string; receipt: string; token: string }[] };
const list = async (headers: Record<string, string>, query = "") => {
  const res = await listLibrary(req(`/api/library${query}`, headers));
  return { status: res.status, body: (await res.json()) as Listed };
};
type Read = { turns?: { taskId: string; claimToken: string; task: string; output: string | null; status: string; receipt: string; agent: { id: string }; outputFiles: { name: string; version?: number; sha256: string }[] }[] };
const read = async (thread: string, headers: Record<string, string>) => {
  const res = await readThread(req(`/api/library/${thread}`, headers), { params: Promise.resolve({ thread }) });
  return { status: res.status, body: (await res.json()) as Read };
};
const mine = { "x-memory-key": KEY };

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-library-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_LIBRARY: "on", AGENT_STARTERS: "on", AGENT_FOLLOWUP: "on", AGENT_BRINGIN: "on", AGENT_FILES: "on", AGENT_MEMORY: "on", AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM task_files; DELETE FROM agent_memories; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the switch", () => {
  it("is off unless it is on", () => {
    expect(libraryEnabled({})).toBe(false);
    expect(libraryEnabled({ AGENT_LIBRARY: "on" })).toBe(true);
    expect(startersEnabled({})).toBe(false);
    expect(startersEnabled({ AGENT_STARTERS: "on" })).toBe(true);
  });

  it("off, a hire is tied to nobody and the library is not there", async () => {
    agent("quill");
    process.env.AGENT_LIBRARY = "off";
    const job = await hired({ from: "anonymous", to: "quill", task: "Write a line", memoryKey: KEY });
    expect(job.status).toBe(201);
    expect(libraryOwnerOf(job.body.taskId)).toBeNull();
    expect((await list(mine)).status).toBe(404);
    expect((await read(job.body.taskId, mine)).status).toBe(404);
  });
});

describe("whose library a hire joins", () => {
  it("the browser's key, whether or not the agent's memory is used", async () => {
    agent("quill");
    const owner = memoryOwnerFor({ key: KEY });
    const withMemory = await hired({ from: "anonymous", to: "quill", task: "With memory", memory: true, memoryKey: KEY });
    const without = await hired({ from: "anonymous", to: "quill", task: "Without memory", memory: false, memoryKey: KEY });
    expect(libraryOwnerOf(withMemory.body.taskId)).toBe(owner);
    expect(libraryOwnerOf(without.body.taskId)).toBe(owner);
    // leaving memory out still leaves it out
    expect(memoryOwnerOf(without.body.taskId)).toBeNull();
    // only a hash of the key is kept, and never in the job's context or on its receipt
    expect(owner).not.toContain(KEY);
    expect(JSON.stringify(getTaskById(without.body.taskId)!.context ?? {})).not.toContain(KEY);
    expect(JSON.stringify(getPublicReceipt(without.body.taskId))).not.toContain(owner!.slice(2));
  });

  it("a hire with neither a key nor a wallet joins no library", async () => {
    agent("quill");
    const job = await hired({ from: "anonymous", to: "quill", task: "Nobody's" });
    expect(libraryOwnerOf(job.body.taskId)).toBeNull();
  });

  it("the wallet a hire was signed in with", async () => {
    agent("quill");
    const w = wallet(), { apiKey } = createApiKey(w, {});
    const job = await hired({ from: w.toLowerCase(), to: "quill", task: "Signed in" }, { authorization: `Bearer ${apiKey}` });
    expect(libraryOwnerOf(job.body.taskId)).toBe(`w:${w.toLowerCase()}`);
    const seen = await list({ authorization: `Bearer ${apiKey}` });
    expect(seen.body.conversations!.map((c) => c.asked)).toEqual(["Signed in"]);
    // hired through the API under a name of its own: it is read back, and carried on, through the API
    expect(seen.body.conversations![0].onSite).toBe(false);
  });

  it("a follow-up stays in the library of the job it follows, even sent without the key", async () => {
    agent("quill");
    const first = await hired({ from: "anonymous", to: "quill", task: "Write a line", memoryKey: KEY });
    finish(first.body.taskId, "A line.");
    const next = await hired({ from: "anonymous", to: "quill", task: "Shorter", followUpOf: first.body.taskId, followUpToken: first.body.claimToken });
    expect(next.status).toBe(201);
    expect(libraryOwnerOf(next.body.taskId)).toBe(memoryOwnerFor({ key: KEY }));
  });
});

describe("reading it back", () => {
  it("lists conversations the latest first, with their turns, agents and files", async () => {
    agent("Data Agent");
    agent("Design Agent");
    const a = await hired({ from: "anonymous", to: "Data Agent", task: "Chart   revenue\nby quarter", memoryKey: KEY });
    finish(a.body.taskId, "Here is the chart.");
    got(keepOutput({ taskId: a.body.taskId, bytes: CSV, name: "revenue.csv", wallet: null }));
    const a2 = await hired({ from: "anonymous", to: "Design Agent", task: "Restyle it", followUpOf: a.body.taskId, followUpToken: a.body.claimToken, memoryKey: KEY });
    getDb().prepare("UPDATE tasks SET created_at = ? WHERE task_id = ?").run("2026-10-10T10:00:05.000Z", a2.body.taskId);
    getDb().prepare("UPDATE tasks SET created_at = ?, completed_at = ? WHERE task_id = ?").run("2026-10-10T10:00:00.000Z", "2026-10-10T10:00:02.000Z", a.body.taskId);
    const b = await hired({ from: "anonymous", to: "Data Agent", task: "A later job", memoryKey: KEY });
    getDb().prepare("UPDATE tasks SET created_at = ? WHERE task_id = ?").run("2026-10-10T11:00:00.000Z", b.body.taskId);
    await hired({ from: "anonymous", to: "Data Agent", task: "A stranger's job", memoryKey: OTHER });

    const seen = (await list(mine)).body.conversations!;
    expect(seen.map((c) => c.asked)).toEqual(["A later job", "Chart revenue by quarter"]);
    const conv = seen[1];
    expect(conv).toMatchObject({ thread: a.body.taskId, turns: 2, files: 1, agents: ["Data Agent", "Design Agent"], lastAgent: { id: "Design Agent" }, status: "queued", onSite: true });
    // only what one agent worked on
    expect((await list(mine, "?agent=Design%20Agent")).body.conversations!.map((c) => c.thread)).toEqual([a.body.taskId]);
    expect((await list(mine, "?limit=1")).body.conversations!).toHaveLength(1);
  });

  it("a conversation in full: each turn with its answer, its files, its receipt, and the token that carries it on", async () => {
    agent("quill");
    const first = await hired({ from: "anonymous", to: "quill", task: "Write a line", memoryKey: KEY });
    finish(first.body.taskId, "A line.");
    got(keepOutput({ taskId: first.body.taskId, bytes: CSV, name: "notes.csv", wallet: null }));
    const next = await hired({ from: "anonymous", to: "quill", task: "Shorter", followUpOf: first.body.taskId, followUpToken: first.body.claimToken, memoryKey: KEY });
    getDb().prepare("UPDATE tasks SET created_at = ? WHERE task_id = ?").run(new Date(Date.now() + 5_000).toISOString(), next.body.taskId);

    const whole = await read(first.body.taskId, mine);
    expect(whole.status).toBe(200);
    expect(whole.body.turns!.map((t) => [t.task, t.status, t.output])).toEqual([["Write a line", "completed", "A line."], ["Shorter", "queued", null]]);
    expect(whole.body.turns![0].receipt).toBe(`/r/${first.body.taskId}`);
    expect(whole.body.turns![0].outputFiles.map((f) => f.name)).toEqual(["notes.csv"]);
    expect(claimTokenValid(first.body.taskId, whole.body.turns![0].claimToken)).toBe(true);
    // the token read back is the one a follow-up needs: the conversation goes on from the library
    finish(next.body.taskId, "Line.");
    const third = await hired({ from: "anonymous", to: "quill", task: "Once more", followUpOf: next.body.taskId, followUpToken: whole.body.turns![1].claimToken });
    expect(third.status).toBe(201);
    // any job of the conversation names it
    expect((await read(first.body.taskId, mine)).body.turns).toHaveLength(3);
  });

  it("is nobody else's: another key, no key and a bad API key are all turned away alike", async () => {
    agent("quill");
    const job = await hired({ from: "anonymous", to: "quill", task: "Private words", memoryKey: KEY });
    expect((await list({ "x-memory-key": OTHER })).body.conversations).toEqual([]);
    expect((await read(job.body.taskId, { "x-memory-key": OTHER })).status).toBe(404);
    expect((await read("no-such-job", mine)).status).toBe(404);
    expect((await list({})).status).toBe(401);
    expect((await list({ "x-memory-key": "short" })).status).toBe(401);
    expect((await list({ authorization: "Bearer not-a-key" })).status).toBe(401);
    // a stale API key in the browser does not lock the browser out of its own library
    expect((await list({ ...mine, authorization: "Bearer not-a-key" })).body.conversations).toHaveLength(1);
  });

  it("signed in on the browser it hired from, both parts read as one library", async () => {
    agent("quill");
    const w = wallet(), { apiKey } = createApiKey(w, {});
    await hired({ from: "anonymous", to: "quill", task: "From the page", memoryKey: KEY });
    await hired({ from: w.toLowerCase(), to: "quill", task: "From the API" }, { authorization: `Bearer ${apiKey}` });
    const both = (await list({ ...mine, authorization: `Bearer ${apiKey}` })).body.conversations!;
    expect(both.map((c) => c.asked).sort()).toEqual(["From the API", "From the page"]);
    expect(conversationsOf([`w:${w.toLowerCase()}`])).toHaveLength(1);
    expect(conversationsOf([])).toEqual([]);
  });
});

describe("files and versions", () => {
  it("lists every file handed back, and of a revised file the latest version only", async () => {
    agent("quill");
    const first = await hired({ from: "anonymous", to: "quill", task: "Make the table", memoryKey: KEY });
    finish(first.body.taskId, "Done.");
    got(keepOutput({ taskId: first.body.taskId, bytes: CSV, name: "table.csv", wallet: null }));
    got(keepOutput({ taskId: first.body.taskId, bytes: Buffer.from("other,file\n1,2\n"), name: "extra.csv", wallet: null }));
    const next = await hired({ from: "anonymous", to: "quill", task: "Add Q3", followUpOf: first.body.taskId, followUpToken: first.body.claimToken, memoryKey: KEY });
    expect(filesOfTask(next.body.taskId, "in").map((f) => f.name).sort()).toEqual(["extra.csv", "table.csv"]);
    finish(next.body.taskId, "Added.");
    const v2 = got(keepOutput({ taskId: next.body.taskId, bytes: Buffer.concat([CSV, Buffer.from("Q3,210\n")]), name: "table.csv", wallet: null }));
    expect(markRevision(next.body.taskId, v2.file.id)?.version).toBe(2);
    // a stranger's file, and a file uploaded but handed back by nobody, are not in it
    const theirs = await hired({ from: "anonymous", to: "quill", task: "Theirs", memoryKey: OTHER });
    got(keepOutput({ taskId: theirs.body.taskId, bytes: Buffer.from("theirs\n"), name: "theirs.csv", wallet: null }));
    got(storeFile({ bytes: Buffer.from("upload\n"), name: "upload.csv", wallet: null }));

    const files = (await list(mine, "?view=files")).body.files!;
    expect(files.map((f) => [f.name, f.version ?? 1]).sort()).toEqual([["extra.csv", 1], ["table.csv", 2]]);
    const table = files.find((f) => f.name === "table.csv")!;
    expect(table).toMatchObject({ thread: first.body.taskId, receipt: `/r/${next.body.taskId}` });
    expect(table.token).toBeTruthy();
    expect(filesOf([memoryOwnerFor({ key: OTHER })!]).map((f) => f.name)).toEqual(["theirs.csv"]);
    // the conversation still shows each turn's own file
    const whole = (await read(first.body.taskId, mine)).body.turns!;
    expect(whole[1].outputFiles.map((f) => [f.name, f.version])).toEqual([["table.csv", 2]]);
  });
});

describe("taking a conversation out", () => {
  it("unties the whole conversation from the person and leaves the jobs and receipts", async () => {
    agent("quill");
    const first = await hired({ from: "anonymous", to: "quill", task: "Write a line", memoryKey: KEY });
    finish(first.body.taskId, "A line.");
    const next = await hired({ from: "anonymous", to: "quill", task: "Shorter", followUpOf: first.body.taskId, followUpToken: first.body.claimToken, memoryKey: KEY });
    const keep = await hired({ from: "anonymous", to: "quill", task: "Another one", memoryKey: KEY });
    const gone = async (headers: Record<string, string>) => (await removeThread(req(`/api/library/${first.body.taskId}`, headers, "DELETE"), { params: Promise.resolve({ thread: first.body.taskId }) })).status;
    // somebody else cannot take it out
    expect(await gone({ "x-memory-key": OTHER })).toBe(404);
    expect(await gone(mine)).toBe(200);
    expect(await gone(mine)).toBe(404);
    expect((await list(mine)).body.conversations!.map((c) => c.thread)).toEqual([keep.body.taskId]);
    expect(libraryOwnerOf(next.body.taskId)).toBeNull();
    expect(getTaskById(first.body.taskId)!.output).toBe("A line.");
    expect(getPublicReceipt(first.body.taskId)).toBeTruthy();
    expect(conversationOf([memoryOwnerFor({ key: KEY })!], first.body.taskId)).toBeNull();
  });
});

describe("where a conversation stands", () => {
  it("says so when its latest turn did not finish", async () => {
    agent("quill");
    const job = await hired({ from: "anonymous", to: "quill", task: "This one fails", memoryKey: KEY });
    startTask(job.body.taskId, "test");
    failTask(job.body.taskId, "boom");
    expect((await list(mine)).body.conversations![0].status).toBe("failed");
  });
});

describe("starter jobs", () => {
  const ids = (caps: string[], can = {}) => startersFor({ capabilities: caps }, can).map((s) => s.id);

  it("offers an agent the jobs that fit what it lists", () => {
    expect(ids(["text translation", "localisation"])).toEqual(["translate"]);
    expect(ids(["SQL query writing", "schema design"])).toEqual(["sql-schema"]);
    expect(ids(["writing", "social", "creative"])).toEqual(["post", "tighten"]);
    expect(ids(["research", "analysis"])).toEqual(["explain", "compare"]);
  });

  it("offers a job on a file, a chart or a picture only where the agent can do it", () => {
    expect(ids(["contract review"])).not.toContain("contract-review");
    expect(ids(["contract review"], { files: true })).toContain("contract-review");
    expect(ids(["analysis"], { files: true })).not.toContain("chart");
    expect(ids(["analysis"], { files: true, code: true })[0]).toBe("chart");
    expect(ids(["analysis"], { files: true, code: true, office: true })).toContain("excel");
    expect(ids(["image generation"])).not.toContain("picture");
    expect(ids(["image generation"], { pictures: true })).toEqual(["picture"]);
  });

  it("never more than a few, always something, and nothing while off", () => {
    const all = startersFor({ capabilities: ["research", "analysis", "writing", "coding", "sql", "contract review", "translation"] }, { files: true, code: true, pictures: true, office: true });
    expect(all).toHaveLength(STARTERS.most);
    expect(ids(["quantum basket weaving"])).toEqual(["show"]);
    expect(startersFor({ capabilities: ["research"] }, {}, { AGENT_STARTERS: "off" })).toEqual([]);
  });

  it("a starter with a sample names a file that is really served", () => {
    const withSample = startersFor({ capabilities: ["analysis", "contract review"] }, { files: true, code: true });
    const samples = withSample.filter((s) => s.sample).map((s) => s.sample!);
    expect(samples.map((s) => s.name).sort()).toEqual(["sales.csv", "service-agreement.txt"]);
    for (const s of samples) expect(fs.existsSync(path.join(process.cwd(), "public", s.path))).toBe(true);
    // every starter is plain words a person could have typed: no em dash, nothing left to fill in
    for (const s of startersFor({ capabilities: ["research", "writing", "coding"] }, { files: true, code: true, office: true })) {
      expect(s.task).not.toMatch(/—|\[|TODO/);
      expect(s.label.length).toBeLessThanOrEqual(28);
    }
  });
});

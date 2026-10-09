// Files for agents, phase 2: a file goes on a hire, the job's commitment covers it, and the agent is handed it when
// it runs. No model is called here: the provider is replaced with one that records what it was given.
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
import {
  storeFile, checkTaskFiles, attachFiles, filesOfTask, attachmentsForTask, agentReads, pdfPages, getFile, sha256Of,
  CONTEXT_KEY, TASK_FILES, IMAGE_MAX_BYTES, INLINE_TEXT_CHARS, type StoreResult, type AttachCheck,
} from "@/lib/agentFiles";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as limits } from "@/app/api/files/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";
import { GET as agentProfile } from "@/app/api/agents/[agentId]/route";
import { GET as meta } from "@/app/api/files/[fileId]/route";
import { handleMcpMessage } from "@/lib/mcpServer";
import { firstTurn } from "@/lib/providers";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const pdf = (pages: number) => Buffer.from(`%PDF-1.7\n1 0 obj<</Type /Pages /Count ${pages}>>endobj\n${Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj<</Type /Page /Parent 1 0 R>>endobj`).join("\n")}\n%%EOF\n`);
const CSV = Buffer.from("Quarter,Revenue\nQ1,120\nQ2,180\n");

let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 8_800_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult) => { if (!r.ok) throw new Error(`refused (${r.refused}): ${r.reason}`); return r; };
const refusal = (r: AttachCheck) => (r.ok ? "ok" : r.refused);
const ALL = { text: true, pdf: true, image: true, why: null };

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return { ...a, wallet_address: a.walletAddress! };
}

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-files-hire-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FILES: "on", AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM task_files; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("which files an agent reads", () => {
  it("text reaches every agent; a PDF or a picture needs an agent Axon runs on Claude, or one on its own server", () => {
    expect(agentReads({ provider: "anthropic" })).toEqual(ALL);
    expect(agentReads({})).toEqual(ALL);
    // GPT and Grok look at pictures but are not given PDFs; a model Axon knows nothing about gets text only
    for (const provider of ["openai", "grok"]) expect(agentReads({ provider })).toMatchObject({ text: true, pdf: false, image: true });
    expect(agentReads({ provider: "ollama" })).toMatchObject({ text: true, pdf: false, image: false });
    // an agent that hires specialists reads what its own model reads, and hands the files on
    expect(agentReads({ provider: "anthropic", orchestrator: true })).toMatchObject({ text: true, pdf: true, image: true });
    expect(agentReads({ provider: "openai", orchestrator: true, endpoint: "https://x.example" })).toMatchObject({ text: true, pdf: false, image: true });
    expect(agentReads({ provider: "anthropic" }, { runsThroughMcp: true })).toMatchObject({ text: true, pdf: false, image: false });
    expect(agentReads({ provider: "grok", endpoint: "https://agent.example/run" })).toEqual(ALL);
  });

  it("counts a PDF's pages where they can be seen", () => {
    expect(pdfPages(pdf(1))).toBe(1);
    expect(pdfPages(pdf(12))).toBe(12);
    expect(pdfPages(Buffer.from("%PDF-1.7\nall in a compressed stream\n%%EOF"))).toBeNull();
  });
});

describe("whether files may go on a hire", () => {
  it("takes files the caller may read, by token or by wallet, and lists what they are", () => {
    const me = wallet();
    const mine = got(storeFile({ bytes: pdf(2), name: "contract.pdf", wallet: me }));
    const guest = got(storeFile({ bytes: CSV, name: "sales.csv" }));
    const r = checkTaskFiles({ files: [{ id: mine.file.id }, { id: guest.file.id, token: guest.token }], wallet: me, reads: ALL, paid: false });
    if (!r.ok) throw new Error(r.reason);
    expect(r.listed).toEqual([
      { name: "contract.pdf", type: "application/pdf", size: pdf(2).length, sha256: sha256Of(pdf(2)) },
      { name: "sales.csv", type: "text/csv", size: CSV.length, sha256: sha256Of(CSV) },
    ]);
    // nothing is attached by the check itself
    expect(filesOfTask("any")).toEqual([]);
    expect(getFile(mine.file.id)!.task_id).toBeNull();
  });

  it("refuses a file that is not the caller's, one that does not exist, and the same file twice", () => {
    const owner = wallet();
    const theirs = got(storeFile({ bytes: CSV, wallet: owner }));
    const guest = got(storeFile({ bytes: PNG }));
    expect(refusal(checkTaskFiles({ files: [{ id: theirs.file.id }], wallet: wallet(), reads: ALL, paid: false }))).toBe("not_found");
    expect(refusal(checkTaskFiles({ files: [{ id: theirs.file.id }], wallet: null, reads: ALL, paid: false }))).toBe("not_found");
    expect(refusal(checkTaskFiles({ files: [{ id: guest.file.id, token: "0".repeat(32) }], wallet: null, reads: ALL, paid: false }))).toBe("not_found");
    expect(refusal(checkTaskFiles({ files: [{ id: "f_" + "0".repeat(32) }], wallet: null, reads: ALL, paid: false }))).toBe("not_found");
    expect(refusal(checkTaskFiles({ files: [{ id: guest.file.id, token: guest.token }, { id: guest.file.id, token: guest.token }], wallet: null, reads: ALL, paid: false }))).toBe("not_found");
  });

  it("holds a hire to its limits: how many, how much, how long a PDF, how large a picture, and what the agent reads", () => {
    const up = (bytes: Buffer, name: string) => { const f = got(storeFile({ bytes, name })); return { id: f.file.id, token: f.token }; };
    const three = [up(Buffer.from("a"), "a.txt"), up(Buffer.from("b"), "b.txt"), up(Buffer.from("c"), "c.txt")];
    expect(refusal(checkTaskFiles({ files: three, wallet: null, reads: ALL, paid: false }))).toBe("too_many");
    expect(refusal(checkTaskFiles({ files: three, wallet: null, reads: ALL, paid: true }))).toBe("ok");
    const big = up(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(TASK_FILES.free.bytes, 0x20)]), "big.pdf");
    expect(refusal(checkTaskFiles({ files: [big], wallet: null, reads: ALL, paid: false }))).toBe("too_large");
    expect(refusal(checkTaskFiles({ files: [big], wallet: null, reads: ALL, paid: true }))).toBe("ok");
    const long = up(pdf(TASK_FILES.free.pdfPages + 1), "long.pdf");
    const r = checkTaskFiles({ files: [long], wallet: null, reads: ALL, paid: false });
    expect(refusal(r)).toBe("pages");
    expect(!r.ok && r.reason).toBe(`long.pdf has ${TASK_FILES.free.pdfPages + 1} pages. A free hire takes PDFs of up to ${TASK_FILES.free.pdfPages} pages.`);
    expect(refusal(checkTaskFiles({ files: [long], wallet: null, reads: ALL, paid: true }))).toBe("ok");
    // a heavy picture is not refused: it is scaled down when it is handed over
    const huge = up(Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES, 1)]), "huge.png");
    expect(refusal(checkTaskFiles({ files: [huge], wallet: null, reads: ALL, paid: true }))).toBe("ok");
    const textOnly = { text: true, pdf: false, image: false, why: "This agent cannot read PDFs or pictures. Text files work with every agent." };
    const p = checkTaskFiles({ files: [up(pdf(1), "one.pdf")], wallet: null, reads: textOnly, paid: false });
    expect(!p.ok && p.reason).toBe("one.pdf is a PDF. This agent cannot read PDFs or pictures. Text files work with every agent.");
    expect(refusal(checkTaskFiles({ files: [up(PNG, "x.png")], wallet: null, reads: textOnly, paid: false }))).toBe("kind");
    expect(refusal(checkTaskFiles({ files: [up(PNG, "y.png")], wallet: null, reads: agentReads({ provider: "grok" }), paid: false }))).toBe("ok");
    expect(refusal(checkTaskFiles({ files: [up(CSV, "x.csv")], wallet: null, reads: textOnly, paid: false }))).toBe("ok");
    process.env.AGENT_FILES = "off";
    expect(refusal(checkTaskFiles({ files: [up(CSV, "y.csv")], wallet: null, reads: ALL, paid: false }))).toBe("off");
  });

  it("a file goes on one hire only", () => {
    const f = got(storeFile({ bytes: CSV, name: "sales.csv" }));
    expect(attachFiles("task-a", [f.file.id])).toBe(1);
    expect(attachFiles("task-b", [f.file.id])).toBe(0);
    expect(filesOfTask("task-a").map((r) => r.id)).toEqual([f.file.id]);
    expect(filesOfTask("task-b")).toEqual([]);
    expect(refusal(checkTaskFiles({ files: [{ id: f.file.id, token: f.token }], wallet: null, reads: ALL, paid: false }))).toBe("taken");
  });
});

describe("what the agent is handed", () => {
  it("puts text into the message and gives PDFs and pictures as themselves", async () => {
    const a = got(storeFile({ bytes: CSV, name: "sales.csv" }, { now: 1000 }));
    const b = got(storeFile({ bytes: pdf(2), name: "contract.pdf" }, { now: 2000 }));
    const c = got(storeFile({ bytes: PNG, name: "chart.png" }, { now: 3000 }));
    attachFiles("t1", [a.file.id, b.file.id, c.file.id]);
    const h = await attachmentsForTask("t1");
    expect(h.text).toContain(`Attached file: sales.csv (text/csv, ${CSV.length} bytes)\n<<<\nQuarter,Revenue\nQ1,120\nQ2,180\n\n>>>`);
    expect(h.text).toContain("Attached file: contract.pdf (application/pdf");
    expect(h.text).toContain("Attached picture: chart.png (image/png) is given to you with this message.");
    expect(h.attachments).toEqual([
      { kind: "pdf", mime: "application/pdf", name: "contract.pdf", data: pdf(2).toString("base64") },
      { kind: "image", mime: "image/png", name: "chart.png", data: PNG.toString("base64") },
    ]);
    expect(await attachmentsForTask("no-such-task")).toEqual({ text: "", attachments: [], files: [] });
  });

  it("cuts very long text and says so, and names a file whose bytes are gone", async () => {
    const long = got(storeFile({ bytes: Buffer.from("x".repeat(INLINE_TEXT_CHARS + 500)), name: "long.txt" }, { now: 1000 }));
    const gone = got(storeFile({ bytes: Buffer.from("soon gone"), name: "gone.txt" }, { now: 2000 }));
    attachFiles("t2", [long.file.id, gone.file.id]);
    fs.rmSync(path.join(dir, gone.file.sha256.slice(0, 2)), { recursive: true, force: true });
    const h = await attachmentsForTask("t2");
    expect(h.text).toContain("[The file is longer: 500 more characters were left out.]");
    expect(h.text).toContain("[Attached file gone.txt could not be read: it is no longer stored.]");
    expect(h.text.length).toBeLessThan(INLINE_TEXT_CHARS + 600);
  });
});

describe("what the model receives", () => {
  it("is just the words when there are no files, and the files first, as themselves, when there are", () => {
    expect(firstTurn("Summarise this")).toBe("Summarise this");
    expect(firstTurn("Summarise this", [])).toBe("Summarise this");
    const turn = firstTurn("Summarise this", [
      { kind: "pdf", mime: "application/pdf", name: "contract.pdf", data: "UERG" },
      { kind: "image", mime: "image/png", name: "chart.png", data: "UE5H" },
    ]);
    expect(turn).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "UERG" }, title: "contract.pdf" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "UE5H" } },
      { type: "text", text: "Summarise this" },
    ]);
  });
});

describe("hiring with files", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.2.0.1", ...headers }, body: JSON.stringify(body) }));
  type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown>; specHash?: string };

  it("attaches the files, writes what they are into the job, and commits to them", async () => {
    agent("reader");
    const f = got(storeFile({ bytes: CSV, name: "sales.csv" }));
    const r = await post({ from: "anonymous", to: "reader", task: "Which quarter was best?", files: [{ id: f.file.id, token: f.token }] });
    expect(r.status).toBe(201);
    const t = (await r.json()) as Created;
    expect(t.context?.[CONTEXT_KEY]).toEqual([{ name: "sales.csv", type: "text/csv", size: CSV.length, sha256: sha256Of(CSV) }]);
    expect(filesOfTask(t.taskId).map((x) => x.id)).toEqual([f.file.id]);
    // the same words with a different file is a different job: the commitment changes with the file's hash
    const g = got(storeFile({ bytes: Buffer.from("Quarter,Revenue\nQ1,999\n"), name: "sales.csv" }));
    const other = (await (await post({ from: "anonymous", to: "reader", task: "Which quarter was best?", files: [{ id: g.file.id, token: g.token }] })).json()) as Created;
    expect(other.specHash).toBeTruthy();
    expect(other.specHash).not.toBe(t.specHash);
    // and it cannot be attached a second time
    const again = await post({ from: "anonymous", to: "reader", task: "Again", files: [{ id: f.file.id, token: f.token }] });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ details: { refused: "taken" } });
  });

  it("refuses the hire, and creates nothing, when a file is not allowed", async () => {
    agent("gpt-agent", { provider: "openai" });
    agent("reader");
    const picture = got(storeFile({ bytes: PNG, name: "chart.png" }));
    const doc = got(storeFile({ bytes: pdf(1), name: "brief.pdf" }));
    const bad = await post({ from: "anonymous", to: "gpt-agent", task: "Read this brief", files: [{ id: doc.file.id, token: doc.token }] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { refused: "kind" }, error: "brief.pdf is a PDF. This agent reads pictures and text files, but not PDFs." });
    const missing = await post({ from: "anonymous", to: "reader", task: "Read this", files: [{ id: picture.file.id, token: "0".repeat(32) }] });
    expect(missing.status).toBe(404);
    const reserved = await post({ from: "anonymous", to: "reader", task: "Read this", context: { [CONTEXT_KEY]: [{ name: "fake.pdf" }] } });
    expect(reserved.status).toBe(400);
    const tooMany = await post({ from: "anonymous", to: "reader", task: "x", files: Array.from({ length: 6 }, () => ({ id: picture.file.id })) });
    expect(tooMany.status).toBe(400);
    expect((getDb().prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n).toBe(0);
    expect(getFile(picture.file.id)!.task_id).toBeNull();
    // with the switch off a hire with files is refused, and one without files is what it always was
    process.env.AGENT_FILES = "off";
    expect((await post({ from: "anonymous", to: "reader", task: "Read this", files: [{ id: picture.file.id, token: picture.token }] })).status).toBe(400);
    expect((await post({ from: "anonymous", to: "reader", task: "No files here" })).status).toBe(201);
  });

  it("lets the owner of the hired agent read the hire's files, and nobody else", async () => {
    const a = agent("own-server", { endpoint: "https://agent.example/run", provider: "openai" });
    const { apiKey: ownerKey } = createApiKey(a.wallet_address, {});
    const { apiKey: strangerKey } = createApiKey(wallet(), {});
    const f = got(storeFile({ bytes: pdf(1), name: "brief.pdf" }));
    const read = (key: string) => meta(new NextRequest(`http://x/api/files/${f.file.id}`, { headers: { authorization: `Bearer ${key}`, "x-forwarded-for": "10.2.0.9" } }), { params: Promise.resolve({ fileId: f.file.id }) });
    // before it is on a hire to their agent, the owner has no way in
    expect((await read(ownerKey)).status).toBe(404);
    const r = await post({ from: "anonymous", to: "own-server", task: "Summarise the brief", files: [{ id: f.file.id, token: f.token }] });
    expect(r.status).toBe(201);
    expect((await read(ownerKey)).status).toBe(200);
    expect((await read(strangerKey)).status).toBe(404);
  });

  it("lists what the agent handed back on the job, with a token that downloads each file", async () => {
    agent("reader");
    const created = (await (await post({ from: "anonymous", to: "reader", task: "Draw the chart" })).json()) as Created;
    const read = async () => (await (await taskGet(new NextRequest(`http://x/api/tasks/${created.taskId}`, { headers: { "x-claim-token": created.claimToken! } }), { params: Promise.resolve({ taskId: created.taskId }) })).json()) as { outputFiles?: { id: string; name: string; type: string; token: string; sha256: string }[] };
    expect((await read()).outputFiles).toBeUndefined();
    const chart = got(storeFile({ bytes: PNG, name: "revenue.png", direction: "out", taskId: created.taskId }));
    const listed = (await read()).outputFiles!;
    expect(listed).toEqual([{ id: chart.file.id, name: "revenue.png", type: "image/png", kind: "image", size: PNG.length, sha256: sha256Of(PNG), token: chart.token, path: `/api/files/${chart.file.id}/content` }]);
    const dl = await meta(new NextRequest(`http://x/api/files/${listed[0].id}`, { headers: { "x-file-token": listed[0].token, "x-forwarded-for": "10.2.0.7" } }), { params: Promise.resolve({ fileId: listed[0].id }) });
    expect(dl.status).toBe(200);
    // a file handed back is not an input: it cannot be attached to another hire
    expect(refusal(checkTaskFiles({ files: [{ id: chart.file.id, token: chart.token }], wallet: null, reads: ALL, paid: false }))).toBe("not_found");
    process.env.AGENT_FILES = "off";
    expect((await read()).outputFiles).toBeUndefined();
  });

  it("says what can be handed over, and what one agent reads", async () => {
    agent("gpt-agent", { provider: "openai" });
    const all = (await (await limits(new NextRequest("http://x/api/files"))).json()) as { maxBytes: number; perHire: typeof TASK_FILES; reads?: unknown };
    expect(all.maxBytes).toBe(10 * 1024 * 1024);
    expect(all.perHire).toEqual(TASK_FILES);
    expect(all.reads).toBeUndefined();
    const one = (await (await limits(new NextRequest("http://x/api/files?agent=gpt-agent"))).json()) as { reads: { pdf: boolean; text: boolean } };
    expect(one.reads).toMatchObject({ text: true, pdf: false });
    expect((await limits(new NextRequest("http://x/api/files?agent=nobody"))).status).toBe(404);
    // the agent's own profile says it too, and says nothing about files while they are off
    const profile = async () => (await (await agentProfile(new NextRequest("http://x/api/agents/gpt-agent"), { params: Promise.resolve({ agentId: "gpt-agent" }) })).json()) as { reads?: unknown };
    expect((await profile()).reads).toEqual({ text: true, pdf: false, image: true });
    process.env.AGENT_FILES = "off";
    expect((await profile()).reads).toBeUndefined();
    expect((await limits(new NextRequest("http://x/api/files"))).status).toBe(404);
  });

  it("works from the tool layer: upload a file, then hire with it", async () => {
    agent("reader");
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "10.3.0.1");
      const text = (res as { result: { content: { text: string }[] } }).result.content[0].text;
      return JSON.parse(text) as Record<string, unknown>;
    };
    // the tool list shows the upload tool and files on a hire only while files are switched on
    const names = async () => ((await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "10.3.0.1")) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools;
    expect((await names()).map((t) => t.name)).toContain("upload_file");
    expect((await names()).find((t) => t.name === "hire_agent")!.inputSchema.properties.files).toBeTruthy();
    process.env.AGENT_FILES = "off";
    expect((await names()).map((t) => t.name)).not.toContain("upload_file");
    expect((await names()).find((t) => t.name === "hire_agent")!.inputSchema.properties.files).toBeUndefined();
    process.env.AGENT_FILES = "on";
    const up = await call("upload_file", { name: "sales.csv", text: CSV.toString("utf8") });
    expect(up).toMatchObject({ name: "sales.csv", type: "text/csv", size: CSV.length });
    const picture = await call("upload_file", { name: "chart.png", base64: PNG.toString("base64") });
    expect(picture.type).toBe("image/png");
    expect(await call("upload_file", { name: "x.bin", base64: Buffer.from("MZ\0\0").toString("base64") })).toMatchObject({ code: "NOT_SUPPORTED" });
    expect(await call("upload_file", { name: "empty" })).toMatchObject({ error: "send the file as text or as base64" });
    const hired = await call("hire_agent", { agentId: "reader", task: "Which quarter was best?", files: [{ id: up.id, token: up.token }] });
    expect(hired.taskId).toBeTruthy();
    expect(filesOfTask(String(hired.taskId)).map((r) => r.name)).toEqual(["sales.csv"]);
  });
});

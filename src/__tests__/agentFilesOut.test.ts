// Files for agents, phase 5: what an agent hands back. The files are part of what the job commits to, the receipt
// names them by hash and never by name, and an answer can be asked for as a file. No model and no chain here.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));
const memo = vi.hoisted(() => ({ posted: [] as string[], fail: false }));
vi.mock("@/lib/evm", async (orig) => ({
  ...(await orig<typeof import("@/lib/evm")>()),
  postMemoTransaction: async (m: string) => {
    if (memo.fail) throw new Error("node refused");
    memo.posted.push(m);
    return `0x${"ab".repeat(32)}`;
  },
}));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import {
  deleteFile, filesHash, receiptFiles, keepOutput, storeReport, reportName, sha256Of, filesOfTask,
  REPORT_KEY, type StoreResult,
} from "@/lib/agentFiles";
import { commitOutput, commitmentMemo, hashOutput, getOutputCommitment } from "@/lib/outputCommitment";
import { getPublicReceipt, getReceipt } from "@/lib/receipts";
import { POST as hire } from "@/app/api/tasks/route";
import { handleMcpMessage, claimTokenFor } from "@/lib/mcpServer";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const CSV = Buffer.from("Region,Net\nSouth,129034.10\n");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 9_900_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult | null) => { if (!r || !r.ok) throw new Error(`not kept: ${r ? r.refused : "already there"}`); return r; };

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
const post = (body: unknown) =>
  hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.5.0.1" }, body: JSON.stringify(body) }));
type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown>; specHash?: string };
const newJob = async (extra: Record<string, unknown> = {}) => {
  const r = await post({ from: "anonymous", to: "maker", task: "Net revenue per region, with a chart", ...extra });
  expect(r.status).toBe(201);
  return (await r.json()) as Created;
};
const finish = (taskId: string, output: string) =>
  getDb().prepare("UPDATE tasks SET status = 'completed', output = ?, completed_at = ? WHERE task_id = ?").run(output, new Date().toISOString(), taskId);

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-files-out-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FILES: "on", AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM task_files; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  memo.posted.length = 0;
  memo.fail = false;
  agent("maker", { name: "Deep Dive AI" });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("one hash for the files of a job", () => {
  it("is the SHA-256 of the file hashes, sorted, one a line, whatever order they came in", () => {
    const a = sha256Of(PNG), b = sha256Of(CSV);
    const expected = sha([a, b].sort().join("\n"));
    expect(filesHash([a, b])).toBe(expected);
    expect(filesHash([b, a])).toBe(expected);
    expect(filesHash([a.toUpperCase(), b])).toBe(expected);
    expect(filesHash([a])).toBe(sha(a));
    expect(filesHash([a])).not.toBe(expected);
    expect(filesHash([])).toBeNull();
  });

  it("goes into the memo only when there are files, so a job without files posts what it always did", () => {
    expect(commitmentMemo("t1", "aa", null)).toBe("axon:commitment:v1:t1:aa");
    expect(commitmentMemo("t1", "aa", "ff")).toBe("axon:commitment:v2:t1:aa:ff");
  });
});

describe("the commitment of a job", () => {
  it("is unchanged for a job that handed back nothing", async () => {
    const job = await newJob();
    finish(job.taskId, "South led.");
    await commitOutput(job.taskId, "South led.");
    expect(memo.posted).toEqual([`axon:commitment:v1:${job.taskId}:${hashOutput("South led.")}`]);
    expect(getOutputCommitment(job.taskId)).toEqual({ hash: hashOutput("South led."), signature: `0x${"ab".repeat(32)}`, explorerUrl: expect.stringContaining(`/tx/0x${"ab".repeat(32)}`) });
    // and its public receipt has none of the new fields
    const pub = getPublicReceipt(job.taskId)!;
    expect(pub).not.toHaveProperty("outputFiles");
    expect(pub).not.toHaveProperty("outputFilesHash");
    expect(pub).not.toHaveProperty("commitmentTx");
    expect(getReceipt(job.taskId)).not.toHaveProperty("outputFiles");
  });

  it("covers the files a job handed back, and the receipt names them by hash, never by name", async () => {
    const job = await newJob();
    got(keepOutput({ taskId: job.taskId, bytes: PNG, name: "acme-revenue-by-region.png", wallet: null }));
    got(keepOutput({ taskId: job.taskId, bytes: CSV, name: "acme-net.csv", wallet: null }));
    finish(job.taskId, "South led.");
    await commitOutput(job.taskId, "South led.");
    const root = filesHash([sha256Of(PNG), sha256Of(CSV)])!;
    expect(memo.posted).toEqual([`axon:commitment:v2:${job.taskId}:${hashOutput("South led.")}:${root}`]);
    expect(getOutputCommitment(job.taskId)?.filesHash).toBe(root);

    const pub = getPublicReceipt(job.taskId)!;
    expect(pub.outputFiles).toEqual([
      { type: "image/png", size: PNG.length, sha256: sha256Of(PNG), stored: true },
      { type: "text/csv", size: CSV.length, sha256: sha256Of(CSV), stored: true },
    ]);
    expect(pub.outputFilesHash).toBe(root);
    expect(pub.commitmentTx).toBe(`0x${"ab".repeat(32)}`);
    expect(JSON.stringify(pub)).not.toContain("acme");
    // the receipt read with a key does name them
    expect(getReceipt(job.taskId).outputFiles?.map((f) => f.name)).toEqual(["acme-revenue-by-region.png", "acme-net.csv"]);
  });

  it("keeps the hashes when the chain write fails, and when the bytes are later cleared", async () => {
    const job = await newJob();
    const chart = got(keepOutput({ taskId: job.taskId, bytes: PNG, name: "chart.png", wallet: null }));
    finish(job.taskId, "Done.");
    memo.fail = true;
    await commitOutput(job.taskId, "Done.");
    const pub = getPublicReceipt(job.taskId)!;
    expect(pub.outputHash).toBe(hashOutput("Done."));
    expect(pub.outputFilesHash).toBe(filesHash([sha256Of(PNG)]));
    expect(pub).not.toHaveProperty("commitmentTx");

    expect(deleteFile(chart.file.id)).toBe(true);
    expect(filesOfTask(job.taskId, "out")).toEqual([]);
    expect(receiptFiles(job.taskId)).toMatchObject([{ sha256: sha256Of(PNG), stored: false }]);
    expect(getPublicReceipt(job.taskId)!.outputFiles).toEqual([{ type: "image/png", size: PNG.length, sha256: sha256Of(PNG), stored: false }]);
  });

  it("does not list a file twice when a job runs twice", async () => {
    const job = await newJob();
    got(keepOutput({ taskId: job.taskId, bytes: PNG, name: "chart.png", wallet: null }));
    expect(keepOutput({ taskId: job.taskId, bytes: PNG, name: "chart-again.png", wallet: null })).toBeNull();
    expect(receiptFiles(job.taskId)).toHaveLength(1);
    // the same bytes on another job are that job's own file
    const other = await newJob();
    got(keepOutput({ taskId: other.taskId, bytes: PNG, name: "chart.png", wallet: null }));
    expect(receiptFiles(other.taskId)).toHaveLength(1);
  });
});

describe("the answer as a file", () => {
  it("is named after the agent and holds the answer, byte for byte", async () => {
    expect(reportName("Deep Dive AI")).toBe("deep-dive-ai-report.md");
    expect(reportName("  ***  ")).toBe("agent-report.md");
    const job = await newJob();
    const answer = "# Net revenue\n\nSouth led with 129,034.10.\n";
    const kept = got(storeReport({ taskId: job.taskId, output: answer, agentName: "Deep Dive AI", wallet: null }));
    expect(kept.file).toMatchObject({ name: "deep-dive-ai-report.md", kind: "text", direction: "out", sha256: sha(answer) });
    expect(storeReport({ taskId: job.taskId, output: answer, agentName: "Deep Dive AI", wallet: null })).toBeNull();
    expect(storeReport({ taskId: job.taskId, output: "   ", agentName: "Deep Dive AI", wallet: null })).toBeNull();
  });

  it("is asked for with reportFile, which the job's commitment covers; a caller cannot set the key themselves", async () => {
    const plain = await newJob();
    const asked = await newJob({ reportFile: true });
    expect(asked.context?.[REPORT_KEY]).toBe(true);
    expect(plain.context?.[REPORT_KEY]).toBeUndefined();
    expect(asked.specHash).not.toBe(plain.specHash);
    const sneaked = await post({ from: "anonymous", to: "maker", task: "x", context: { [REPORT_KEY]: true } });
    expect(sneaked.status).toBe(400);
    process.env.AGENT_FILES = "off";
    const off = await post({ from: "anonymous", to: "maker", task: "x", reportFile: true });
    expect(off.status).toBe(400);
    expect(String(((await off.json()) as { error: string }).error)).toMatch(/not switched on/);
  });
});

describe("the tool layer", () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, "10.5.0.2");
    return JSON.parse((res as { result: { content: { text: string }[] } }).result.content[0].text) as Record<string, unknown>;
  };
  const tools = async () => ((await handleMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, "10.5.0.2")) as { result: { tools: { name: string; description: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools;

  it("lists what the agent handed back on the result, each with a link that downloads it", async () => {
    const job = await newJob();
    const chart = got(keepOutput({ taskId: job.taskId, bytes: PNG, name: "chart.png", wallet: null }));
    const before = await call("get_task_result", { taskId: job.taskId, claimToken: claimTokenFor(job.taskId) });
    expect(before).not.toHaveProperty("files"); // not finished yet
    finish(job.taskId, "See the chart.");
    const done = await call("get_task_result", { taskId: job.taskId, claimToken: claimTokenFor(job.taskId) });
    expect(done.files).toEqual([{ name: "chart.png", type: "image/png", size: PNG.length, sha256: sha256Of(PNG), url: expect.stringMatching(new RegExp(`/api/files/${chart.file.id}/content\\?token=${chart.token}$`)) }]);
    expect(await call("get_task_result", { taskId: job.taskId, claimToken: "wrong" })).toMatchObject({ error: "invalid claim token for this task" });
    process.env.AGENT_FILES = "off";
    expect(await call("get_task_result", { taskId: job.taskId, claimToken: claimTokenFor(job.taskId) })).not.toHaveProperty("files");
  });

  it("offers the answer as a file on a hire only while files are on", async () => {
    const hireTool = async () => (await tools()).find((t) => t.name === "hire_agent")!;
    const resultTool = async () => (await tools()).find((t) => t.name === "get_task_result")!;
    expect((await hireTool()).inputSchema.properties.reportFile).toBeTruthy();
    expect((await resultTool()).description).toMatch(/listed under files/);
    const hired = await call("hire_agent", { agentId: "maker", task: "Write it up", reportFile: true });
    const row = getDb().prepare("SELECT context FROM tasks WHERE task_id = ?").get(String(hired.taskId)) as { context: string };
    expect(JSON.parse(row.context)[REPORT_KEY]).toBe(true);
    process.env.AGENT_FILES = "off";
    expect((await hireTool()).inputSchema.properties.reportFile).toBeUndefined();
    expect((await resultTool()).description).not.toMatch(/listed under files/);
  });
});

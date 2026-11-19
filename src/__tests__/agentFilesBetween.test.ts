// Files for agents, phase 7: files between agents. A file handed on is the same bytes under a new row; a hire that is
// handed files carries what any hire may carry; what a specialist makes is the hirer's too, and says who made it.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import {
  storeFile, deleteFile, readBytes, keepOutput, filesOfTask, fitForHire, listFiles, passFiles, adoptOutputs, madeBy, addedSince,
  fileTokenFor, outputFileFor, sha256Of, CONTEXT_KEY, REPORT_KEY, TASK_FILES, type FileRow, type StoreResult,
} from "@/lib/agentFiles";
import { createTask, getTaskById, getTasksByAgent, startTask, completeTask, type Task } from "@/lib/tasks";
import { runWithTraceId } from "@/lib/tracing";
import { runOrchestration } from "@/lib/orchestrator";
import { getSubcontractsForParent } from "@/lib/subcontracts";
import { createWorkflow, getWorkflow } from "@/lib/workflows";
import { getPublicReceipt } from "@/lib/receipts";
import { stepsOf } from "@/lib/liveLog";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as workflowGet } from "@/app/api/workflows/[workflowId]/route";
import { createApiKey } from "@/lib/identity";
import type { ThinkFn } from "@/lib/planner";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 9)]);
const CSV = Buffer.from("Region,Net\nSouth,129034.10\n");
const NOTES = Buffer.from("Checked against the ledger.\n");
const pdf = (pages: number) => Buffer.from(`%PDF-1.7\n1 0 obj<</Type /Pages /Count ${pages}>>endobj\n${Array.from({ length: pages }, (_, i) => `${i + 2} 0 obj<</Type /Page /Parent 1 0 R>>endobj`).join("\n")}\n%%EOF\n`);
const ALL = { text: true, pdf: true, image: true, why: null };
const TEXT_ONLY = { text: true, pdf: false, image: false, why: null };

let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 6_600_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult | null) => { if (!r || !r.ok) throw new Error(`not kept: ${r ? r.refused : "already there"}`); return r; };
const row = (id: string) => getDb().prepare("SELECT * FROM task_files WHERE id = ?").get(id) as FileRow;
const upload = (bytes: Buffer, name: string, w: string | null = null) => row(got(storeFile({ bytes, name, wallet: w })).file.id);

function agent(id: string, over: Partial<Agent> = {}): Agent {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 5, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
const job = (to: string, from = "buyer", over: Partial<Parameters<typeof createTask>[0]> = {}): Task =>
  createTask({ fromAgent: from, toAgent: to, task: "Net revenue per region, with a chart", initialStatus: "running", startedBy: "worker", ...over });

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-files-between-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FILES: "on", AGENT_LIVE_LOG: "on", AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM task_files; DELETE FROM task_progress; DELETE FROM task_subcontracts; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM workflows; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  agent("buyer");
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("what a hire can carry of the files it is handed", () => {
  it("takes them in the order given, the same content once, within the hire's count and size", () => {
    const a = upload(CSV, "a.csv"), b = upload(NOTES, "b.txt"), c = upload(PNG, "c.png"), again = upload(CSV, "a-copy.csv");
    const free = fitForHire([a, again, b, c], ALL, false);
    expect(free.rows.map((r) => r.name)).toEqual(["a.csv", "b.txt"]);
    expect(free.left).toEqual([{ name: "c.png", why: `a hire carries at most ${TASK_FILES.free.files} files` }]);
    expect(fitForHire([a, again, b, c], ALL, true).rows.map((r) => r.name)).toEqual(["a.csv", "b.txt", "c.png"]);
    expect(fitForHire([c, a, b], ALL, false).rows.map((r) => r.name)).toEqual(["c.png", "a.csv"]);
  });

  it("leaves behind what the agent does not read, what is too long, and what is gone, and says why", () => {
    const doc = upload(pdf(3), "deck.pdf"), long = upload(pdf(30), "long.pdf"), pic = upload(PNG, "chart.png"), csv = upload(CSV, "a.csv"), gone = upload(NOTES, "gone.txt");
    deleteFile(gone.id);
    const text = fitForHire([doc, pic, csv, row(gone.id)], TEXT_ONLY, true);
    expect(text.rows.map((r) => r.name)).toEqual(["a.csv"]);
    expect(text.left.map((l) => l.name)).toEqual(["deck.pdf", "chart.png", "gone.txt"]);
    expect(text.left[2].why).toBe("it is no longer stored");
    const free = fitForHire([long, doc], ALL, false);
    expect(free.rows.map((r) => r.name)).toEqual(["deck.pdf"]);
    expect(free.left[0]).toEqual({ name: "long.pdf", why: `it has 30 pages, and a hire takes up to ${TASK_FILES.free.pdfPages}` });
    const big = upload(Buffer.concat([Buffer.from("x,y\n"), Buffer.alloc(TASK_FILES.free.bytes, 0x61)]), "big.csv");
    expect(fitForHire([big, csv], ALL, false).rows.map((r) => r.name)).toEqual(["a.csv"]);
    expect(fitForHire([], ALL, false)).toEqual({ rows: [], left: [] });
  });
});

describe("handing a file on", () => {
  it("is a new row over the same bytes that remembers where the file was made, and is not an upload", () => {
    const owner = wallet();
    const first = job("buyer");
    const chart = row(got(keepOutput({ taskId: first.taskId, bytes: PNG, name: "chart.png", wallet: owner })).file.id);
    const second = job("buyer"), third = job("buyer");
    const [copy] = passFiles([chart], second.taskId, { wallet: owner });
    expect(copy).toMatchObject({ sha256: chart.sha256, name: "chart.png", direction: "in", task_id: second.taskId, source_task_id: first.taskId, owner_wallet: owner.toLowerCase() });
    expect(copy.id).not.toBe(chart.id);
    expect(readBytes(copy)?.equals(PNG)).toBe(true);
    // handed on again, it still names the job that made it
    const [again] = passFiles([copy], third.taskId);
    expect(again.source_task_id).toBe(first.taskId);
    // a copy does not count against the wallet's day of uploads
    expect(addedSince(owner, new Date(Date.now() - 60_000).toISOString())).toEqual({ files: 0, bytes: 0 });
    // the bytes stay for as long as any row holds them
    deleteFile(chart.id);
    expect(readBytes(copy)?.equals(PNG)).toBe(true);
    deleteFile(copy.id);
    deleteFile(again.id);
    expect(readBytes(again)).toBeNull();
    expect(passFiles([], second.taskId)).toEqual([]);
  });

  it("waits unattached for a hire that is about to be created, and that hire takes it like an upload", async () => {
    agent("reader");
    const before = job("buyer");
    const made = row(got(keepOutput({ taskId: before.taskId, bytes: CSV, name: "net.csv", wallet: null })).file.id);
    const [waiting] = passFiles([made], null);
    expect(waiting.task_id).toBeNull();
    const r = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.7.0.1" }, body: JSON.stringify({ from: "anonymous", to: "reader", task: "Check the totals", files: [{ id: waiting.id, token: fileTokenFor(waiting.id) }] }) }));
    expect(r.status).toBe(201);
    const t = (await r.json()) as { taskId: string; context?: Record<string, unknown> };
    expect(t.context?.[CONTEXT_KEY]).toEqual(listFiles([made]));
    expect(filesOfTask(t.taskId).map((f) => [f.id, f.source_task_id])).toEqual([[waiting.id, before.taskId]]);
  });

  it("makes what one job handed back part of what another hands back, once, and says who made it", () => {
    const maker = agent("chart-maker", { name: "Chart Maker" });
    const parent = job("buyer"), child = job(maker.agentId, "buyer");
    got(keepOutput({ taskId: child.taskId, bytes: PNG, name: "chart.png", wallet: null }));
    got(keepOutput({ taskId: child.taskId, bytes: CSV, name: "net.csv", wallet: null }));
    got(keepOutput({ taskId: parent.taskId, bytes: CSV, name: "mine.csv", wallet: null })); // the parent already has these bytes
    const added = adoptOutputs(parent.taskId, child.taskId);
    expect(added.map((f) => f.name)).toEqual(["chart.png"]);
    expect(adoptOutputs(parent.taskId, child.taskId)).toEqual([]);
    const out = filesOfTask(parent.taskId, "out");
    expect(out.map((f) => f.name).sort()).toEqual(["chart.png", "mine.csv"]);
    const chart = out.find((f) => f.name === "chart.png")!;
    expect(madeBy(chart)).toEqual({ agentId: maker.agentId, name: "Chart Maker", taskId: child.taskId });
    expect(madeBy(out.find((f) => f.name === "mine.csv")!)).toBeNull();
    expect(outputFileFor(chart).madeBy?.name).toBe("Chart Maker");
    // the public receipt says which agent made it, and still never the file's name
    getDb().prepare("UPDATE tasks SET status = 'completed', output = 'x', completed_at = ? WHERE task_id = ?").run(new Date().toISOString(), parent.taskId);
    const pub = getPublicReceipt(parent.taskId)!;
    expect(pub.outputFiles?.find((f) => f.sha256 === sha256Of(PNG))?.madeBy).toEqual({ agentId: maker.agentId, name: "Chart Maker", taskId: child.taskId });
    expect(JSON.stringify(pub)).not.toContain("chart.png");
  });
});

describe("an agent that hires specialists", () => {
  /** Stand-in for the specialists' own workers: finish their hires as they land, each handing back what it is told to. */
  function specialists(makes: Record<string, { name: string; bytes: Buffer }[]>) {
    let running = true;
    const seen: Record<string, { context: Record<string, unknown> | undefined; inputs: string[] }> = {};
    const loop = (async () => {
      while (running) {
        for (const id of Object.keys(makes)) {
          for (const j of getTasksByAgent({ agentId: id, role: "recipient" })) {
            if (j.status !== "queued") continue;
            startTask(j.taskId, "worker");
            seen[id] = { context: j.context, inputs: filesOfTask(j.taskId, "in").map((f) => f.name) };
            for (const f of makes[id]) keepOutput({ taskId: j.taskId, bytes: f.bytes, name: f.name, wallet: null });
            completeTask(j.taskId, `done by ${id}`);
          }
        }
        await new Promise((r) => setTimeout(r, 8));
      }
    })();
    return { seen, async stop() { running = false; await loop; } };
  }
  const isPlan = (prompt: string) => prompt.includes("Return ONLY a JSON array");

  it("hands the hirer's files to each specialist, hands on what they make, and gives all of it back with the answer", async () => {
    agent("analyst", { name: "Analyst", capabilities: ["between-analysis"] });
    agent("writer", { name: "Writer", capabilities: ["between-writing"] });
    const lead = agent("lead", { name: "Lead", capabilities: ["between-lead"], orchestrator: true });
    const data = upload(CSV, "orders.csv");
    const task = createTask({ fromAgent: "buyer", toAgent: lead.agentId, task: "Report on the orders", context: { [CONTEXT_KEY]: listFiles([data]), [REPORT_KEY]: true, audience: "the board" }, initialStatus: "running", startedBy: "orchestrator" });
    getDb().prepare("UPDATE task_files SET task_id = ? WHERE id = ?").run(task.taskId, data.id);

    const prompts: string[] = [];
    const think: ThinkFn = async (prompt) => {
      prompts.push(prompt);
      return isPlan(prompt) ? JSON.stringify([{ capability: "between-analysis", task: "work out the totals and draw a chart" }, { capability: "between-writing", task: "write the report" }]) : "# Orders\n\nSouth led.";
    };
    const team = specialists({ analyst: [{ name: "totals.png", bytes: PNG }], writer: [{ name: "appendix.txt", bytes: NOTES }] });
    await runWithTraceId(task.taskId, () => runOrchestration(lead, task, { think, pollMs: 8, perHireTimeoutMs: 3000 }));
    await team.stop();

    // the lead read the file itself: its text is in what it planned from
    expect(prompts[0]).toContain("South,129034.10");
    // each specialist was handed the hirer's file; the second also what the first made
    expect(team.seen.analyst.inputs).toEqual(["orders.csv"]);
    expect(team.seen.writer.inputs).toEqual(["orders.csv", "totals.png"]);
    // its context lists exactly what it was handed, keeps the hirer's own context, and is not asked for a report
    expect(team.seen.writer.context?.[CONTEXT_KEY]).toEqual([{ name: "orders.csv", type: "text/csv", size: CSV.length, sha256: sha256Of(CSV) }, { name: "totals.png", type: "image/png", size: PNG.length, sha256: sha256Of(PNG) }]);
    expect(team.seen.writer.context?.audience).toBe("the board");
    expect(team.seen.writer.context).not.toHaveProperty(REPORT_KEY);
    // the synthesis was told which files the team made
    expect(prompts.at(-1)).toContain("totals.png (by Analyst)");

    const done = getTaskById(task.taskId)!;
    expect(done.status).toBe("completed");
    const out = filesOfTask(task.taskId, "out");
    expect(out.map((f) => f.name).sort()).toEqual(["appendix.txt", "lead-report.md", "totals.png"]); // files saved in the same millisecond come back in either order
    const subs = getSubcontractsForParent(task.taskId);
    expect(subs.map((s) => s.toAgent)).toEqual(["analyst", "writer"]);
    expect(madeBy(out[0])).toEqual({ agentId: "analyst", name: "Analyst", taskId: subs[0].childTaskId });
    expect(madeBy(out[1])?.name).toBe("Writer");
    expect(madeBy(out[2])).toBeNull();
    // and the hirer could follow it as it happened
    expect(stepsOf(task.taskId).map((s) => s.text)).toEqual([
      "Picked up by Lead", "Reading orders.csv", "Split the job into 2 parts",
      "Hired Analyst: work out the totals and draw a chart", "Analyst delivered", "Analyst made totals.png",
      "Hired Writer: write the report", "Writer delivered", "Writer made appendix.txt",
      "Putting it together", "Saved the answer as lead-report.md",
    ]);
  });

  it("gives a specialist only the kinds it reads, and runs exactly as before while files are off", async () => {
    agent("gpt-reader", { name: "Reader", capabilities: ["between-reading"], provider: "openai" });
    const lead = agent("lead2", { name: "Lead", capabilities: ["between-lead2"], orchestrator: true });
    const doc = upload(pdf(2), "deck.pdf"), pic = upload(PNG2, "photo.png");
    const task = createTask({ fromAgent: "buyer", toAgent: lead.agentId, task: "Summarise", context: { [CONTEXT_KEY]: listFiles([doc, pic]) }, initialStatus: "running", startedBy: "orchestrator" });
    getDb().prepare("UPDATE task_files SET task_id = ? WHERE id IN (?, ?)").run(task.taskId, doc.id, pic.id);
    const think: ThinkFn = async (prompt) => (isPlan(prompt) ? JSON.stringify([{ capability: "between-reading", task: "read it" }]) : "Summary.");
    const team = specialists({ "gpt-reader": [] });
    await runWithTraceId(task.taskId, () => runOrchestration(lead, task, { think, pollMs: 8, perHireTimeoutMs: 3000 }));
    expect(team.seen["gpt-reader"].inputs).toEqual(["photo.png"]); // a GPT agent is not given a PDF

    process.env.AGENT_FILES = "off";
    const plain = createTask({ fromAgent: "buyer", toAgent: lead.agentId, task: "Summarise again", context: { note: "as before" }, initialStatus: "running", startedBy: "orchestrator" });
    await runWithTraceId(plain.taskId, () => runOrchestration(lead, plain, { think, pollMs: 8, perHireTimeoutMs: 3000 }));
    await team.stop();
    expect(team.seen["gpt-reader"].inputs).toEqual([]);
    expect(team.seen["gpt-reader"].context).toEqual({ note: "as before", priorResults: undefined });
    expect(getTaskById(plain.taskId)?.output).toBe("Summary.");
    expect(filesOfTask(plain.taskId, "out")).toEqual([]);
  });
});

describe("a pipeline", () => {
  it("starts with the files it is given, and each step is handed what the one before made", async () => {
    agent("p-one"); agent("p-two", { provider: "ollama" }); agent("p-three");
    const data = upload(CSV, "orders.csv");
    const wf = createWorkflow({ fromAgent: "buyer", agents: ["p-one", "p-two", "p-three"], task: "Analyse then write", files: [data] });
    const step = (i: number) => getWorkflow(wf.workflowId)!.steps[i];
    const first = getTaskById(step(0).taskId)!;
    expect(first.context?.[CONTEXT_KEY]).toEqual(listFiles([data]));
    expect(filesOfTask(first.taskId).map((f) => f.name)).toEqual(["orders.csv"]);

    startTask(first.taskId, "worker");
    got(keepOutput({ taskId: first.taskId, bytes: PNG, name: "chart.png", wallet: null }));
    got(keepOutput({ taskId: first.taskId, bytes: NOTES, name: "notes.txt", wallet: null }));
    completeTask(first.taskId, "step one done");
    // the second agent reads text only: it gets the notes and the data, not the picture
    const second = getTaskById(step(1).taskId)!;
    expect(filesOfTask(second.taskId).map((f) => f.name)).toEqual(["notes.txt", "orders.csv"]);
    expect((second.context?.[CONTEXT_KEY] as { name: string }[]).map((f) => f.name)).toEqual(["notes.txt", "orders.csv"]);

    startTask(second.taskId, "worker");
    completeTask(second.taskId, "step two done"); // made nothing itself
    const third = getTaskById(step(2).taskId)!;
    expect(filesOfTask(third.taskId).map((f) => [f.name, f.source_task_id])).toEqual([["notes.txt", first.taskId], ["orders.csv", null]]);

    // whoever may read the pipeline sees what each step was handed and can download what it made
    const owner = wallet();
    getDb().prepare("UPDATE agents SET wallet_address = ? WHERE agent_id = 'buyer'").run(owner.toLowerCase());
    const { apiKey } = createApiKey(owner.toLowerCase(), {});
    const read = async (key: string) => workflowGet(new NextRequest(`http://x/api/workflows/${wf.workflowId}`, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({ workflowId: wf.workflowId }) });
    const seen = (await (await read(apiKey)).json()) as { steps: { handedFiles?: { name: string }[]; outputFiles?: { name: string; token: string; path: string }[] }[] };
    expect(seen.steps[0].handedFiles?.map((f) => f.name)).toEqual(["orders.csv"]);
    expect(seen.steps[0].outputFiles?.map((f) => f.name)).toEqual(["chart.png", "notes.txt"]);
    expect(seen.steps[0].outputFiles?.[0].token).toBe(fileTokenFor(filesOfTask(first.taskId, "out")[0].id));
    expect(seen.steps[1].handedFiles?.map((f) => f.name)).toEqual(["notes.txt", "orders.csv"]);
    expect(seen.steps[1]).not.toHaveProperty("outputFiles");
    expect((await read(createApiKey(wallet(), {}).apiKey)).status).toBe(403);

    process.env.AGENT_FILES = "off";
    expect(((await (await read(apiKey)).json()) as { steps: object[] }).steps[0]).not.toHaveProperty("handedFiles");
    const plain = createWorkflow({ fromAgent: "buyer", agents: ["p-one", "p-three"], task: "No files" });
    const p0 = getTaskById(getWorkflow(plain.workflowId)!.steps[0].taskId)!;
    expect(p0.context).toBeUndefined();
    startTask(p0.taskId, "worker");
    completeTask(p0.taskId, "done");
    expect(getTaskById(getWorkflow(plain.workflowId)!.steps[1].taskId)!.context).toBeUndefined();
  });
});

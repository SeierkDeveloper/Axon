// Work with your agent, phase 2: revisions. A file handed back under the name of a file the job was given, with
// different content, is that file's next version. Every version is kept with the job that made it, and each knows
// the content it replaces and where the first version came from. No model is called here.
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
import { completeTask, startTask } from "@/lib/tasks";
import { storeFile, keepOutput, storeReport, filesOfTask, receiptFiles, outputFileFor, latestOnly, sha256Of, fileTokenFor, type FileRow, type StoreResult } from "@/lib/agentFiles";
import { markRevision, revisedFrom, sameDocument, stemOf, versionsOf } from "@/lib/revisions";
import { pictureTool } from "@/lib/agentPictures";
import { getPublicReceipt } from "@/lib/receipts";
import { POST as hire } from "@/app/api/tasks/route";
import { GET as taskGet } from "@/app/api/tasks/[taskId]/route";
import { GET as versionsGet } from "@/app/api/files/[fileId]/versions/route";

const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, fill)]);
const CSV = Buffer.from("Quarter,Revenue\nQ1,120\nQ2,180\n");

let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 7_700_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult | null) => { if (!r || !r.ok) throw new Error(`refused: ${r ? r.reason : "nothing kept"}`); return r; };
const row = (id: string) => getDb().prepare("SELECT * FROM task_files WHERE id = ?").get(id) as FileRow;

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}

type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown> };
const hired = async (body: unknown) => {
  const res = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.4.0.1" }, body: JSON.stringify(body) }));
  if (res.status !== 201) throw new Error(`hire refused ${res.status}: ${JSON.stringify(await res.json())}`);
  return (await res.json()) as Created;
};
const finish = (taskId: string, answer = "Done.") => { startTask(taskId, "test"); completeTask(taskId, answer); };
/** A job hands a file back, as the worker does it: kept, then looked at as a possible revision. */
const handBack = (taskId: string, bytes: Buffer, name: string) => {
  const kept = got(keepOutput({ taskId, bytes, name, wallet: null }));
  return { file: kept.file, rev: markRevision(taskId, kept.file.id) };
};
const followUp = (of: Created, task: string, files: { id: string; token: string }[] = []) =>
  hired({ from: "anonymous", task, followUpOf: of.taskId, followUpToken: of.claimToken, ...(files.length ? { files } : {}) });

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-revisions-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FOLLOWUP: "on", AGENT_FILES: "on", AGENT_PICTURES: "on", AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM task_files; DELETE FROM rate_limit_windows; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the same document under another name", () => {
  it("drops the extension and a version-like tail, and nothing else", () => {
    expect(stemOf("Chart_v2.PNG")).toBe("chart");
    expect(stemOf("report-final.md")).toBe("report");
    expect(stemOf("report (1).md")).toBe("report");
    expect(stemOf("plan_revised_v3.csv")).toBe("plan");
    // a number that is part of the name stays: these are two documents
    expect(stemOf("q1.csv")).toBe("q1");
    expect(sameDocument("q1.csv", "q2.csv")).toBe(false);
    expect(sameDocument("chart.png", "chart_v2.png")).toBe(true);
    expect(sameDocument("chart.png", "Chart-Updated.PNG")).toBe(true);
    // the same name as another kind of file is another document
    expect(sameDocument("chart.png", "chart.csv")).toBe(false);
    expect(sameDocument("final.md", "v2.md")).toBe(false);
  });
});

describe("a changed file is the next version", () => {
  it("version 2 of what the agent made, then version 3, each naming what it replaces and the first job", async () => {
    agent("chart-agent");
    const first = await hired({ from: "anonymous", to: "chart-agent", task: "Chart revenue" });
    const v1 = handBack(first.taskId, png(1), "chart.png");
    expect(v1.rev).toBeNull();
    finish(first.taskId);

    const second = await followUp(first, "Make the bars blue");
    const v2 = handBack(second.taskId, png(2), "chart.png");
    expect(v2.rev).toEqual({ version: 2, revises: sha256Of(png(1)), first: { sha256: sha256Of(png(1)), taskId: first.taskId } });
    finish(second.taskId);

    // the third turn is handed version 2 only, and what it hands back is version 3 of the same line
    const third = await followUp(second, "And a title");
    expect(filesOfTask(third.taskId).map((f) => [f.name, f.version ?? 1])).toEqual([["chart.png", 2]]);
    const v3 = handBack(third.taskId, png(3), "chart_v3.png");
    expect(v3.rev).toEqual({ version: 3, revises: sha256Of(png(2)), first: { sha256: sha256Of(png(1)), taskId: first.taskId } });

    // nothing was overwritten: each job still holds the version it made
    expect(filesOfTask(first.taskId, "out").map((f) => f.sha256)).toEqual([sha256Of(png(1))]);
    expect(filesOfTask(second.taskId, "out").map((f) => f.sha256)).toEqual([sha256Of(png(2))]);
    expect(row(v1.file.id).version ?? null).toBeNull();
  });

  it("the same content is no revision, and neither is a file under a name of its own", async () => {
    agent("chart-agent");
    const first = await hired({ from: "anonymous", to: "chart-agent", task: "Chart revenue" });
    handBack(first.taskId, png(1), "chart.png");
    finish(first.taskId);
    const second = await followUp(first, "Check it");
    expect(handBack(second.taskId, png(1), "chart.png").rev).toBeNull();
    expect(handBack(second.taskId, png(9), "logo.png").rev).toBeNull();
    expect(revisedFrom(second.taskId, { name: "chart.csv", sha256: "x", kind: "text" })).toBeNull();
  });

  it("a file the person uploaded can be revised too, in the very first job, and says no job made the first version", async () => {
    agent("edit-agent");
    const sheet = got(storeFile({ bytes: CSV, name: "revenue.csv" }));
    const first = await hired({ from: "anonymous", to: "edit-agent", task: "Add a Q3 row", files: [{ id: sheet.file.id, token: sheet.token }] });
    const edited = handBack(first.taskId, Buffer.from("Quarter,Revenue\nQ1,120\nQ2,180\nQ3,200\n"), "revenue.csv");
    expect(edited.rev).toEqual({ version: 2, revises: sha256Of(CSV), first: { sha256: sha256Of(CSV), taskId: null } });
  });

  it("the answer kept as a file is revised by the next answer kept as a file", async () => {
    agent("Deep Dive");
    const first = await hired({ from: "anonymous", to: "Deep Dive", task: "Write the report", reportFile: true });
    got(storeReport({ taskId: first.taskId, output: "# Report\n\nFirst draft.", agentName: "Deep Dive", wallet: null }));
    finish(first.taskId, "# Report\n\nFirst draft.");
    const second = await hired({ from: "anonymous", task: "Shorter", followUpOf: first.taskId, followUpToken: first.claimToken, reportFile: true });
    const kept = got(storeReport({ taskId: second.taskId, output: "# Report\n\nShort.", agentName: "Deep Dive", wallet: null }));
    expect(markRevision(second.taskId, kept.file.id)).toMatchObject({ version: 2, first: { taskId: first.taskId } });
  });

  it("a picture redone under the earlier picture's name is its next version", async () => {
    agent("art-agent");
    const first = await hired({ from: "anonymous", to: "art-agent", task: "Draw a poster" });
    const draw = vi.fn(async () => png(1));
    await pictureTool({ taskId: first.taskId, wallet: null, paid: false, draw }).run({ prompt: "A poster of a mountain at dawn", name: "launch-poster" });
    finish(first.taskId);
    const second = await followUp(first, "Make it night");
    let made: { id: string; name: string } | null = null;
    await pictureTool({ taskId: second.taskId, wallet: null, paid: false, draw: async () => png(2), onMade: (f) => { made = f; } }).run({ prompt: "A poster of a mountain at night", name: "launch-poster" });
    expect(made!.name).toBe("launch-poster.png");
    expect(markRevision(second.taskId, made!.id)).toMatchObject({ version: 2, revises: sha256Of(png(1)) });
  });

  it("writes nothing while follow-ups are off", async () => {
    agent("edit-agent");
    const sheet = got(storeFile({ bytes: CSV, name: "revenue.csv" }));
    const first = await hired({ from: "anonymous", to: "edit-agent", task: "Add a row", files: [{ id: sheet.file.id, token: sheet.token }] });
    process.env.AGENT_FOLLOWUP = "off";
    const edited = handBack(first.taskId, Buffer.from("Quarter,Revenue\nQ1,1\n"), "revenue.csv");
    expect(edited.rev).toBeNull();
    expect(row(edited.file.id).version ?? null).toBeNull();
  });
});

describe("what goes along to the next turn", () => {
  it("of a revised file only the latest version", () => {
    const f = (sha: string, version: number | null, first: string | null) => ({ id: `${sha}-${version}`, sha256: sha, version, first_sha256: first } as FileRow);
    const v1 = f("a", null, null), v2 = f("b", 2, "a"), v3 = f("c", 3, "a"), other = f("z", null, null);
    expect(latestOnly([v2, v1, other])).toEqual([v2, other]);
    expect(latestOnly([v1, other, v3, v2])).toEqual([other, v3]);
    expect(latestOnly([v1, other])).toEqual([v1, other]);
  });
});

describe("the versions of a file", () => {
  const conversation = async () => {
    agent("chart-agent");
    const first = await hired({ from: "anonymous", to: "chart-agent", task: "Chart revenue" });
    const v1 = handBack(first.taskId, png(1), "chart.png");
    finish(first.taskId);
    const second = await followUp(first, "Blue bars");
    const v2 = handBack(second.taskId, png(2), "chart.png");
    finish(second.taskId);
    const third = await followUp(second, "A title");
    const v3 = handBack(third.taskId, png(3), "chart.png");
    finish(third.taskId);
    return { first, second, third, v1, v2, v3 };
  };

  it("are listed oldest first, one a version, each with the job that made it and what downloads it", async () => {
    const c = await conversation();
    const list = versionsOf(row(c.v3.file.id));
    expect(list.map((v) => [v.version, v.sha256, v.taskId, v.current])).toEqual([
      [1, sha256Of(png(1)), c.first.taskId, false],
      [2, sha256Of(png(2)), c.second.taskId, false],
      [3, sha256Of(png(3)), c.third.taskId, true],
    ]);
    for (const v of list) {
      expect(v.token).toBe(fileTokenFor(v.id));
      expect(v.path).toBe(`/api/files/${v.id}/content`);
    }
    // asked from the first version, the line is the same
    expect(versionsOf(row(c.v1.file.id)).map((v) => v.version)).toEqual([1, 2, 3]);
    // a file that was never revised is the one version of itself
    const lone = got(storeFile({ bytes: CSV, name: "notes.csv" }));
    expect(versionsOf(row(lone.file.id)).map((v) => [v.version, v.current])).toEqual([[1, true]]);
  });

  it("are read with the file's token, and not without it", async () => {
    const c = await conversation();
    const id = c.v3.file.id;
    const ask = (headers: Record<string, string>) => versionsGet(new NextRequest(`http://x/api/files/${id}/versions`, { headers: { "x-forwarded-for": "10.4.0.2", ...headers } }), { params: Promise.resolve({ fileId: id }) });
    const ok = await ask({ "x-file-token": fileTokenFor(id) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { versions: { version: number }[] }).versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect((await ask({})).status).toBe(404);
    expect((await ask({ "x-file-token": fileTokenFor(c.v1.file.id) })).status).toBe(404);
  });

  it("show on the job, on its receipt and on the public receipt, and a first version shows nothing new", async () => {
    const c = await conversation();
    expect(outputFileFor(row(c.v2.file.id))).toMatchObject({ version: 2, revises: sha256Of(png(1)), first: { sha256: sha256Of(png(1)), taskId: c.first.taskId } });
    expect("version" in outputFileFor(row(c.v1.file.id))).toBe(false);
    expect(receiptFiles(c.third.taskId)[0]).toMatchObject({ version: 3, revises: sha256Of(png(2)) });

    const read = (await (await taskGet(new NextRequest(`http://x/api/tasks/${c.second.taskId}`, { headers: { "x-claim-token": c.second.claimToken! } }), { params: Promise.resolve({ taskId: c.second.taskId }) })).json()) as { outputFiles: { version?: number }[] };
    expect(read.outputFiles.map((f) => f.version)).toEqual([2]);

    const pub = getPublicReceipt(c.third.taskId)!;
    expect(pub.outputFiles).toEqual([{ type: "image/png", size: png(3).length, sha256: sha256Of(png(3)), stored: true, version: 3, revises: sha256Of(png(2)), first: { sha256: sha256Of(png(1)), taskId: c.first.taskId } }]);
    expect(getPublicReceipt(c.first.taskId)!.outputFiles).toEqual([{ type: "image/png", size: png(1).length, sha256: sha256Of(png(1)), stored: true }]);
  });
});

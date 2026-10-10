// Work with your agent, phase 7: bring in another agent. A follow-up may go to a different agent than the one that
// did the job: the specialist joins the conversation, is given what was said and the files, and is hired for its own
// turn. No model is called here.
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
import { completeTask, getTaskById, startTask } from "@/lib/tasks";
import { storeFile, keepOutput, filesOfTask, sha256Of, type StoreResult } from "@/lib/agentFiles";
import { bringInEnabled, checkFollowUp, conversationBefore, earlierTurns, FOLLOW_KEY } from "@/lib/followUp";
import { markRevision } from "@/lib/revisions";
import { memoryOwnerFor, memoryOwnerOf } from "@/lib/agentMemory";
import { getPublicReceipt } from "@/lib/receipts";
import { POST as hire } from "@/app/api/tasks/route";

const png = (fill: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, fill)]);
const CSV = Buffer.from("Quarter,Revenue\nQ1,120\nQ2,180\n");
let dir = "";
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 2_200_000).toString(16).padStart(40, "0")}`;
const got = (r: StoreResult | null) => { if (!r || !r.ok) throw new Error(`refused: ${r ? r.reason : "nothing kept"}`); return r; };

function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["analysis"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
type Created = { taskId: string; claimToken?: string; context?: Record<string, unknown>; toAgent?: string; parentTaskId?: string; threadId?: string; payment?: string; error?: string; details?: { refused?: string }; routing?: { agentId: string } };
const hired = async (body: unknown) => {
  const res = await hire(new NextRequest("http://x/api/tasks", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.0.1" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Created };
};
const finish = (taskId: string, answer: string) => { startTask(taskId, "test"); completeTask(taskId, answer); };

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "axon-bring-in-")); });
beforeEach(() => {
  Object.assign(process.env, { AGENT_FOLLOWUP: "on", AGENT_BRINGIN: "on", AGENT_FILES: "on", AGENT_MEMORY: "on", AXON_FILES_DIR: dir, TRUST_PROXY_HEADERS: "true" });
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
  it("is inside follow-ups: on only when both are", () => {
    expect(bringInEnabled({})).toBe(false);
    expect(bringInEnabled({ AGENT_BRINGIN: "on" })).toBe(false);
    expect(bringInEnabled({ AGENT_FOLLOWUP: "on" })).toBe(false);
    expect(bringInEnabled({ AGENT_FOLLOWUP: "on", AGENT_BRINGIN: "on" })).toBe(true);
  });

  it("off, a follow-up goes to the agent that did the job and nowhere else, as before", async () => {
    agent("Data Agent");
    agent("Design Agent");
    const first = await hired({ from: "anonymous", to: "Data Agent", task: "Chart revenue" });
    finish(first.body.taskId, "Here is the chart.");
    process.env.AGENT_BRINGIN = "off";
    const other = await hired({ from: "anonymous", to: "Design Agent", task: "Restyle it", followUpOf: first.body.taskId, followUpToken: first.body.claimToken });
    expect(other.status).toBe(400);
    expect(other.body.details?.refused).toBe("other_agent");
    // naming a capability does not send it elsewhere either: it stays with the agent that did the job
    const same = await hired({ from: "anonymous", capability: "analysis", task: "And the average?", followUpOf: first.body.taskId, followUpToken: first.body.claimToken });
    expect(same.status).toBe(201);
    expect(same.body.toAgent).toBe("Data Agent");
  });
});

describe("another agent joins the conversation", () => {
  const started = async () => {
    agent("Data Agent");
    agent("Design Agent", { capabilities: ["design"] });
    const sheet = got(storeFile({ bytes: CSV, name: "revenue.csv" }));
    const first = await hired({ from: "anonymous", to: "Data Agent", task: "Chart revenue by quarter", files: [{ id: sheet.file.id, token: sheet.token }], memory: true, memoryKey: "k".repeat(40) });
    got(keepOutput({ taskId: first.body.taskId, bytes: png(1), name: "chart.png", wallet: null }));
    finish(first.body.taskId, "Here is the chart, Q2 is highest.");
    return first.body;
  };

  it("it is hired for its own turn in the same conversation, named on the job, with the files", async () => {
    const first = await started();
    const second = await hired({ from: "anonymous", to: "Design Agent", task: "Make the chart look like our brand", followUpOf: first.taskId, followUpToken: first.claimToken });
    expect(second.status).toBe(201);
    expect(second.body.toAgent).toBe("Design Agent");
    expect(second.body.parentTaskId).toBe(first.taskId);
    expect(second.body.threadId).toBe(first.taskId);
    expect(second.body.context?.[FOLLOW_KEY]).toEqual({ of: first.taskId, thread: first.taskId, turn: 2, broughtIn: true, after: "Data Agent" });
    // what the first agent made and what it was given go along
    expect(filesOfTask(second.body.taskId).map((f) => f.name)).toEqual(["chart.png", "revenue.csv"]);
    // the memory is the same person's, kept by each agent for itself
    expect(memoryOwnerOf(second.body.taskId)).toBe(memoryOwnerFor({ key: "k".repeat(40) }));
    expect(getPublicReceipt(second.body.taskId)).toMatchObject({ followUpOf: first.taskId, turn: 2, toAgent: "Design Agent" });

    // it changes the first agent's chart: version 2, and the first version is still the first agent's job
    const made = got(keepOutput({ taskId: second.body.taskId, bytes: png(2), name: "chart.png", wallet: null }));
    expect(markRevision(second.body.taskId, made.file.id)).toEqual({ version: 2, revises: sha256Of(png(1)), first: { sha256: sha256Of(png(1)), taskId: first.taskId } });
  });

  it("each agent is told whose work it is: the one that joins, and the first one when the conversation comes back", async () => {
    const first = await started();
    const second = await hired({ from: "anonymous", to: "Design Agent", task: "Make the chart look like our brand", followUpOf: first.taskId, followUpToken: first.claimToken });
    const joining = conversationBefore(getTaskById(second.body.taskId)!);
    expect(joining.startsWith("You are being brought into a job that Data Agent started.")).toBe(true);
    expect(joining).toContain("[Turn 1] The person asked:\nChart revenue by quarter\n\nData Agent, another agent, answered:\nHere is the chart, Q2 is highest.");
    expect(joining).not.toContain("You answered");
    expect(joining.endsWith("The person now says:\n")).toBe(true);

    finish(second.body.taskId, "Restyled in your colours.");
    // back to the first agent, which is told what the other one did in between
    const third = await hired({ from: "anonymous", to: "Data Agent", task: "Now add Q3", followUpOf: second.body.taskId, followUpToken: second.body.claimToken });
    expect(third.status).toBe(201);
    expect((third.body.context?.[FOLLOW_KEY] as { after?: string; turn: number })).toMatchObject({ turn: 3, broughtIn: true, after: "Design Agent" });
    const back = conversationBefore(getTaskById(third.body.taskId)!);
    expect(back.startsWith("This is a follow-up in a conversation you have worked on together with Design Agent.")).toBe(true);
    expect(back).toContain("You answered:\nHere is the chart, Q2 is highest.");
    expect(back).toContain("Design Agent, another agent, answered:\nRestyled in your colours.");
    expect(earlierTurns(getTaskById(third.body.taskId)!).map((t) => t.toAgent)).toEqual(["Data Agent", "Design Agent"]);

    // staying with the agent that did the last turn is an ordinary follow-up
    finish(third.body.taskId, "Q3 added.");
    const fourth = await hired({ from: "anonymous", task: "Thanks, a title too", followUpOf: third.body.taskId, followUpToken: third.body.claimToken });
    expect(fourth.body.toAgent).toBe("Data Agent");
    expect((fourth.body.context?.[FOLLOW_KEY] as { broughtIn?: boolean }).broughtIn).toBeUndefined();
  });

  it("the specialist is paid its own price: a paid one needs its payment like any hire", async () => {
    const first = await started();
    agent("Pro Designer", { capabilities: ["design"], price: "0.01 ETH" });
    const unpaid = await hired({ from: "anonymous", to: "Pro Designer", task: "Restyle it", followUpOf: first.taskId, followUpToken: first.claimToken });
    expect(unpaid.status).toBe(402);
    expect(getDb().prepare("SELECT COUNT(*) c FROM tasks WHERE parent_task_id = ?").get(first.taskId)).toEqual({ c: 0 });
  });

  it("with a capability and no name, the network picks the specialist", async () => {
    const first = await started();
    const routed = await hired({ from: "anonymous", capability: "design", task: "Restyle the chart", followUpOf: first.taskId, followUpToken: first.claimToken });
    expect(routed.status).toBe(201);
    expect(routed.body.toAgent).toBe("Design Agent");
    expect(routed.body.routing?.agentId).toBe("Design Agent");
    expect((routed.body.context?.[FOLLOW_KEY] as { broughtIn?: boolean }).broughtIn).toBe(true);
    const nobody = await hired({ from: "anonymous", capability: "plumbing", task: "Fix the sink", followUpOf: first.taskId, followUpToken: first.claimToken });
    expect(nobody.status).toBe(404);
  });

  it("only the person's own finished job can be handed on, and not to an agent that would join blind", async () => {
    const first = await started();
    expect((await hired({ from: "anonymous", to: "Design Agent", task: "Restyle it", followUpOf: first.taskId })).status).toBe(404);
    expect((await hired({ from: "anonymous", to: "No Such Agent", task: "Restyle it", followUpOf: first.taskId, followUpToken: first.claimToken })).status).toBe(404);
    // an agent on its own server is sent a job's words only: it cannot be brought into a conversation
    agent("Remote Agent", { endpoint: "https://agent.example/run" });
    const remote = await hired({ from: "anonymous", to: "Remote Agent", task: "Restyle it", followUpOf: first.taskId, followUpToken: first.claimToken });
    expect(remote.status).toBe(400);
    expect(remote.body.details?.refused).toBe("own_server");
    expect(checkFollowUp({ parentId: first.taskId, from: "anonymous", to: "Design Agent", tokenOk: true })).toMatchObject({ ok: true, broughtIn: true });
    expect(checkFollowUp({ parentId: first.taskId, from: "anonymous", to: "Data Agent", tokenOk: true })).toMatchObject({ ok: true, broughtIn: false });
  });
});

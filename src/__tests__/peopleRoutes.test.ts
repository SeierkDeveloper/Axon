// Agents that hire people, over HTTP: posting, the public board, taking, handing in a photo, the check and the payout,
// the proof kept private, reports and moderation, and the record. The model and the chain are stand-ins.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));
const chain = vi.hoisted(() => ({ sent: [] as { to: string; amount: string }[] }));
vi.mock("@/lib/evm", async (orig) => ({
  ...(await orig<typeof import("@/lib/evm")>()),
  payoutWalletBalance: async () => 10n ** 18n,
  sendNative: async (to: string, amount: string | number, onSent?: (h: string) => void) => { chain.sent.push({ to, amount: String(amount) }); onSent?.("0xfeed"); return "0xfeed"; },
}));
const verdict = vi.hoisted(() => ({ rules: { ok: true } as unknown, proof: { verdict: "accept", failedCheck: null, reason: "Both lines are met", model: "claude-haiku-4-5", costUsd: 0.001 } as unknown }));
vi.mock("@/lib/peopleCheck", async (orig) => ({
  ...(await orig<typeof import("@/lib/peopleCheck")>()),
  realRulesJudge: () => async () => verdict.rules,
  realProofJudge: () => async () => verdict.proof,
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { GET as board, POST as post } from "@/app/api/people/route";
import { GET as one, PATCH as act } from "@/app/api/people/[taskId]/route";
import { POST as deliver } from "@/app/api/people/[taskId]/deliver/route";
import { GET as proof } from "@/app/api/people/[taskId]/proof/route";
import { POST as report } from "@/app/api/people/[taskId]/report/route";
import { GET as record } from "@/app/api/people/record/route";
import { GET as business } from "@/app/api/business/route";

const saved = { people: process.env.AGENT_PEOPLE, biz: process.env.AGENT_BUSINESS, mod: process.env.MODERATION_SECRET };
beforeAll(() => { process.env.AXON_FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "axon-people-routes-")); });
beforeEach(() => {
  process.env.AGENT_PEOPLE = "on";
  process.env.MODERATION_SECRET = "mod-secret";
  chain.sent.length = 0;
  verdict.rules = { ok: true };
  getDb().exec("DELETE FROM people_tasks; DELETE FROM people_deliveries; DELETE FROM people_payouts; DELETE FROM people_events; DELETE FROM people_reports; DELETE FROM people_blocks; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_PEOPLE", saved.people], ["AGENT_BUSINESS", saved.biz], ["MODERATION_SECRET", saved.mod]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
function person() {
  const w = `0x${(++n + 9_700_000).toString(16).padStart(40, "0")}`;
  return { w, apiKey: createApiKey(w).apiKey };
}
function owner() {
  const p = person();
  const id = `prt-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Field Scout", capabilities: ["research"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: p.w, price: "0.0005 ETH", createdAt: new Date().toISOString() });
  getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at) VALUES (?, ?, 'someone', ?, 0.001, 'completed', NULL, 0, 'ETH', ?, ?)")
    .run(randomUUID(), randomUUID(), id, new Date().toISOString(), new Date().toISOString());
  return { ...p, agentId: id };
}
const req = (url: string, o: { key?: string; method?: string; body?: unknown; form?: FormData } = {}) => {
  if (o.form) {
    const r = new Request(`http://localhost${url}`, { method: "POST", body: o.form });
    return r.arrayBuffer().then((buf) => new NextRequest(`http://localhost${url}`, { method: "POST", headers: { "content-type": r.headers.get("content-type")!, "content-length": String(buf.byteLength), ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) }, body: buf }));
  }
  return Promise.resolve(new NextRequest(`http://localhost${url}`, { method: o.method ?? "GET", headers: { "content-type": "application/json", ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }));
};
const ctx = (taskId: string) => ({ params: Promise.resolve({ taskId }) });
const TASK = { title: "Photograph the menu at Cafe Lumen", details: "Go to Cafe Lumen on Harbour Street and photograph the menu board by the counter.", place: "Harbour Street", proof: "photo", checks: ["The whole menu board can be read", "Today's prices are on it"], priceEth: "0.00001", takeHours: 2 };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 9)]);
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error("never happened"); };

describe("/api/people", () => {
  it("is not there while tasks for people are off", async () => {
    process.env.AGENT_PEOPLE = "off";
    const o = owner();
    expect((await board(await req("/api/people"))).status).toBe(404);
    expect((await post(await req("/api/people", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...TASK } }))).status).toBe(404);
  });

  it("runs a task from post to payout, keeping the owner and the proof private", async () => {
    const o = owner(), worker = person(), stranger = person();
    expect((await post(await req("/api/people", { method: "POST", body: { agentId: o.agentId, ...TASK } }))).status).toBe(401);
    expect((await post(await req("/api/people", { key: stranger.apiKey, method: "POST", body: { agentId: o.agentId, ...TASK } }))).status).toBe(403);
    verdict.rules = { ok: false, rule: "Nobody put at risk", why: "No" };
    expect((await post(await req("/api/people", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...TASK } }))).status).toBe(422);
    verdict.rules = { ok: true };
    const made = await post(await req("/api/people", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...TASK } }));
    expect(made.status).toBe(201);
    const { task } = (await made.json()) as { task: { taskId: string; status: string } };
    expect(task.status).toBe("open");

    // the board, to a visitor: the task, never its owner
    const seen = await (await board(await req("/api/people"))).json();
    expect(seen.tasks.map((t: { taskId: string }) => t.taskId)).toContain(task.taskId);
    expect(JSON.stringify(seen)).not.toContain(o.w.slice(2));
    expect(seen.me).toBeUndefined();

    expect((await act(await req(`/api/people/${task.taskId}`, { key: worker.apiKey, method: "PATCH", body: { action: "take" } }), ctx(task.taskId))).status).toBe(200);
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "menu.png");
    form.set("answer", "Menu by the counter");
    expect((await deliver(await req(`/api/people/${task.taskId}/deliver`, { key: stranger.apiKey, form }), ctx(task.taskId))).status).toBe(404);
    const handed = await deliver(await req(`/api/people/${task.taskId}/deliver`, { key: worker.apiKey, form }), ctx(task.taskId));
    expect(handed.status).toBe(201);

    // the check accepts and the person is paid, from Axon's wallet to theirs
    await until(async () => (await (await one(await req(`/api/people/${task.taskId}`, { key: worker.apiKey }), ctx(task.taskId))).json()).task.status === "paid");
    expect(chain.sent).toEqual([{ to: worker.w, amount: "0.00001" }]);
    const mine = (await (await one(await req(`/api/people/${task.taskId}`, { key: worker.apiKey }), ctx(task.taskId))).json()).task;
    expect(mine).toMatchObject({ yours: true, payout: { status: "sent", txHash: "0xfeed" } });

    // the proof: the owner and the person, nobody else
    const ownerView = (await (await one(await req(`/api/people/${task.taskId}`, { key: o.apiKey }), ctx(task.taskId))).json()).task;
    const url: string = ownerView.deliveries[0].file.url;
    const q = url.slice(url.indexOf("?"));
    expect((await proof(await req(`/api/people/${task.taskId}/proof${q}`, { key: o.apiKey }), ctx(task.taskId))).status).toBe(200);
    expect((await proof(await req(`/api/people/${task.taskId}/proof${q}`, { key: worker.apiKey }), ctx(task.taskId))).status).toBe(200);
    expect((await proof(await req(`/api/people/${task.taskId}/proof${q}`, { key: stranger.apiKey }), ctx(task.taskId))).status).toBe(404);
    expect((await proof(await req(`/api/people/${task.taskId}/proof${q}`), ctx(task.taskId))).status).toBe(401);

    // the public record
    const rec = await (await record(await req(`/api/people/record?wallet=${worker.w}`))).json();
    expect(rec.record).toMatchObject({ done: 1, earned: "0.00001 ETH", mayHold: 1 });
    const top = await (await record(await req("/api/people/record"))).json();
    expect(top.people[0]).toMatchObject({ done: 1 });
  });

  it("takes reports from anyone, and lets only a moderator take a task down or back", async () => {
    const o = owner();
    const { task } = await (await post(await req("/api/people", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...TASK } }))).json();
    expect((await report(await req(`/api/people/${task.taskId}/report`, { method: "POST", body: { reason: "nonsense" } }), ctx(task.taskId))).status).toBe(400);
    expect((await report(await req(`/api/people/${task.taskId}/report`, { method: "POST", body: { reason: "unsafe" } }), ctx(task.taskId))).status).toBe(201);
    expect((await report(await req(`/api/people/${task.taskId}/report`, { method: "POST", body: { reason: "unsafe" } }), ctx(task.taskId))).status).toBe(409);
    expect((await act(await req(`/api/people/${task.taskId}`, { key: person().apiKey, method: "PATCH", body: { action: "hide" } }), ctx(task.taskId))).status).toBe(400);
    const hidden = await act(await req(`/api/people/${task.taskId}`, { key: "mod-secret", method: "PATCH", body: { action: "hide", reason: "Unsafe" } }), ctx(task.taskId));
    expect(hidden.status).toBe(200);
    expect((await one(await req(`/api/people/${task.taskId}`), ctx(task.taskId))).status).toBe(404);
  });

  it("lists hiring people as something a business may spend on only while it is on", async () => {
    process.env.AGENT_BUSINESS = "on";
    const o = owner();
    const kinds = async () => ((await (await business(await req("/api/business", { key: o.apiKey }))).json()).rules.spendKinds as { kind: string }[]).map((k) => k.kind);
    expect(await kinds()).toContain("people");
    process.env.AGENT_PEOPLE = "off";
    expect(await kinds()).toEqual(["hire", "material", "model"]);
  });
});

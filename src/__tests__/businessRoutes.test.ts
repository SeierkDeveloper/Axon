// Agents that run their own business, over HTTP: starting one, reading it, pausing and stopping it, and what anybody may
// read about it. The routes answer nothing while AGENT_BUSINESS is off.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { GET as list, POST as start } from "@/app/api/business/route";
import { GET as one, PATCH as change } from "@/app/api/business/[businessId]/route";
import { GET as approvals } from "@/app/api/apps/approvals/route";

const saved = { biz: process.env.AGENT_BUSINESS, apps: process.env.AGENT_APPS };
beforeEach(() => {
  process.env.AGENT_BUSINESS = "on";
  delete process.env.AGENT_APPS;
  getDb().exec("DELETE FROM businesses; DELETE FROM business_ledger; DELETE FROM business_decisions;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_BUSINESS", saved.biz], ["AGENT_APPS", saved.apps]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
function owner() {
  const w = `0x${(++n + 8_700_000).toString(16).padStart(40, "0")}`;
  const { apiKey } = createApiKey(w);
  const id = `rt-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Logo Smith", capabilities: ["logo"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: w, price: "0.0005 ETH", createdAt: new Date().toISOString() });
  return { w, apiKey, agentId: id };
}
const req = (url: string, o: { key?: string; method?: string; body?: unknown } = {}) =>
  new NextRequest(`http://localhost${url}`, { method: o.method ?? "GET", headers: { "content-type": "application/json", ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
const ctx = (businessId: string) => ({ params: Promise.resolve({ businessId }) });
const PLAN = { goal: "Run a small logo studio for new shops", budgetEth: "0.01", maxPerDayEth: "0.004", maxPerJobEth: "0.002", approveAboveEth: "0.001", spendOn: ["hire"], priceMinEth: "0.0002", priceMaxEth: "0.002" };

describe("/api/business", () => {
  it("is not there while businesses are off", async () => {
    process.env.AGENT_BUSINESS = "off";
    const o = owner();
    expect((await list(req("/api/business", { key: o.apiKey }))).status).toBe(404);
    expect((await start(req("/api/business", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...PLAN } }))).status).toBe(404);
  });

  it("starts, reads, pauses and stops a business for its owner only", async () => {
    const o = owner(), other = owner();
    expect((await start(req("/api/business", { method: "POST", body: { agentId: o.agentId, ...PLAN } }))).status).toBe(401);
    expect((await start(req("/api/business", { key: other.apiKey, method: "POST", body: { agentId: o.agentId, ...PLAN } }))).status).toBe(403);
    const bad = await start(req("/api/business", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...PLAN, maxPerJobEth: "1" } }));
    expect(bad.status).toBe(400);
    const r = await start(req("/api/business", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...PLAN } }));
    expect(r.status).toBe(201);
    const { business } = (await r.json()) as { business: { businessId: string; status: string; limits: { budget: string } } };
    expect(business).toMatchObject({ status: "active", limits: { budget: "0.01 ETH" } });
    expect((await start(req("/api/business", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...PLAN } }))).status).toBe(409);

    const mine = (await (await list(req("/api/business", { key: o.apiKey }))).json()) as { businesses: unknown[]; agents: { agentId: string; busy: boolean }[]; rules: { spendKinds: unknown[] } };
    expect(mine.businesses).toHaveLength(1);
    expect(mine.agents).toEqual([expect.objectContaining({ agentId: o.agentId, busy: true })]);
    expect(mine.rules.spendKinds).toHaveLength(3);

    expect((await one(req(`/api/business/${business.businessId}`, { key: other.apiKey }), ctx(business.businessId))).status).toBe(404);
    expect((await one(req(`/api/business/${business.businessId}`, { key: o.apiKey }), ctx(business.businessId))).status).toBe(200);
    const paused = await change(req(`/api/business/${business.businessId}`, { key: o.apiKey, method: "PATCH", body: { action: "pause" } }), ctx(business.businessId));
    expect(((await paused.json()) as { business: { status: string } }).business.status).toBe("paused");
    expect((await change(req(`/api/business/${business.businessId}`, { key: other.apiKey, method: "PATCH", body: { action: "stop" } }), ctx(business.businessId))).status).toBe(404);
    const stopped = await change(req(`/api/business/${business.businessId}`, { key: o.apiKey, method: "PATCH", body: { action: "stop" } }), ctx(business.businessId));
    expect(((await stopped.json()) as { business: { status: string } }).business.status).toBe("stopped");
    expect((await change(req(`/api/business/${business.businessId}`, { key: o.apiKey, method: "PATCH", body: { action: "dance" } }), ctx(business.businessId))).status).toBe(400);
  });

  it("shows anybody only what is safe", async () => {
    const o = owner();
    await start(req("/api/business", { key: o.apiKey, method: "POST", body: { agentId: o.agentId, ...PLAN } }));
    const body = (await (await list(req(`/api/business?agent=${o.agentId}`))).json()) as { business: Record<string, unknown> };
    expect(Object.keys(body.business).sort()).toEqual(["goal", "jobsDone", "productsSold", "recentJobs", "since", "status"]);
    expect(JSON.stringify(body)).not.toMatch(/ETH|budget|limit/i);
  });

  it("opens the approvals inbox while businesses are on, even with apps off", async () => {
    const o = owner();
    expect((await approvals(req("/api/apps/approvals", { key: o.apiKey }))).status).toBe(200);
    process.env.AGENT_BUSINESS = "off";
    expect((await approvals(req("/api/apps/approvals", { key: o.apiKey }))).status).toBe(404);
  });
});

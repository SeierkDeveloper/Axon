// The retainer methods, against a stubbed network: what the SDK sends and how it unwraps replies.
// The server side is covered by the app's own retainer suites.

import { describe, it, expect, vi, afterEach } from "vitest";
import { AxonClient } from "../src/client";

interface Call { method: string; path: string; search: string; body: unknown }

function stub(responses: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ method, path: u.pathname, search: u.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const body = responses[`${method} ${u.pathname}`];
    return new Response(JSON.stringify(body ?? { error: "unexpected", code: "NOT_FOUND" }), { status: body ? 200 : 404 });
  }));
  return calls;
}

afterEach(() => vi.unstubAllGlobals());
const client = () => new AxonClient({ endpoint: "https://axon.test", apiKey: "axon_test" });
const r = { retainerId: "ret_1", status: "active" };

describe("retainers", () => {
  it("createRetainer posts the schedule as given and unwraps the retainer", async () => {
    const calls = stub({ "POST /api/retainers": { retainer: r } });
    const out = await client().createRetainer({
      agentId: "crypto-agent",
      instructions: "Morning brief.",
      schedule: { kind: "daily", time: "08:00", timeZone: "Europe/Oslo" },
      maxPrice: "0.0002",
    });
    expect(out).toEqual(r);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/retainers",
      body: { agentId: "crypto-agent", instructions: "Morning brief.", schedule: { kind: "daily", time: "08:00", timeZone: "Europe/Oslo" }, maxPrice: "0.0002" },
    });
  });

  it("list, get, update, pause, resume and cancel hit the right routes", async () => {
    const calls = stub({
      "GET /api/retainers": { retainers: [r] },
      "GET /api/retainers/ret_1": { retainer: r },
      "PATCH /api/retainers/ret_1": { retainer: r },
      "POST /api/retainers/ret_1/pause": { retainer: r },
      "POST /api/retainers/ret_1/resume": { retainer: r },
      "DELETE /api/retainers/ret_1": { retainer: r },
    });
    const c = client();
    expect(await c.listRetainers()).toEqual([r]);
    await c.getRetainer("ret_1");
    await c.updateRetainer("ret_1", { instructions: "Evening brief." });
    await c.pauseRetainer("ret_1");
    await c.resumeRetainer("ret_1");
    await c.cancelRetainer("ret_1");
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      "GET /api/retainers", "GET /api/retainers/ret_1", "PATCH /api/retainers/ret_1",
      "POST /api/retainers/ret_1/pause", "POST /api/retainers/ret_1/resume", "DELETE /api/retainers/ret_1",
    ]);
    expect(calls[2].body).toEqual({ instructions: "Evening brief." });
  });

  it("getRetainerLimits reads the limits from the list", async () => {
    const limits = { tier: "base", active: 3, inUse: 1, fastestHours: 4, next: { tier: "holder", hold: 250000, active: 10, fastestHours: 1 } };
    stub({ "GET /api/retainers": { retainers: [r], limits } });
    expect(await client().getRetainerLimits()).toEqual(limits);
  });

  it("getAgentRetainers reads the owner's view of an agent's clients", async () => {
    const view = { clients: 1, active: 1, paused: 0, last30Days: { runs: 2, completed: 2, earned: "0.0003" }, retainers: [] };
    const calls = stub({ "GET /api/agents/crypto-agent/retainers": view });
    expect(await client().getAgentRetainers("crypto-agent")).toEqual(view);
    expect(calls[0].path).toBe("/api/agents/crypto-agent/retainers");
  });

  it("listRetainerRuns pages with limit and before", async () => {
    const calls = stub({ "GET /api/retainers/ret_1/runs": { runs: [], nextBefore: null } });
    await client().listRetainerRuns("ret_1", { limit: 5, before: "2026-09-27T06:00:00.000Z" });
    expect(new URLSearchParams(calls[0].search).get("limit")).toBe("5");
    expect(new URLSearchParams(calls[0].search).get("before")).toBe("2026-09-27T06:00:00.000Z");
  });

  it("setRetainerWebhook puts the url; removeRetainerWebhook deletes it", async () => {
    const calls = stub({
      "PUT /api/retainers/ret_1/webhook": { webhook: { url: "https://x.test" }, secret: "whsec_1" },
      "DELETE /api/retainers/ret_1/webhook": { webhook: null },
    });
    expect((await client().setRetainerWebhook("ret_1", "https://x.test")).secret).toBe("whsec_1");
    await client().removeRetainerWebhook("ret_1");
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual(["PUT /api/retainers/ret_1/webhook", "DELETE /api/retainers/ret_1/webhook"]);
    expect(calls[0].body).toEqual({ url: "https://x.test" });
  });

  it("ids are encoded into the path", async () => {
    const calls = stub({ "GET /api/retainers/a%2Fb": { retainer: r } });
    await client().getRetainer("a/b");
    expect(calls[0].path).toBe("/api/retainers/a%2Fb");
  });
});

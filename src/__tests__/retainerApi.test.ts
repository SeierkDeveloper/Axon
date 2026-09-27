// The retainer API, through its real route handlers with real keys: a full key, an allowance key, and
// a stranger's. Most of it is who may see and do what.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("@/lib/urlSecurity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/urlSecurity")>()),
  validatePublicHttpUrl: vi.fn().mockResolvedValue(null),
}));

const getTier = vi.fn();
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

vi.mock("@/lib/allowancePayment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/allowancePayment")>("@/lib/allowancePayment");
  return { ...actual, payFromAllowance: async () => ({}), freshAxonQuoteFor: async () => "q" };
});

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { createAllowanceKey } from "@/lib/allowanceKeys";
import { toWei } from "@/lib/money";
import { runDueRetainers } from "@/lib/retainerRunner";
import { GET as list, POST as create } from "@/app/api/retainers/route";
import { GET as read, PATCH as edit, DELETE as cancel } from "@/app/api/retainers/[retainerId]/route";
import { POST as pause } from "@/app/api/retainers/[retainerId]/pause/route";
import { POST as resume } from "@/app/api/retainers/[retainerId]/resume/route";
import { GET as runs } from "@/app/api/retainers/[retainerId]/runs/route";
import { PUT as setHook, DELETE as dropHook } from "@/app/api/retainers/[retainerId]/webhook/route";
import { GET as agentClients } from "@/app/api/agents/[agentId]/retainers/route";
import { PATCH as patchAgent } from "@/app/api/agents/[agentId]/route";
import { getAgentById } from "@/lib/agents";
import type { Agent } from "@/sdk/types";

const wallet = () => `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;

function agent(price?: string): string {
  const a: Agent = {
    agentId: `ra-${randomUUID().slice(0, 8)}`,
    name: "API Test Agent",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: wallet(),
    provider: "anthropic",
    price,
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a.agentId;
}

function req(url: string, key: string | null, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (retainerId: string) => ({ params: Promise.resolve({ retainerId }) });

const daily = { kind: "daily", time: "08:00", timeZone: "Europe/Oslo" };
const body = (agentId: string, over: Record<string, unknown> = {}) => ({ agentId, instructions: "Morning brief.", schedule: daily, ...over });

let owner: string;
let fullKey: string;
let paid: string;

beforeEach(() => {
  getTier.mockResolvedValue({ tier: { name: "base", rank: 0, minimum: 0 }, balance: 0, stale: false });
  owner = wallet();
  fullKey = createApiKey(owner).apiKey;
  paid = agent("0.00015 ETH");
});

async function made(key = fullKey, over: Record<string, unknown> = {}) {
  const res = await create(req("/api/retainers", key, "POST", body(paid, over)));
  return { res, json: await res.json() };
}

describe("creating", () => {
  it("creates with a default price ceiling a quarter above the agent's price, in ETH", async () => {
    const { res, json } = await made();
    expect(res.status).toBe(201);
    expect(json.retainer).toMatchObject({
      agentId: paid,
      status: "active",
      maxPrice: "0.0001875",
      scheduleText: "Every day at 08:00 (Europe/Oslo)",
      maxPerDay: "0.0001875",
      createdByKey: false,
      webhook: null,
    });
    expect(json.retainer.nextRunAt).toBeTruthy();
  });

  it("says why it cannot, in the policy's words", async () => {
    expect((await (await create(req("/api/retainers", fullKey, "POST", body(paid, { schedule: { kind: "interval", everyHours: 5 } })))).json()).error).toMatch(/Run every/);
    expect((await create(req("/api/retainers", fullKey, "POST", body(agent())))).status).toBe(400);
    expect((await create(req("/api/retainers", fullKey, "POST", body("no-such-agent")))).status).toBe(404);
    expect((await create(req("/api/retainers", fullKey, "POST", body(paid, { maxPrice: 0.0002 })))).status).toBe(400);
    expect((await create(req("/api/retainers", fullKey, "POST", body(paid, { payIn: "BTC" })))).status).toBe(400);
    expect((await create(req("/api/retainers", null, "POST", body(paid)))).status).toBe(401);
  });

  it("an hourly schedule needs a holder tier", async () => {
    const hourly = body(paid, { schedule: { kind: "interval", everyHours: 1 } });
    expect((await create(req("/api/retainers", fullKey, "POST", hourly))).status).toBe(400);
    getTier.mockResolvedValue({ tier: { name: "holder", rank: 1, minimum: 0 }, balance: 1, stale: false });
    expect((await create(req("/api/retainers", fullKey, "POST", hourly))).status).toBe(201);
  });
});

describe("limits", () => {
  it("the list says what the tier allows, how much is used, and what holding more adds", async () => {
    await made();
    const { limits } = await (await list(req("/api/retainers", fullKey))).json();
    expect(limits).toEqual({ tier: "base", active: 3, inUse: 1, fastestHours: 4, next: { tier: "holder", hold: 250_000, active: 10, fastestHours: 1 } });
  });

  it("a full wallet is told to cancel one or hold more", async () => {
    for (let i = 0; i < 3; i++) await made();
    const res = await create(req("/api/retainers", fullKey, "POST", body(paid)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cancel one or hold more \$AXON/);
  });
});

describe("the owner's controls", () => {
  it("read, change, pause, resume, list runs and cancel", async () => {
    const { json } = await made();
    const id = json.retainer.retainerId;

    const got = await (await read(req(`/api/retainers/${id}`, fullKey), ctx(id))).json();
    expect(got.retainer).toMatchObject({ retainerId: id, latest: null });

    const changed = await (await edit(req(`/api/retainers/${id}`, fullKey, "PATCH", { instructions: "Evening brief.", maxPrice: "0.0003" }), ctx(id))).json();
    expect(changed.retainer).toMatchObject({ instructions: "Evening brief.", maxPrice: "0.0003" });
    expect((await edit(req(`/api/retainers/${id}`, fullKey, "PATCH", {}), ctx(id))).status).toBe(400);

    expect((await (await pause(req(`/api/retainers/${id}/pause`, fullKey, "POST"), ctx(id))).json()).retainer.status).toBe("paused");
    expect((await pause(req(`/api/retainers/${id}/pause`, fullKey, "POST"), ctx(id))).status).toBe(400);
    expect((await (await resume(req(`/api/retainers/${id}/resume`, fullKey, "POST"), ctx(id))).json()).retainer.status).toBe("active");

    const history = await (await runs(req(`/api/retainers/${id}/runs`, fullKey), ctx(id))).json();
    expect(history).toEqual({ runs: [], nextBefore: null });

    const gone = await (await cancel(req(`/api/retainers/${id}`, fullKey, "DELETE"), ctx(id))).json();
    expect(gone.retainer).toMatchObject({ status: "cancelled", nextRunAt: null });
  });

  it("runs come back in ETH, newest first", async () => {
    const { json } = await made(fullKey, { schedule: { kind: "interval", everyHours: 4 } });
    const id = json.retainer.retainerId;
    getDb().prepare(`UPDATE retainers SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE retainer_id != ? AND status = 'active'`).run(id);
    await runDueRetainers(Date.parse(json.retainer.nextRunAt));
    const history = await (await runs(req(`/api/retainers/${id}/runs?limit=1`, fullKey), ctx(id))).json();
    expect(history.runs[0]).toMatchObject({ status: "running", price: "0.00015" });
    expect(history.runs[0].priceWei).toBeUndefined();
    expect(history.nextBefore).toBe(history.runs[0].scheduledFor);
  });

  it("a stranger sees nothing and can do nothing", async () => {
    const { json } = await made();
    const id = json.retainer.retainerId;
    const stranger = createApiKey(wallet()).apiKey;
    expect((await read(req(`/api/retainers/${id}`, stranger), ctx(id))).status).toBe(404);
    expect((await edit(req(`/api/retainers/${id}`, stranger, "PATCH", { instructions: "x" }), ctx(id))).status).toBe(404);
    expect((await pause(req(`/api/retainers/${id}/pause`, stranger, "POST"), ctx(id))).status).toBe(404);
    expect((await runs(req(`/api/retainers/${id}/runs`, stranger), ctx(id))).status).toBe(404);
    expect((await setHook(req(`/api/retainers/${id}/webhook`, stranger, "PUT", { url: "https://evil.example" }), ctx(id))).status).toBe(404);
    expect((await cancel(req(`/api/retainers/${id}`, stranger, "DELETE"), ctx(id))).status).toBe(404);
    expect((await (await list(req("/api/retainers", stranger))).json()).retainers).toEqual([]);
    expect((await (await read(req(`/api/retainers/${id}`, fullKey), ctx(id))).json()).retainer.status).toBe("active");
  });
});

describe("allowance keys", () => {
  it("can create, and see and control only what they created", async () => {
    const byOwner = (await made()).json.retainer.retainerId;
    const { apiKey } = createAllowanceKey(owner, { label: "assistant" }) as { apiKey: string };
    const { res, json } = await made(apiKey);
    expect(res.status).toBe(201);
    expect(json.retainer.createdByKey).toBe(true);
    const mine = json.retainer.retainerId;

    const listed = (await (await list(req("/api/retainers", apiKey))).json()).retainers.map((r: { retainerId: string }) => r.retainerId);
    expect(listed).toEqual([mine]);
    expect((await read(req(`/api/retainers/${byOwner}`, apiKey), ctx(byOwner))).status).toBe(404);
    expect((await pause(req(`/api/retainers/${mine}/pause`, apiKey, "POST"), ctx(mine))).status).toBe(200);
    // The owner's full key sees both.
    expect((await (await list(req("/api/retainers", fullKey))).json()).retainers).toHaveLength(2);
  });

  it("are held to their own limits when they set one up", async () => {
    const other = agent("0.00015 ETH");
    const { apiKey } = createAllowanceKey(owner, { allowedAgents: [other], maxPerTaskWei: toWei("0.0002")! }) as { apiKey: string };
    const notAllowed = await create(req("/api/retainers", apiKey, "POST", body(paid)));
    expect(notAllowed.status).toBe(403);
    expect((await notAllowed.json()).error).toMatch(/allowed list/);
    const tooDear = await create(req("/api/retainers", apiKey, "POST", body(other, { maxPrice: "0.0003" })));
    expect(tooDear.status).toBe(403);
    expect((await create(req("/api/retainers", apiKey, "POST", body(other)))).status).toBe(201);
  });

  it("cannot point a retainer's results somewhere else", async () => {
    const { apiKey } = createAllowanceKey(owner, {}) as { apiKey: string };
    const id = (await made(apiKey)).json.retainer.retainerId;
    const res = await setHook(req(`/api/retainers/${id}/webhook`, apiKey, "PUT", { url: "https://example.com/x" }), ctx(id));
    expect([401, 403]).toContain(res.status);
  });
});

describe("webhooks", () => {
  it("the owner sets one, gets the secret once, and can remove it", async () => {
    const id = (await made()).json.retainer.retainerId;
    const set = await (await setHook(req(`/api/retainers/${id}/webhook`, fullKey, "PUT", { url: "https://example.com/r" }), ctx(id))).json();
    expect(set.secret).toMatch(/^whsec_/);
    expect(set.webhook).toMatchObject({ url: "https://example.com/r", active: true });
    const shown = await (await read(req(`/api/retainers/${id}`, fullKey), ctx(id))).json();
    expect(JSON.stringify(shown)).not.toContain(set.secret);
    expect((await (await dropHook(req(`/api/retainers/${id}/webhook`, fullKey, "DELETE"), ctx(id))).json()).webhook).toBeNull();
    expect((await setHook(req(`/api/retainers/${id}/webhook`, fullKey, "PUT", {}), ctx(id))).status).toBe(400);
  });
});

describe("the agent owner's side", () => {
  const agentCtx = (agentId: string) => ({ params: Promise.resolve({ agentId }) });

  it("the owner sets a retainer discount, within half the price", async () => {
    const ownerKey = createApiKey(getAgentById(paid)!.walletAddress!).apiKey;
    expect((await patchAgent(req(`/api/agents/${paid}`, ownerKey, "PATCH", { retainerDiscountBps: 6000 }), agentCtx(paid))).status).toBe(400);
    expect((await patchAgent(req(`/api/agents/${paid}`, ownerKey, "PATCH", { retainerDiscountBps: 2000 }), agentCtx(paid))).status).toBe(200);
    expect(getAgentById(paid)!.retainerDiscountBps).toBe(2000);
    // A client sees the price after it, and may set a maximum down to it.
    const { res, json } = await made(fullKey, { maxPrice: "0.00012" });
    expect(res.status).toBe(201);
    expect(json.retainer.pricePerRun).toBe("0.00012");
  });

  it("the owner sees who keeps the agent on a schedule and what it earned; nobody else does", async () => {
    await made();
    const other = createApiKey(wallet()).apiKey;
    await made(other);
    const ownerKey = createApiKey(getAgentById(paid)!.walletAddress!).apiKey;

    const res = await agentClients(req(`/api/agents/${paid}/retainers`, ownerKey), agentCtx(paid));
    expect(res.status).toBe(200);
    const view = await res.json();
    expect(view).toMatchObject({ clients: 2, active: 2, paused: 0, last30Days: { runs: 0, completed: 0, earned: "0" } });
    expect(view.retainers[0]).toMatchObject({ client: owner.toLowerCase(), scheduleText: "Every day at 08:00 (Europe/Oslo)" });
    expect(view.retainers[0].instructions).toBeUndefined();

    expect((await agentClients(req(`/api/agents/${paid}/retainers`, fullKey), agentCtx(paid))).status).toBe(403);
    expect((await agentClients(req(`/api/agents/${paid}/retainers`, null), agentCtx(paid))).status).toBe(401);
  });
});

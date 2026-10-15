// Agents that sell what they make: an agent that makes and lists products by itself, on its owner's schedule. Each run
// is an ordinary job; what it builds is listed at the owner's price, marked as made by the agent. No model is called
// here: a job's end is written into the store the way the worker would leave it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { addVersion, createSite } from "@/lib/agentSites";
import { asksToBuild } from "@/lib/buildTool";
import { getProduct, shopAgentOf } from "@/lib/agentShop";
import { canMake, describeMade, makeRunsOf, makeTask, runDueMakes, setMaking, settleMakeRuns } from "@/lib/shopMake";
import { getTaskById } from "@/lib/tasks";
import { GET as ownerRoute, PUT as settingsRoute } from "@/app/api/shop/agents/[agentId]/route";

const saved = { shop: process.env.AGENT_SHOP, sites: process.env.AGENT_SITES };
beforeEach(() => {
  process.env.AGENT_SHOP = "on";
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM shop_make_runs; DELETE FROM shop_agents; DELETE FROM shop_products; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_SHOP", saved.shop], ["AGENT_SITES", saved.sites]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
const wallet = () => `0x${(++n + 7_500_000).toString(16).padStart(40, "0")}`;
function agentOf(owner: string, o: { endpoint?: string } = {}): string {
  const id = `maker-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Tool Smith", capabilities: ["web development"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: owner, createdAt: new Date().toISOString(), ...(o.endpoint ? { endpoint: o.endpoint } : {}) });
  return id;
}
const PLAN = { on: true, kind: "Small calculators for freelancers who bill by the hour", price: "0.003", everyHours: 24, perDay: 2 };
const LIMITS = { minWei: 100_000_000_000_000n, maxWei: 10n ** 18n, perAgent: 50, makePerDayMax: 3, makeDaily: 50, materialMaxWei: 0n, priceGraceMinutes: 30 };

/** What the worker leaves behind when a run's job built a page: the site, under the hirer's wallet, and the job done. */
function jobBuilt(taskId: string, agentId: string, owner: string, title: string, output: string) {
  const m = createSite({ taskId, agentId, ownerMark: owner, title });
  if (!m.ok) throw new Error(m.why);
  addVersion(m.site.siteId, [{ path: "index.html", content: `<h1>${title}</h1>` }], { taskId });
  getDb().prepare("UPDATE tasks SET status = 'completed', output = ?, completed_at = ? WHERE task_id = ?").run(output, new Date().toISOString(), taskId);
  return m.site.siteId;
}

describe("switching it on", () => {
  it("is for the owner of an agent that builds, with a kind, a price, a pace and a cap", () => {
    const me = wallet(), a = agentOf(me);
    expect(canMake(a)).toBe(true);
    expect(setMaking(a, wallet(), PLAN)).toEqual({ ok: false, why: "Only the agent's owner can do that." });
    expect(setMaking(a, me, { ...PLAN, kind: "tools" })).toEqual({ ok: false, why: "Say in a sentence what kind of products it should make." });
    expect(setMaking(a, me, { ...PLAN, price: "50" })).toEqual({ ok: false, why: "The highest price is 1 ETH." });
    expect(setMaking(a, me, { ...PLAN, everyHours: 1 })).toEqual({ ok: false, why: "How often is every 4 to 168 hours." });
    expect(setMaking(a, me, { ...PLAN, perDay: 9 })).toEqual({ ok: false, why: "An agent can make 1 to 3 products a day." });
    const r = setMaking(a, me, PLAN);
    expect(r.ok && r.shop.make).toMatchObject({ on: true, kind: PLAN.kind, priceWei: 3_000_000_000_000_000n, everyHours: 24, perDay: 2, nextAt: expect.any(String) });
    expect(setMaking(a, me, { on: false }).ok).toBe(true);
    expect(shopAgentOf(a)!.make).toMatchObject({ on: false, kind: PLAN.kind, nextAt: null });
    // an agent on its own server does not build here, so it cannot make products
    const away = agentOf(me, { endpoint: "https://agent.example.com/run" });
    expect(canMake(away)).toBe(false);
    expect(setMaking(away, me, PLAN)).toEqual({ ok: false, why: "This agent cannot build pages, so it cannot make products." });
  });
});

describe("a run", () => {
  it("hires the agent by its owner's wallet to build something new, once per slot", () => {
    const me = wallet(), a = agentOf(me);
    setMaking(a, me, PLAN);
    const t0 = Date.now() + 1000;
    expect(runDueMakes(t0, LIMITS)).toEqual({ due: 1, started: 1, skipped: 0 });
    const [run] = makeRunsOf(a);
    expect(run).toMatchObject({ status: "running", taskId: expect.any(String) });
    const task = getTaskById(run.taskId!)!;
    expect(task).toMatchObject({ fromAgent: me.toLowerCase(), toAgent: a, status: "queued" });
    expect(task.payment ?? null).toBeNull();
    expect(task.task).toContain(PLAN.kind);
    // worded so the worker hands the job the build tool
    expect(asksToBuild(task.task)).toBe(true);
    // the next slot moved before the job was made: nothing more is due now
    expect(runDueMakes(t0, LIMITS)).toEqual({ due: 0, started: 0, skipped: 0 });
    expect(Date.parse(shopAgentOf(a)!.make.nextAt!)).toBeGreaterThan(t0 + 23 * 3_600_000);
  });

  it("asks for something different from what it made before", () => {
    expect(makeTask("Quizzes about birds", ["Owl quiz", "Gull quiz"])).toMatch(/different from what you made before: "Owl quiz", "Gull quiz"\./);
    expect(makeTask("Quizzes about birds", [])).not.toMatch(/different/);
  });

  it("keeps to the agent's day and the network's day", () => {
    const me = wallet(), a = agentOf(me);
    setMaking(a, me, { ...PLAN, everyHours: 4, perDay: 1 });
    const t0 = Date.now() + 1000;
    expect(runDueMakes(t0, LIMITS).started).toBe(1);
    // four hours on, the agent has made its one for the day: the slot is passed by
    expect(runDueMakes(t0 + 4 * 3_600_000 + 1000, LIMITS)).toMatchObject({ started: 0, skipped: 1 });
    // and with the network's day used up, nobody starts
    const b = agentOf(me);
    setMaking(b, me, PLAN);
    expect(runDueMakes(Date.now() + 2000, { ...LIMITS, makeDaily: 1 })).toMatchObject({ started: 0 });
    expect(runDueMakes(Date.now() + 2000, { ...LIMITS, makeDaily: 0 })).toMatchObject({ started: 0 });
  });

  it("stops for an agent that changed hands", () => {
    const me = wallet(), a = agentOf(me);
    setMaking(a, me, PLAN);
    getDb().prepare("UPDATE agents SET wallet_address = ? WHERE agent_id = ?").run(wallet(), a);
    expect(runDueMakes(Date.now() + 1000, LIMITS)).toEqual({ due: 1, started: 0, skipped: 1 });
    expect(shopAgentOf(a)!.make.on).toBe(false);
  });

  it("does nothing while the shop is off", () => {
    const me = wallet(), a = agentOf(me);
    setMaking(a, me, PLAN);
    process.env.AGENT_SHOP = "off";
    expect(runDueMakes(Date.now() + 1000, LIMITS)).toEqual({ due: 0, started: 0, skipped: 0 });
    expect(settleMakeRuns()).toEqual({ listed: 0, failed: 0 });
  });
});

describe("what a run made", () => {
  it("is listed at the owner's price, marked as made by the agent, in the agent's own words", () => {
    const me = wallet(), a = agentOf(me);
    setMaking(a, me, PLAN);
    runDueMakes(Date.now() + 1000, LIMITS);
    const [run] = makeRunsOf(a);
    // the worker keeps the page under the hirer's wallet as it is written on the job
    jobBuilt(run.taskId!, a, me.toLowerCase(), "Hourly Rate Calculator", "## Done\nI built **Hourly Rate Calculator**. It works out what to charge per hour from a yearly target. See https://example.com for more.");
    expect(settleMakeRuns()).toEqual({ listed: 1, failed: 0 });
    const [after] = makeRunsOf(a);
    expect(after).toMatchObject({ status: "listed", productId: expect.any(String) });
    const p = getProduct(after.productId!)!;
    expect(p).toMatchObject({ agentId: a, title: "Hourly Rate Calculator", madeBy: "agent", priceWei: 3_000_000_000_000_000n, status: "listed" });
    expect(p.description).toBe("I built Hourly Rate Calculator. It works out what to charge per hour from a yearly target.");
  });

  it("lists nothing for a job that built nothing, or failed", () => {
    const me = wallet(), a = agentOf(me);
    setMaking(a, me, { ...PLAN, perDay: 3, everyHours: 4 });
    runDueMakes(Date.now() + 1000, LIMITS);
    runDueMakes(Date.now() + 4 * 3_600_000 + 2000, LIMITS);
    const [second, first] = makeRunsOf(a);
    getDb().prepare("UPDATE tasks SET status = 'completed', output = 'Here are some ideas.' WHERE task_id = ?").run(first.taskId);
    getDb().prepare("UPDATE tasks SET status = 'failed', error = 'timeout' WHERE task_id = ?").run(second.taskId);
    expect(settleMakeRuns()).toEqual({ listed: 0, failed: 2 });
    expect(makeRunsOf(a).map((r) => r.error).sort()).toEqual(["the job built nothing", "the job failed"]);
  });

  it("leaves a run whose job is still going for the next tick", () => {
    const me = wallet(), a = agentOf(me);
    setMaking(a, me, PLAN);
    runDueMakes(Date.now() + 1000, LIMITS);
    expect(settleMakeRuns()).toEqual({ listed: 0, failed: 0 });
    expect(makeRunsOf(a)[0].status).toBe("running");
  });

  it("is described with a line of its own when the agent said nothing usable", () => {
    expect(describeMade("", "Quiz", "Tool Smith")).toBe("Quiz, made by Tool Smith on its own.");
    expect(describeMade("```html\n<h1>x</h1>\n```", "Quiz", "Tool Smith")).toBe("Quiz, made by Tool Smith on its own.");
  });
});

describe("the owner's settings route", () => {
  it("reads and sets making for the owner's key only", async () => {
    const me = wallet(), a = agentOf(me);
    const { apiKey } = createApiKey(me, {});
    const { apiKey: stranger } = createApiKey(wallet(), {});
    const put = (key: string, body: unknown) => settingsRoute(new NextRequest(`http://localhost/api/shop/agents/${a}`, { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ agentId: a }) });
    expect((await put(stranger, { make: PLAN })).status).toBe(403);
    expect((await put(apiKey, { make: { on: "yes" } })).status).toBe(400);
    const r = await put(apiKey, { make: PLAN });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { settings: { make: { on: boolean; price: string } } }).settings.make).toMatchObject({ on: true, price: "0.003 ETH" });
    const got = (await (await ownerRoute(new NextRequest(`http://localhost/api/shop/agents/${a}`, { headers: { authorization: `Bearer ${apiKey}` } }), { params: Promise.resolve({ agentId: a }) })).json()) as { settings: { make: { can: boolean; on: boolean; everyHours: number } } };
    expect(got.settings.make).toMatchObject({ can: true, on: true, everyHours: 24 });
  });
});

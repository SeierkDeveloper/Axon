// Agents that run their own business: selling through the shop, its books, reinvesting within the limits, the P&L,
// the daily report and what each reader sees, and the worker's pass. Every model is a stand-in.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { createAgent, getAgentById } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { createOpenTask } from "@/lib/bidding";
import { shopAgentOf } from "@/lib/agentShop";
import { decisionsOf, getBusiness, pauseBusiness, startBusiness, stopBusiness, dayOf } from "@/lib/business";
import { entriesOf, record } from "@/lib/businessLedger";
import { materialRefusal } from "@/lib/businessLimits";
import { makeKind, modelByBooks, priceByDemand, reinvest, restoreModel, shopHooks, syncShop } from "@/lib/businessGrow";
import { dayFigures, guardReport, ownerView, plainReport, pnl, publicView, reportsOf, writeReport, type Writer } from "@/lib/businessBooks";
import { controlHooks, runBusinessTick } from "@/lib/businessRun";
import { businessCaps } from "@/lib/businessPolicy";

const saved = { biz: process.env.AGENT_BUSINESS, shop: process.env.AGENT_SHOP, sites: process.env.AGENT_SITES };
beforeEach(() => {
  process.env.AGENT_BUSINESS = "on";
  process.env.AGENT_SHOP = "on";
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM businesses; DELETE FROM business_ledger; DELETE FROM business_decisions; DELETE FROM business_jobs; DELETE FROM business_reports; DELETE FROM open_tasks; DELETE FROM bids; DELETE FROM shop_agents; DELETE FROM shop_sales;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_BUSINESS", saved.biz], ["AGENT_SHOP", saved.shop], ["AGENT_SITES", saved.sites]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
const wallet = () => `0x${(++n + 8_500_000).toString(16).padStart(40, "0")}`;
function agentOf(owner: string, o: { price?: string; model?: string } = {}): string {
  const id = `gr-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Logo Smith", capabilities: ["design", "logo"], publicKey: `pk-${id}`, provider: "anthropic", providerModel: o.model, reputation: 0, walletAddress: owner, price: o.price ?? "0.001 ETH", createdAt: new Date().toISOString() });
  createApiKey(owner);
  return id;
}
const PLAN = { goal: "Run a small logo studio for new shops", budgetEth: "0.05", maxPerDayEth: "0.01", maxPerJobEth: "0.005", approveAboveEth: "0.002", spendOn: ["hire", "material", "model"], priceMinEth: "0.0005", priceMaxEth: "0.0012" };
function startOne(o: { model?: string; plan?: Partial<typeof PLAN> & { sell?: { on: boolean; priceEth: string } } } = {}) {
  const me = wallet(), a = agentOf(me, { model: o.model });
  const r = startBusiness(me, { agentId: a, ...PLAN, ...(o.plan ?? {}) }, shopHooks());
  if (!r.ok) throw new Error(r.why);
  return { me, a, b: r.business };
}
const wei = (eth: number) => BigInt(Math.round(eth * 1e9)) * 10n ** 9n;
const price = async () => 2000;
const jobsRow = (businessId: string, status: string) => getDb().prepare("INSERT INTO business_jobs (business_id, open_task_id, bid_id, status, price_wei, created_at, updated_at) VALUES (?, ?, 'x', ?, '1', ?, ?)").run(businessId, randomUUID(), status, new Date().toISOString(), new Date().toISOString());
function sale(o: { seller: string; buyer: string; kind: "wallet" | "agent"; eth: number; title: string; forTask?: string; status?: string }) {
  const id = `sale_${randomUUID().slice(0, 8)}`;
  getDb().prepare("INSERT INTO shop_sales (sale_id, product_id, agent_id, buyer, buyer_kind, for_task_id, price_wei, status, version, sha256, title, created_at, delivered_at) VALUES (?, 'p', ?, ?, ?, ?, ?, ?, 1, 'h', ?, ?, ?)")
    .run(id, o.seller, o.buyer.toLowerCase(), o.kind, o.forTask ?? null, wei(o.eth).toString(), o.status ?? "delivered", o.title, new Date().toISOString(), new Date().toISOString());
  return id;
}

describe("selling", () => {
  it("switches the shop's making on from its goal, and off when it pauses", () => {
    const { a, me, b } = startOne({ plan: { sell: { on: true, priceEth: "0.002" } } });
    expect(shopAgentOf(a)?.make).toMatchObject({ on: true, kind: "Products for this business: Run a small logo studio for new shops.", priceWei: wei(0.002) });
    expect(shopAgentOf(a)?.buy).toMatchObject({ on: true, maxWei: wei(0.002) });
    pauseBusiness(b.businessId, me, shopHooks());
    expect(shopAgentOf(a)?.make.on).toBe(false);
    expect(shopAgentOf(a)?.buy.on).toBe(false);
  });

  it("says why when the shop is closed", () => {
    process.env.AGENT_SHOP = "off";
    const { b } = startOne({ plan: { sell: { on: true, priceEth: "0.002" } } });
    expect(decisionsOf(b.businessId).filter((d) => d.kind === "make" || d.kind === "material").map((d) => d.reason).sort()).toEqual([
      "Buying material did not start: the shop is not open on this network",
      "The shop did not start making: the shop is not open on this network",
    ]);
  });

  it("steers what it makes by what people ask for and what sold", () => {
    expect(makeKind("A logo studio.", ["logo", "brand"], "Bakery Logo Pack")).toBe('Products for this business: A logo studio. People on Axon keep asking for: logo, brand. What sold best so far: "Bakery Logo Pack". Make something different that the same people would want.');
  });

  it("puts its sales and the material it bought in the books, once", () => {
    const { a, b } = startOne();
    const other = agentOf(wallet());
    const s1 = sale({ seller: a, buyer: wallet(), kind: "wallet", eth: 0.003, title: "Logo Pack" });
    const m1 = sale({ seller: other, buyer: a, kind: "agent", eth: 0.001, title: "Icon Set", forTask: "job-9" });
    sale({ seller: a, buyer: wallet(), kind: "wallet", eth: 0.003, title: "Refunded", status: "refunded" });
    expect(syncShop(b)).toEqual({ sales: 1, material: 1 });
    expect(syncShop(b)).toEqual({ sales: 0, material: 0 });
    const books = entriesOf(b.businessId);
    expect(books.find((e) => e.kind === "sale")).toMatchObject({ ref: s1, amountWei: wei(0.003) });
    expect(books.find((e) => e.kind === "material")).toMatchObject({ ref: m1, jobRef: "job-9", amountWei: wei(0.001) });
  });

  it("holds a purchase inside a job to the business's limits", () => {
    const { a, b } = startOne();
    expect(materialRefusal(a, "job-1", wei(0.002))).toBeNull();
    record(b.businessId, { kind: "material", amountWei: wei(0.004), ref: "s-1", jobRef: "job-1" });
    expect(materialRefusal(a, "job-1", wei(0.002))).toMatch(/past its limit of 0.005 ETH/);
    expect(materialRefusal(agentOf(wallet()), "job-1", wei(1))).toBeNull(); // not a business
  });
});

describe("reinvesting", () => {
  it("moves its price a step by demand, never outside the owner's range", () => {
    const { a, b } = startOne();
    for (let i = 0; i < 3; i++) jobsRow(b.businessId, "done");
    jobsRow(b.businessId, "lost");
    expect(priceByDemand(b)).toBe("It won 3 of its last 4 bids: price up from 0.001 ETH to 0.0011 ETH");
    expect(getAgentById(a)!.price).toBe("0.0011 ETH");
    expect(priceByDemand(b)).toBe("It won 3 of its last 4 bids: price up from 0.0011 ETH to 0.0012 ETH");
    expect(priceByDemand(b)).toBeNull(); // at the top of the range
    const two = startOne();
    for (let i = 0; i < 4; i++) jobsRow(two.b.businessId, "lost");
    expect(priceByDemand(two.b)).toBe("It won none of its last 4 bids: price down from 0.001 ETH to 0.0009 ETH");
  });

  it("steps its model up when the week paid for it, back down when it lost money, never below where it began", async () => {
    const { a, b } = startOne({ model: "claude-haiku-4-5" });
    const nowMs = Date.now();
    for (let i = 0; i < 3; i++) {
      record(b.businessId, { kind: "job", amountWei: wei(0.001), ref: `job-${i}` });
      record(b.businessId, { kind: "model", amountWei: wei(0.000005), costUsd: 0.01, ref: `job:job-${i}`, jobRef: `job-${i}` });
    }
    expect(await modelByBooks(b, nowMs, price)).toMatch(/moved up to claude-sonnet-5/);
    expect(getAgentById(a)!.providerModel).toBe("claude-sonnet-5");
    expect(entriesOf(b.businessId).find((e) => e.kind === "event")).toMatchObject({ note: "Model claude-haiku-4-5 to claude-sonnet-5", amountWei: 0n });
    record(b.businessId, { kind: "hire", amountWei: wei(0.01), ref: "big-hire", jobRef: "job-0" });
    expect(await modelByBooks(getBusiness(b.businessId)!, nowMs + 86_400_000, price)).toMatch(/back to claude-haiku-4-5/);
    expect(getAgentById(a)!.providerModel).toBe("claude-haiku-4-5");
    expect(await modelByBooks(getBusiness(b.businessId)!, nowMs + 2 * 86_400_000, price)).toBeNull();
  });

  it("puts the model back where it started when it stops", async () => {
    const { me, a, b } = startOne({ model: "claude-haiku-4-5" });
    for (let i = 0; i < 3; i++) record(b.businessId, { kind: "job", amountWei: wei(0.001), ref: `job-${i}` });
    await modelByBooks(b, Date.now(), price);
    expect(getAgentById(a)!.providerModel).toBe("claude-sonnet-5");
    stopBusiness(b.businessId, me, controlHooks());
    expect(getAgentById(a)!.providerModel).toBe("claude-haiku-4-5");
    restoreModel(getBusiness(b.businessId)!); // nothing more to do
  });

  it("reinvests once a UTC day", async () => {
    const { b } = startOne();
    for (let i = 0; i < 4; i++) jobsRow(b.businessId, "lost");
    expect(await reinvest(b, Date.now(), price)).toHaveLength(1);
    expect(await reinvest(getBusiness(b.businessId)!, Date.now(), price)).toEqual([]);
  });
});

describe("the P&L and the daily report", () => {
  const yesterday = Date.now() - 86_400_000;
  function booked() {
    const s = startOne();
    getDb().prepare("UPDATE businesses SET created_at = ? WHERE business_id = ?").run(new Date(yesterday - 3_600_000).toISOString(), s.b.businessId);
    record(s.b.businessId, { kind: "job", amountWei: wei(0.0009), ref: "job-1", atMs: yesterday });
    record(s.b.businessId, { kind: "sale", amountWei: wei(0.002), ref: "sale-1", atMs: yesterday });
    record(s.b.businessId, { kind: "hire", amountWei: wei(0.0005), ref: "hire-1", jobRef: "job-1", atMs: yesterday });
    record(s.b.businessId, { kind: "model", amountWei: wei(0.00001), costUsd: 0.02, ref: "job:job-1", atMs: yesterday });
    record(s.b.businessId, { kind: "hire", amountWei: wei(0.0003), ref: "hire-2", atMs: yesterday });
    getDb().prepare("UPDATE business_ledger SET voided_at = ? WHERE ref = 'hire-2'").run(new Date().toISOString());
    return { ...s, b: getBusiness(s.b.businessId)! };
  }

  it("reads earned, spent and profit per day and in total from the ledger", () => {
    const { b } = booked();
    const books = pnl(b);
    expect(books.days.map((d) => d.day)).toEqual([dayOf(yesterday), dayOf(Date.now())]);
    expect(books.total).toMatchObject({ earned: wei(0.0029), hires: wei(0.0005), model: wei(0.00001), spent: wei(0.00051), profit: wei(0.00239) });
    expect(books.modelUsd).toBe(0.02);
    expect(dayFigures(b, dayOf(yesterday))).toMatchObject({ earned: "0.0029", spent: "0.00051", profit: "0.00239", onModel: "0.00001", jobsDone: 1, productsSold: 1, hires: 1 });
  });

  it("throws out every sentence with a number that is not in the books, and any promise", () => {
    const { b } = booked();
    const f = dayFigures(b, dayOf(yesterday));
    const g = guardReport("I did 1 job and sold 1 product. I earned 0.0029 ETH. I spent 0.00051 ETH — mostly on help. Tomorrow I expect 5 jobs. This will earn steady returns. Profit was 0.00239 ETH.", f);
    expect(g.text).toBe("I did 1 job and sold 1 product. I earned 0.0029 ETH. I spent 0.00051 ETH , mostly on help. Profit was 0.00239 ETH.");
    expect(g.dropped).toBe(2);
    expect(plainReport(f, "Logo Smith")).toBe("Logo Smith did 1 job and sold 1 product. It bid on 0 jobs and declined 0. It earned 0.0029 ETH and spent 0.00051 ETH, 0.00001 ETH of it on model costs, so the day's profit is 0.00239 ETH.");
  });

  it("writes the report for a finished day once, with its model cost in the books, and falls back to the figures", async () => {
    const { b } = booked();
    const day = dayOf(yesterday);
    expect(await writeReport(b, dayOf(Date.now()), Date.now(), async () => ({ text: "x", costUsd: 0, model: "m" }))).toBeNull(); // not over yet
    const writer: Writer = async () => ({ text: "I earned 0.0029 ETH from 1 job and 1 sale. I made 99 new friends.", costUsd: 0.001, model: "claude-haiku-4-5" });
    const r = await writeReport(b, day, Date.now(), writer, businessCaps({}), price);
    expect(r).toMatchObject({ text: "I earned 0.0029 ETH from 1 job and 1 sale.", dropped: 1, model: "claude-haiku-4-5" });
    expect(await writeReport(b, day, Date.now(), writer, businessCaps({}), price)).toBeNull();
    expect(entriesOf(b.businessId).find((e) => e.ref === `report:${day}`)).toMatchObject({ kind: "model", costUsd: 0.001, amountWei: 500_000_000_000n });
    expect(reportsOf(b.businessId)[0].figures.profit).toBe("0.00239");
    const other = booked();
    const r2 = await writeReport(other.b, day, Date.now(), async () => { throw new Error("down"); }, businessCaps({}), price);
    expect(r2?.text).toMatch(/^Logo Smith did 1 job and sold 1 product\./);
  });

  it("shows the owner everything and anyone only what is safe", () => {
    const { a, b } = booked();
    const owner = ownerView(b);
    expect(owner.pnl.total).toMatchObject({ earned: "0.0029 ETH", spent: "0.00051 ETH", profit: "0.00239 ETH" });
    expect(owner.limits).toMatchObject({ budget: "0.05 ETH", approveAbove: "0.002 ETH", left: { budget: "0.0495 ETH" } });
    expect(owner.decisions.length).toBeGreaterThan(0);
    const pub = publicView(a)!;
    expect(Object.keys(pub).sort()).toEqual(["goal", "jobsDone", "productsSold", "recentJobs", "since", "status"]);
    expect(JSON.stringify(pub)).not.toMatch(/ETH|0\.0/);
    expect(publicView(agentOf(wallet()))).toBeNull();
  });
});

describe("the worker's pass", () => {
  it("looks for work when due, then waits; pauses a business whose agent changed hands", async () => {
    const { a, b } = startOne();
    const p = wallet();
    createApiKey(p);
    createOpenTask({ fromAgent: p, task: "Logo for a cafe", capabilities: ["logo"] });
    const judge = async () => ({ fit: { take: true, why: "It fits.", help: false }, costUsd: 0.0002, model: "m" });
    const writer: Writer = async () => ({ text: "", costUsd: null, model: "m" });
    const t = await runBusinessTick(Date.now(), { judge, writer, price });
    expect(t).toMatchObject({ kept: 1, looked: 1, bids: 1 });
    expect(getBusiness(b.businessId)!.nextScanAt! > new Date().toISOString()).toBe(true);
    expect(await runBusinessTick(Date.now(), { judge, writer, price })).toMatchObject({ looked: 0 });
    getDb().prepare("UPDATE agents SET wallet_address = ? WHERE agent_id = ?").run(wallet(), a);
    expect(await runBusinessTick(Date.now(), { judge, writer, price })).toMatchObject({ paused: 1 });
    expect(getBusiness(b.businessId)).toMatchObject({ status: "paused", pausedReason: "Its agent changed hands" });
    process.env.AGENT_BUSINESS = "off";
    expect(await runBusinessTick(Date.now(), { judge, writer, price })).toEqual({ kept: 0, paused: 0, looked: 0, bids: 0, reports: 0 });
  });
});

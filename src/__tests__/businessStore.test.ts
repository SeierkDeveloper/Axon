// Agents that run their own business: starting one, its limits, pausing and stopping, and the one place every spend is
// checked. No model and no chain: only the store.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { createAgent, getAgentById } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { createAllowanceKey } from "@/lib/allowanceKeys";
import { businessOfAgent, changeLimits, decisionsOf, getBusiness, pauseBusiness, resumeBusiness, startBusiness, stopBusiness, type Business } from "@/lib/business";
import { checkSpend, roomLeft } from "@/lib/businessLimits";
import { paidOut, record, voidEntry } from "@/lib/businessLedger";
import { businessCaps, businessEnabled } from "@/lib/businessPolicy";

const saved = process.env.AGENT_BUSINESS;
beforeEach(() => {
  process.env.AGENT_BUSINESS = "on";
  getDb().exec("DELETE FROM businesses; DELETE FROM business_ledger; DELETE FROM business_decisions; DELETE FROM business_jobs;");
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_BUSINESS; else process.env.AGENT_BUSINESS = saved;
});

let n = 0;
const wallet = () => `0x${(++n + 8_100_000).toString(16).padStart(40, "0")}`;
function agentOf(owner: string, o: { verified?: boolean; price?: string } = {}): string {
  const id = `biz-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Logo Smith", capabilities: ["design", "logo"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: owner, price: o.price ?? "0.0005 ETH", createdAt: new Date().toISOString() });
  if (o.verified !== false) createApiKey(owner);
  return id;
}
const PLAN = { goal: "Run a small logo studio for new shops", budgetEth: "0.01", maxPerDayEth: "0.004", maxPerJobEth: "0.002", approveAboveEth: "0.001", spendOn: ["hire", "material"], priceMinEth: "0.0002", priceMaxEth: "0.002" };

describe("the switch", () => {
  it("is off unless AGENT_BUSINESS=on, and nothing starts while it is off", () => {
    expect(businessEnabled({})).toBe(false);
    expect(businessEnabled({ AGENT_BUSINESS: "on" })).toBe(true);
    const me = wallet(), a = agentOf(me);
    process.env.AGENT_BUSINESS = "off";
    expect(startBusiness(me, { agentId: a, ...PLAN })).toEqual({ ok: false, why: "Businesses are not open on this network." });
  });

  it("keeps every number a deployment sets inside bounds", () => {
    expect(businessCaps({ AGENT_BUSINESS_SCAN_MINUTES: "0", AGENT_BUSINESS_BIDS_PER_HOUR: "500", AGENT_BUSINESS_BUDGET_MAX_ETH: "-1" })).toMatchObject({ scanMinutes: 15, bidsPerHourMax: 5, budgetMaxEth: 1 });
    expect(businessCaps({ AGENT_BUSINESS_CHECKS_PER_DAY: "0" }).checksPerDay).toBe(0);
  });
});

describe("starting one", () => {
  it("is for the agent's verified owner, with a goal, a budget and limits that fit inside each other", () => {
    const me = wallet(), a = agentOf(me);
    expect(startBusiness(wallet(), { agentId: a, ...PLAN })).toEqual({ ok: false, why: "Only the agent's owner can do that." });
    const unverifiedOwner = wallet(), b = agentOf(unverifiedOwner, { verified: false });
    expect(startBusiness(unverifiedOwner, { agentId: b, ...PLAN })).toEqual({ ok: false, why: "The agent's owner has to sign in with their wallet first." });
    expect(startBusiness(me, { agentId: a, ...PLAN, goal: "logos" })).toEqual({ ok: false, why: "Say in a sentence what business it should run." });
    expect(startBusiness(me, { agentId: a, ...PLAN, maxPerDayEth: "0.02" })).toEqual({ ok: false, why: "The most a day cannot be above the budget." });
    expect(startBusiness(me, { agentId: a, ...PLAN, maxPerJobEth: "0.005" })).toEqual({ ok: false, why: "The most on one job cannot be above the most a day." });
    expect(startBusiness(me, { agentId: a, ...PLAN, approveAboveEth: "0.003" })).toEqual({ ok: false, why: "The amount that needs your OK cannot be above the most on one job." });
    expect(startBusiness(me, { agentId: a, ...PLAN, spendOn: ["hire", "yachts"] })).toEqual({ ok: false, why: "What it may spend on is a list of: hire, material, model." });
    expect(startBusiness(me, { agentId: a, ...PLAN, budgetEth: "5" })).toEqual({ ok: false, why: "The budget can be at most 1 ETH." });
    expect(startBusiness(me, { agentId: a, ...PLAN, priceMinEth: "0.003" })).toEqual({ ok: false, why: "The lowest price cannot be above the highest." });
    const r = startBusiness(me, { agentId: a, ...PLAN });
    expect(r.ok).toBe(true);
    const biz = (r as { business: Business }).business;
    expect(biz).toMatchObject({ agentId: a, ownerWallet: me.toLowerCase(), status: "active", goal: PLAN.goal, bidsPerHour: 3 });
    expect(biz.limits).toMatchObject({ budgetWei: 10n ** 16n, maxPerDayWei: 4n * 10n ** 15n, maxPerJobWei: 2n * 10n ** 15n, approveAboveWei: 10n ** 15n, kinds: ["hire", "material"], allowanceKeyId: null });
    expect(decisionsOf(biz.businessId).map((d) => d.kind)).toEqual(["start"]);
    // one open business per agent
    expect(startBusiness(me, { agentId: a, ...PLAN })).toEqual({ ok: false, why: "This agent already runs a business. Stop it first to start another." });
  });

  it("starts its price inside the owner's range", () => {
    const me = wallet(), a = agentOf(me, { price: "0.01 ETH" });
    const r = startBusiness(me, { agentId: a, ...PLAN });
    expect(r.ok).toBe(true);
    expect(getAgentById(a)!.price).toBe("0.002 ETH");
    expect(decisionsOf((r as { business: Business }).business.businessId).map((d) => d.kind)).toEqual(["price", "start"]);
  });

  it("moves its price into a range the owner changes, and leaves a price already inside alone", () => {
    const me = wallet(), a = agentOf(me, { price: "0.001 ETH" });
    const id = (startBusiness(me, { agentId: a, ...PLAN }) as { business: Business }).business.businessId;
    expect(changeLimits(id, me, { ...PLAN, priceMinEth: "0.0002", priceMaxEth: "0.0005" }).ok).toBe(true);
    expect(getAgentById(a)!.price).toBe("0.0005 ETH");
    expect(changeLimits(id, me, { ...PLAN, priceMinEth: "0.0001", priceMaxEth: "0.001" }).ok).toBe(true);
    expect(getAgentById(a)!.price).toBe("0.0005 ETH");
    expect(decisionsOf(id).map((d) => d.kind)).toEqual(["change", "price", "change", "start"]);
  });

  it("takes only the owner's own allowance key", () => {
    const me = wallet(), a = agentOf(me), other = wallet();
    const theirs = createAllowanceKey(other);
    expect(startBusiness(me, { agentId: a, ...PLAN, allowanceKeyId: theirs.keyId })).toEqual({ ok: false, why: "That allowance key is not one of yours." });
    const mine = createAllowanceKey(me);
    const r = startBusiness(me, { agentId: a, ...PLAN, allowanceKeyId: mine.keyId });
    expect(r.ok && r.business.limits.allowanceKeyId).toBe(mine.keyId);
  });

  it("holds a few per wallet", () => {
    const me = wallet();
    for (let i = 0; i < 3; i++) expect(startBusiness(me, { agentId: agentOf(me), ...PLAN }).ok).toBe(true);
    expect(startBusiness(me, { agentId: agentOf(me), ...PLAN })).toEqual({ ok: false, why: "You can run 3 businesses at once." });
  });

  it("switches the shop on and off through its hooks, and logs what the shop said", () => {
    const me = wallet(), a = agentOf(me);
    const calls: string[] = [];
    const hooks = { setSelling: (_b: Business, on: boolean) => { calls.push(`sell:${on}`); return on ? null : "busy"; }, setBuying: (_b: Business, on: boolean) => { calls.push(`buy:${on}`); return null; } };
    const r = startBusiness(me, { agentId: a, ...PLAN, sell: { on: true, priceEth: "0.001" } }, hooks);
    expect(r.ok).toBe(true);
    const id = (r as { business: Business }).business.businessId;
    expect(calls).toEqual(["sell:true", "buy:true"]);
    expect(pauseBusiness(id, me, hooks).ok).toBe(true);
    expect(calls.slice(2)).toEqual(["sell:false", "buy:false"]);
    expect(decisionsOf(id).find((d) => d.kind === "make")?.reason).toBe("The shop did not stop making: busy");
  });
});

describe("pause, resume, stop, change", () => {
  it("only by the owner, and each is in the log", () => {
    const me = wallet(), a = agentOf(me);
    const id = (startBusiness(me, { agentId: a, ...PLAN }) as { business: Business }).business.businessId;
    expect(pauseBusiness(id, wallet())).toMatchObject({ ok: false, status: 404 });
    expect(pauseBusiness(id, me)).toMatchObject({ ok: true, business: { status: "paused", pausedReason: "You paused it" } });
    expect(pauseBusiness(id, me)).toMatchObject({ ok: false, why: "It is paused already." });
    expect(resumeBusiness(id, me)).toMatchObject({ ok: true, business: { status: "active", pausedReason: null } });
    expect(changeLimits(id, me, { ...PLAN, budgetEth: "0.02", bidsPerHour: 9 })).toMatchObject({ ok: false, why: "It can bid on 1 to 5 jobs an hour." });
    expect(changeLimits(id, me, { ...PLAN, budgetEth: "0.02", spendOn: ["model"] })).toMatchObject({ ok: true, business: { limits: { budgetWei: 2n * 10n ** 16n, kinds: ["model"] } } });
    let restored = false;
    expect(stopBusiness(id, me, { restoreModel: () => { restored = true; } })).toMatchObject({ ok: true, business: { status: "stopped", stoppedAt: expect.any(String) } });
    expect(restored).toBe(true);
    expect(resumeBusiness(id, me)).toMatchObject({ ok: false, why: "It has stopped. Start a new one." });
    expect(businessOfAgent(a)).toBeNull();
    expect(decisionsOf(id).map((d) => d.kind)).toEqual(["stop", "change", "resume", "pause", "start"]);
    // a stopped business frees the agent for a new one
    expect(startBusiness(me, { agentId: a, ...PLAN }).ok).toBe(true);
  });
});

describe("every spend asks one place", () => {
  const start = (spendOn: string[] = ["hire", "material"]) => {
    const me = wallet(), a = agentOf(me);
    return getBusiness((startBusiness(me, { agentId: a, ...PLAN, spendOn }) as { business: Business }).business.businessId)!;
  };
  const milli = (x: number) => BigInt(Math.round(x * 1_000_000)) * 10n ** 12n;

  it("refuses a kind the owner did not allow, and anything while it is not running", () => {
    const b = start(["hire"]);
    expect(checkSpend(b, { kind: "material", wei: 1n })).toMatchObject({ ok: false, why: expect.stringMatching(/may not buy other agents' products/) });
    expect(checkSpend({ ...b, status: "paused" }, { kind: "hire", wei: 1n })).toEqual({ ok: false, why: "The business is paused" });
  });

  it("keeps a job, a day and the budget, then asks above the owner's amount", () => {
    const b = start();
    expect(checkSpend(b, { kind: "hire", wei: milli(0.0005), jobRef: "job-1" })).toEqual({ ok: true });
    expect(checkSpend(b, { kind: "hire", wei: milli(0.0015), jobRef: "job-1" })).toMatchObject({ ok: false, ask: true });
    expect(checkSpend(b, { kind: "hire", wei: milli(0.0015), jobRef: "job-1", approved: true })).toEqual({ ok: true });
    record(b.businessId, { kind: "hire", amountWei: milli(0.0015), ref: "hire-1", jobRef: "job-1" });
    expect(checkSpend(b, { kind: "hire", wei: milli(0.001), jobRef: "job-1" })).toMatchObject({ ok: false, why: expect.stringMatching(/past its limit of 0.002 ETH/) });
    record(b.businessId, { kind: "material", amountWei: milli(0.002), ref: "sale-1", jobRef: "job-2" });
    expect(checkSpend(b, { kind: "hire", wei: milli(0.001), jobRef: "job-3" })).toMatchObject({ ok: false, why: expect.stringMatching(/take today past its limit of 0.004 ETH/) });
    // yesterday's spending counts for the budget, not for today
    const yesterday = Date.now() - 86_400_000;
    record(b.businessId, { kind: "hire", amountWei: milli(0.004), ref: "hire-old-1", jobRef: "job-old", atMs: yesterday });
    record(b.businessId, { kind: "hire", amountWei: milli(0.0025), ref: "hire-old-2", jobRef: "job-old2", atMs: yesterday });
    expect(paidOut(b.businessId)).toBe(milli(0.01));
    expect(checkSpend(b, { kind: "hire", wei: 1n, jobRef: "job-4" })).toMatchObject({ ok: false, why: expect.stringMatching(/past the budget of 0.01 ETH/) });
    // a refunded hire gives its room back
    expect(voidEntry(b.businessId, "hire", "hire-1")).toBe(true);
    expect(roomLeft(b).budget).toBe(milli(0.0015));
    // a line is written once
    expect(record(b.businessId, { kind: "hire", amountWei: 1n, ref: "hire-1" })).toBe(false);
    // model costs are in the P&L, not in the budget
    record(b.businessId, { kind: "model", amountWei: milli(1), ref: "check-1", costUsd: 0.01 });
    expect(paidOut(b.businessId)).toBe(milli(0.0085));
  });
});

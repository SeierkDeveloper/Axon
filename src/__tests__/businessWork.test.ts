// Agents that run their own business: finding work on the open board, following bids to the money, and hiring help
// within the limits. The model check is a stand-in; nothing here calls a model or a chain.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { acceptBid, createOpenTask, getBidsForOpenTask } from "@/lib/bidding";
import { createTask, getTaskById } from "@/lib/tasks";
import { decideApproval, listApprovals } from "@/lib/appPermissions";
import { decisionsOf, getBusiness, startBusiness } from "@/lib/business";
import { entriesOf, paidOut } from "@/lib/businessLedger";
import { businessJobOf, findWork, followWork, parseFit, ruledOut, skillsFit, type Judge } from "@/lib/businessWork";
import { businessTeam, hireFor, mayHire, syncHires } from "@/lib/businessHire";
import { businessCaps } from "@/lib/businessPolicy";
import type { Agent } from "@/sdk/types";
import { getAgentById } from "@/lib/agents";

const saved = process.env.AGENT_BUSINESS;
beforeEach(() => {
  process.env.AGENT_BUSINESS = "on";
  getDb().exec("DELETE FROM businesses; DELETE FROM business_ledger; DELETE FROM business_decisions; DELETE FROM business_jobs; DELETE FROM open_tasks; DELETE FROM bids; DELETE FROM app_approvals;");
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_BUSINESS; else process.env.AGENT_BUSINESS = saved;
});

let n = 0;
const wallet = () => `0x${(++n + 8_300_000).toString(16).padStart(40, "0")}`;
function agentOf(owner: string, o: { price?: string; caps?: string[]; verified?: boolean; name?: string } = {}): string {
  const id = `wk-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: o.name ?? "Logo Smith", capabilities: o.caps ?? ["design", "logo"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: owner, price: o.price ?? "0.0005 ETH", createdAt: new Date().toISOString() });
  if (o.verified !== false) createApiKey(owner);
  return id;
}
const PLAN = { goal: "Run a small logo studio for new shops", budgetEth: "0.01", maxPerDayEth: "0.004", maxPerJobEth: "0.002", approveAboveEth: "0.0006", spendOn: ["hire"], priceMinEth: "0.0002", priceMaxEth: "0.002" };
const CAPS = { ...businessCaps({}), checksPerScan: 10 };
function startOne(o: Partial<typeof PLAN> = {}) {
  const me = wallet(), a = agentOf(me);
  const r = startBusiness(me, { agentId: a, ...PLAN, ...o });
  if (!r.ok) throw new Error(r.why);
  return { me, a, b: r.business };
}
const poster = () => { const w = wallet(); createApiKey(w); return w; };
const yes: Judge = async () => ({ fit: { take: true, why: "A clean logo for a new shop is exactly its work.", help: false }, costUsd: 0.0004, model: "claude-haiku-4-5" });

describe("the rules, before any model", () => {
  it("never takes its owner's work, only verified posters, within its skills and price", () => {
    const { me, a, b } = startOne();
    const agent = getAgentById(a)!;
    const now = Date.now();
    const ot = (from: string, o: { caps?: string[]; maxBudget?: string; deadline?: string } = {}) => createOpenTask({ fromAgent: from, task: "Design a logo", capabilities: o.caps ?? ["logo"], maxBudget: o.maxBudget, deadline: o.deadline });
    expect(ruledOut(b, agent, ot(me), now)).toMatch(/Its own owner posted this/);
    expect(ruledOut(b, agent, ot(agentOf(me)), now)).toMatch(/One of its owner's own agents/);
    const shady = wallet();
    expect(ruledOut(b, agent, ot(agentOf(shady, { verified: false })), now)).toBe("The poster is not a verified agent");
    expect(ruledOut(b, agent, ot(poster(), { deadline: new Date(now - 1000).toISOString() }), now)).toBe("The bidding deadline has passed");
    expect(ruledOut(b, agent, ot(poster(), { caps: ["solidity", "audit"] }), now)).toBe("Outside its skills: it asks for solidity, audit");
    expect(ruledOut(b, agent, ot(poster(), { maxBudget: "0.0001 ETH" }), now)).toBe("The budget of 0.0001 ETH is below its price of 0.0005 ETH");
    expect(ruledOut(b, agent, ot(poster(), { maxBudget: "0.001 ETH" }), now)).toBeNull();
    // a verified agent of another owner is a fine poster
    expect(ruledOut(b, agent, ot(agentOf(poster())), now)).toBeNull();
  });

  it("matches skills by capability or by the words of the goal", () => {
    const agent = { capabilities: ["graphic design"] } as unknown as Agent;
    expect(skillsFit(agent, "a logo studio", ["design"])).toBe(true);
    expect(skillsFit(agent, "a logo studio", ["logos"])).toBe(false);
    expect(skillsFit(agent, "a logo studio", ["logo"])).toBe(true);
    expect(skillsFit(agent, "a logo studio", [])).toBe(true);
  });

  it("reads the model's answer strictly", () => {
    expect(parseFit('{"take": true, "why": "Fits — well.", "help": true}')).toEqual({ take: true, why: "Fits, well.", help: true });
    expect(parseFit('{"take": "yes", "why": "x"}').take).toBe(false);
    expect(parseFit("I think so").take).toBe(false);
    expect(parseFit('{"take": true, "why": "This is what we do - minutes with action items."}').why).toBe("This is what we do, minutes with action items.");
    expect(parseFit('{"take": true, "why": ""}').take).toBe(false);
  });
});

describe("looking for work", () => {
  it("bids on what fits at its own price, declines the rest once, and pays for every check in the books", async () => {
    const { me, b } = startOne();
    const fits = createOpenTask({ fromAgent: poster(), task: "Design a logo for a bakery", capabilities: ["logo"], maxBudget: "0.001 ETH" });
    const mine = createOpenTask({ fromAgent: me, task: "Design my logo", capabilities: ["logo"] });
    const odd = createOpenTask({ fromAgent: poster(), task: "Write a poem about logos", capabilities: ["logo"] });
    const judge: Judge = async (_b, _a, t) => (t.openTaskId === odd.openTaskId ? { fit: { take: false, why: "It is a poem, not a logo.", help: false }, costUsd: 0.0003, model: "m" } : yes(_b, _a, t, CAPS));
    const r = await findWork(b, Date.now(), judge, CAPS);
    expect(r).toMatchObject({ looked: 3, declined: 2, checked: 2, bid: 1 });
    const [bid] = getBidsForOpenTask(fits.openTaskId);
    expect(bid).toMatchObject({ price: "0.0005 ETH", message: "A clean logo for a new shop is exactly its work." });
    const log = decisionsOf(b.businessId);
    expect(log.find((d) => d.subject === mine.openTaskId)?.reason).toMatch(/Its own owner posted this/);
    expect(log.find((d) => d.subject === odd.openTaskId)?.reason).toBe("Does not fit the goal: It is a poem, not a logo.");
    expect(log.find((d) => d.subject === fits.openTaskId)).toMatchObject({ kind: "take", reason: "Bid 0.0005 ETH: A clean logo for a new shop is exactly its work." });
    expect(entriesOf(b.businessId).filter((e) => e.kind === "model").map((e) => e.ref).sort()).toEqual([`check:${fits.openTaskId}`, `check:${odd.openTaskId}`].sort());
    // a second look decides nothing twice and checks nothing again
    let calls = 0;
    const again = await findWork(b, Date.now(), async (...x) => { calls++; return yes(...x); }, CAPS);
    expect(again).toMatchObject({ looked: 0, checked: 0 });
    expect(calls).toBe(0);
    expect(decisionsOf(b.businessId)).toHaveLength(log.length);
  });

  it("keeps to its bids an hour, the checks a look, and the network's checks a day", async () => {
    const { b } = startOne();
    for (let i = 0; i < 5; i++) createOpenTask({ fromAgent: poster(), task: `Logo ${i}`, capabilities: ["logo"] });
    const r = await findWork(b, Date.now(), yes, CAPS);
    expect(r).toMatchObject({ bid: 3, capped: "hour" });
    expect(decisionsOf(b.businessId).filter((d) => d.kind === "cap")).toHaveLength(1);
    const two = startOne();
    for (let i = 0; i < 3; i++) createOpenTask({ fromAgent: poster(), task: `More ${i}`, capabilities: ["logo"] });
    expect(await findWork(two.b, Date.now(), yes, { ...CAPS, checksPerScan: 1 })).toMatchObject({ checked: 1, capped: "scan" });
    const three = startOne();
    expect(await findWork(three.b, Date.now(), yes, { ...CAPS, checksPerDay: 1 })).toMatchObject({ checked: 0, capped: "day" });
  });

  it("does nothing while paused, and a model that does not answer decides nothing", async () => {
    const { b } = startOne();
    createOpenTask({ fromAgent: poster(), task: "Logo", capabilities: ["logo"] });
    expect(await findWork({ ...b, status: "paused" }, Date.now(), yes, CAPS)).toMatchObject({ looked: 0 });
    expect(await findWork(b, Date.now(), async () => { throw new Error("overloaded"); }, CAPS)).toMatchObject({ checked: 0, bid: 0 });
    expect(decisionsOf(b.businessId).filter((d) => d.kind === "take" || d.kind === "decline")).toHaveLength(0);
  });
});

describe("following a bid to the money", () => {
  it("a bid accepted is work won; a job completed is earned at what its payment settled", async () => {
    const { a, b } = startOne();
    const ot = createOpenTask({ fromAgent: poster(), task: "Logo for a bakery", capabilities: ["logo"] });
    await findWork(b, Date.now(), yes, CAPS);
    const [bid] = getBidsForOpenTask(ot.openTaskId);
    const accepted = acceptBid(ot.openTaskId, bid.bidId);
    if (!accepted.success) throw new Error(accepted.error);
    const taskId = accepted.task.taskId;
    expect(followWork(b)).toMatchObject({ won: 1 });
    expect(businessJobOf(taskId)).toEqual({ businessId: b.businessId, team: false });
    // the job finishes and its payment settles: 0.00045 ETH to the agent after the fee
    const db = getDb();
    db.prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, fee_amount, currency, created_at) VALUES (?, ?, 'someone', ?, 0.00045, 'completed', 0, 'ETH', ?)").run(randomUUID(), taskId, a, new Date().toISOString());
    db.prepare("UPDATE tasks SET status = 'completed', output = 'done', completed_at = ? WHERE task_id = ?").run(new Date().toISOString(), taskId);
    expect(followWork(b)).toMatchObject({ done: 1 });
    expect(entriesOf(b.businessId).find((e) => e.kind === "job")).toMatchObject({ amountWei: 450_000_000_000_000n, ref: taskId });
    expect(decisionsOf(b.businessId)[0]).toMatchObject({ kind: "done", reason: "Did the job and earned 0.00045 ETH" });
    expect(followWork(b)).toEqual({ won: 0, lost: 0, done: 0, failed: 0 });
  });

  it("a bid the poster passed over is lost", async () => {
    const { b } = startOne();
    const ot = createOpenTask({ fromAgent: poster(), task: "Logo", capabilities: ["logo"] });
    await findWork(b, Date.now(), yes, CAPS);
    const rival = startOne();
    await findWork(rival.b, Date.now(), yes, CAPS);
    const theirs = getBidsForOpenTask(ot.openTaskId).find((x) => x.agentId === rival.a)!;
    acceptBid(ot.openTaskId, theirs.bidId);
    expect(followWork(b)).toMatchObject({ lost: 1 });
    expect(decisionsOf(b.businessId)[0]).toMatchObject({ kind: "lost", reason: "The poster chose another agent" });
  });
});

describe("hiring help", () => {
  function teamJob(o: Partial<typeof PLAN> = {}) {
    const s = startOne(o);
    const ot = createOpenTask({ fromAgent: poster(), task: "Brand kit", capabilities: ["logo"] });
    const parent = createTask({ fromAgent: poster(), toAgent: s.a, task: "Brand kit: logo and tagline" });
    getDb().prepare("INSERT INTO business_jobs (business_id, open_task_id, bid_id, task_id, status, team, price_wei, created_at, updated_at) VALUES (?, ?, 'bid', ?, 'won', 1, '500000000000000', ?, ?)").run(s.b.businessId, ot.openTaskId, parent.taskId, new Date().toISOString(), new Date().toISOString());
    return { ...s, parent };
  }
  const earn = (agentId: string, eth: number) => getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, fee_amount, currency, created_at, funding_source) VALUES (?, ?, 'x', ?, ?, 'completed', 0, 'ETH', ?, NULL)").run(randomUUID(), randomUUID(), agentId, eth, new Date().toISOString());

  it("runs a business job as a team only when it judged so and may hire", () => {
    const { a, b, parent } = teamJob();
    const agent = getAgentById(a)!;
    expect(businessTeam(agent, parent)).not.toBeNull();
    expect(businessTeam(agent, createTask({ fromAgent: poster(), toAgent: a, task: "other" }))).toBeNull();
    getDb().prepare("UPDATE businesses SET spend_kinds = '' WHERE business_id = ?").run(b.businessId);
    expect(businessTeam(agent, parent)).toBeNull();
    process.env.AGENT_BUSINESS = "off";
    expect(businessTeam(agent, parent)).toBeNull();
  });

  it("hires only verified agents of other owners, never itself", () => {
    const { me, a, b } = teamJob();
    const self = getAgentById(a)!;
    expect(mayHire(b, self, self)).toBe(false);
    expect(mayHire(b, self, getAgentById(agentOf(me))!)).toBe(false);
    expect(mayHire(b, self, getAgentById(agentOf(wallet(), { verified: false }))!)).toBe(false);
    expect(mayHire(b, self, getAgentById(agentOf(poster()))!)).toBe(true);
  });

  it("pays from its earnings within its limits, and every hire is in the books and the log", async () => {
    const { a, b, parent } = teamJob();
    earn(a, 0.01);
    const worker = getAgentById(agentOf(poster(), { price: "0.0005 ETH", name: "Tagline Writer" }))!;
    const hire = await hireFor(b, getAgentById(a)!, parent)(worker, "Write a tagline");
    expect(getTaskById(hire.taskId)).toMatchObject({ fromAgent: a, toAgent: worker.agentId, status: "queued" });
    expect(entriesOf(b.businessId).find((e) => e.kind === "hire")).toMatchObject({ ref: hire.taskId, jobRef: parent.taskId, amountWei: 500_000_000_000_000n });
    expect(decisionsOf(b.businessId)[0]).toMatchObject({ kind: "hire", reason: "Hired Tagline Writer for 0.0005 ETH, paid from its earnings" });
    // a second hire would take the job past its own limit of 0.002 ETH
    const big = getAgentById(agentOf(poster(), { price: "0.0016 ETH", name: "Big Studio" }))!;
    await expect(hireFor(b, getAgentById(a)!, parent, { waitMs: 0 })(big, "Everything")).rejects.toThrow(/past its limit of 0.002 ETH/);
    // refunded hires are voided and give their room back
    getDb().prepare("UPDATE transactions SET status = 'refunded' WHERE task_id = ?").run(hire.taskId);
    expect(syncHires(b)).toBe(1);
    expect(paidOut(b.businessId)).toBe(0n);
  });

  it("asks the owner above their amount and goes on only with their yes", async () => {
    const { me, a, b, parent } = teamJob();
    earn(a, 0.01);
    const worker = getAgentById(agentOf(poster(), { price: "0.001 ETH", name: "Brand Lead" }))!;
    const deps = { waitMs: 5_000, pollMs: 10 };
    const pending = hireFor(b, getAgentById(a)!, parent, deps)(worker, "Lead the brand");
    await new Promise((r) => setTimeout(r, 30));
    const [ask] = listApprovals(me).pending;
    expect(ask).toMatchObject({ appId: "business", appName: "Business", title: "Hire Brand Lead for 0.001 ETH", taskId: parent.taskId });
    decideApproval(me, ask.approvalId, "approve");
    const hire = await pending;
    expect(getTaskById(hire.taskId)?.toAgent).toBe(worker.agentId);
    expect(decisionsOf(b.businessId).map((d) => d.kind).slice(0, 3)).toEqual(["hire", "approved", "ask"]);
    // a no is a no
    const p2 = hireFor(b, getAgentById(a)!, parent, deps)(worker, "Again");
    await new Promise((r) => setTimeout(r, 30));
    decideApproval(me, listApprovals(me).pending[0].approvalId, "decline");
    await expect(p2).rejects.toThrow("the owner did not approve it");
    // no answer in time: the request is cancelled and the part skipped
    await expect(hireFor(b, getAgentById(a)!, parent, { waitMs: 20, pollMs: 5 })(worker, "Late")).rejects.toThrow("the owner did not approve it");
    expect(listApprovals(me).pending).toHaveLength(0);
    expect(listApprovals(me).recent[0].status).toBe("cancelled");
  });

  it("pays from the owner's allowance when its earnings fall short, if the owner gave one", async () => {
    const { a, b, parent } = teamJob();
    const worker = getAgentById(agentOf(poster(), { price: "0.0005 ETH", name: "Tagline Writer" }))!;
    // no earnings and no allowance: the part is skipped
    await expect(hireFor(b, getAgentById(a)!, parent)(worker, "Tagline")).rejects.toThrow(/Insufficient balance/);
    getDb().prepare("UPDATE businesses SET allowance_key_id = 'key-1' WHERE business_id = ?").run(b.businessId);
    const paid: unknown[] = [];
    const pay = async (h: unknown) => { paid.push(h); getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, fee_amount, currency, created_at, funding_source) VALUES (?, ?, ?, ?, 0.0005, 'escrow', 0, 'ETH', ?, 'allowance')").run(randomUUID(), (h as { taskId: string }).taskId, a, worker.agentId, new Date().toISOString()); return { txId: "t", reserveTx: "0xr", token: "eth", amountUnits: 1n }; };
    const hire = await hireFor(getBusiness(b.businessId)!, getAgentById(a)!, parent, { pay })(worker, "Tagline");
    expect(paid[0]).toMatchObject({ taskId: hire.taskId, fromAgent: a, toAgent: worker.agentId, owner: b.ownerWallet, apiKeyId: "key-1" });
    expect(getTaskById(hire.taskId)?.status).toBe("queued");
    expect(decisionsOf(b.businessId)[0].reason).toBe("Hired Tagline Writer for 0.0005 ETH, paid from your allowance");
    // the allowance refusing leaves no job behind
    const refusing = async () => { throw new Error("Your allowance is paused"); };
    await expect(hireFor(getBusiness(b.businessId)!, getAgentById(a)!, parent, { pay: refusing })(worker, "Again")).rejects.toThrow("the allowance did not pay: Your allowance is paused");
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ? AND task = 'Again'").get(worker.agentId) as { n: number }).n).toBe(0);
  });
});



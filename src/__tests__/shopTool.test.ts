// Agents that sell what they make: an agent buys another agent's product as material for a paid job, from its own
// earnings, within the job's budget. The purchase is on both receipts. The tools are called here as the model would
// call them; no model is asked anything.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { addVersion, createSite } from "@/lib/agentSites";
import { listProduct, shopAgentOf } from "@/lib/agentShop";
import { saleReceipt } from "@/lib/shopSales";
import { BUY_TOOL, SEARCH_TOOL, materialBudget, mayShop, setBuying, shopTools, withShop } from "@/lib/shopTool";
import { createTask } from "@/lib/tasks";
import { getAvailableBalance, getAgentBalance } from "@/lib/payments";
import { getPublicReceipt, getReceipt } from "@/lib/receipts";

const saved = { shop: process.env.AGENT_SHOP, sites: process.env.AGENT_SITES };
beforeEach(() => {
  process.env.AGENT_SHOP = "on";
  process.env.AGENT_SITES = "on";
  getDb().exec("DELETE FROM shop_sales; DELETE FROM shop_agents; DELETE FROM shop_products; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_SHOP", saved.shop], ["AGENT_SITES", saved.sites]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
const wallet = () => `0x${(++n + 7_600_000).toString(16).padStart(40, "0")}`;
function agentOf(owner: string, name: string, o: { earnedEth?: number; endpoint?: string } = {}): string {
  const id = `mat-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name, capabilities: ["build"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: owner, createdAt: new Date().toISOString(), ...(o.endpoint ? { endpoint: o.endpoint } : {}) });
  if (o.earnedEth) getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, fee_amount, currency, created_at, settled_at) VALUES (?, ?, 'someone', ?, ?, 'completed', 0, 'ETH', ?, ?)").run(randomUUID(), randomUUID(), id, o.earnedEth, new Date().toISOString(), new Date().toISOString());
  return id;
}
function sells(owner: string, agentId: string, title: string, price: string): string {
  const m = createSite({ taskId: `t-${randomUUID()}`, agentId, ownerMark: `w:${owner}`, title });
  if (!m.ok) throw new Error(m.why);
  addVersion(m.site.siteId, [{ path: "index.html", content: `<h1>${title}</h1><script src="app.js"></script>` }, { path: "app.js", content: "const rate = (y, h) => y / h;" }], { taskId: "t" });
  const r = listProduct({ agentId, wallet: owner, siteId: m.site.siteId, description: "A ready-made calculator to adapt.", price });
  if (!r.ok) throw new Error(r.why);
  return r.product.productId;
}
const tool = (tools: ReturnType<typeof shopTools>, name: string) => tools.find((t) => t.name === name)!;

/** A buyer agent, allowed to buy up to `maxEth` a job, with earnings to pay from, in a paid job of `jobEth`. */
function buyerInJob(o: { maxEth: string; jobEth: string | null; earnedEth?: number }) {
  const me = wallet(), agentId = agentOf(me, "Builder", { earnedEth: o.earnedEth ?? 0.05 });
  expect(setBuying(agentId, me, { on: true, maxEth: o.maxEth }).ok).toBe(true);
  const task = createTask({ fromAgent: wallet(), toAgent: agentId, task: "Build me a rate calculator", ...(o.jobEth ? { payment: `${o.jobEth} ETH` } : {}) });
  return { me, agentId, task };
}

describe("allowing it", () => {
  it("is the owner's, within the network's ceiling for one job", () => {
    const me = wallet(), a = agentOf(me, "Builder");
    expect(setBuying(a, wallet(), { on: true, maxEth: "0.001" })).toEqual({ ok: false, why: "Only the agent's owner can do that." });
    expect(setBuying(a, me, { on: true, maxEth: "0.01" })).toEqual({ ok: false, why: "The highest price is 0.005 ETH." });
    expect(setBuying(a, me, { on: true, maxEth: "0.002" }).ok).toBe(true);
    expect(shopAgentOf(a)!.buy).toEqual({ on: true, maxWei: 2_000_000_000_000_000n });
    expect(setBuying(a, me, { on: false }).ok).toBe(true);
    expect(shopAgentOf(a)!.buy.on).toBe(false);
  });
});

describe("a job's budget", () => {
  it("is the least of the job's price, the owner's most and the network's, less what the job already bought", () => {
    const { agentId, task } = buyerInJob({ maxEth: "0.002", jobEth: "0.01" });
    expect(materialBudget({ agentId, taskId: task.taskId, payment: task.payment })).toBe(2_000_000_000_000_000n);
    const cheap = buyerInJob({ maxEth: "0.004", jobEth: "0.001" });
    expect(materialBudget({ agentId: cheap.agentId, taskId: cheap.task.taskId, payment: cheap.task.payment })).toBe(1_000_000_000_000_000n);
    // a free job has nothing to spend, and the tools are not given
    const free = buyerInJob({ maxEth: "0.004", jobEth: null });
    expect(materialBudget({ agentId: free.agentId, taskId: free.task.taskId, payment: free.task.payment })).toBe(0n);
    expect(mayShop({ agentId: free.agentId }, free.task)).toBe(false);
    expect(mayShop({ agentId }, task)).toBe(true);
    expect(mayShop({ agentId }, task, { viaMcp: true })).toBe(false);
    // nor while the shop is off
    process.env.AGENT_SHOP = "off";
    expect(mayShop({ agentId }, task)).toBe(false);
  });

  it("is nothing for an agent its owner has not allowed", () => {
    const me = wallet(), a = agentOf(me, "Builder", { earnedEth: 1 });
    const task = createTask({ fromAgent: wallet(), toAgent: a, task: "x", payment: "0.01 ETH" });
    expect(mayShop({ agentId: a }, task)).toBe(false);
  });
});

describe("buying material in a job", () => {
  it("finds other agents' products within the budget, never its own", async () => {
    const { me, agentId, task } = buyerInJob({ maxEth: "0.003", jobEth: "0.01" });
    const seller = wallet(), s = agentOf(seller, "Calc Shop");
    sells(seller, s, "Rate calculator", "0.002");
    sells(seller, s, "Pricey calculator", "0.004");
    sells(me, agentId, "My own calculator", "0.001");
    const found = await tool(shopTools({ agentId, taskId: task.taskId, payment: task.payment }), SEARCH_TOOL).run({ query: "calculator" });
    expect(found).toMatch(/^This job may spend up to 0\.003 ETH more\. Products:/);
    expect(found).toContain("Rate calculator, 0.002 ETH, by Calc Shop");
    expect(found).not.toContain("Pricey");
    expect(found).not.toContain("My own");
  });

  it("pays from the agent's earnings, hands back the files, and goes on both receipts", async () => {
    const { agentId, task } = buyerInJob({ maxEth: "0.003", jobEth: "0.01", earnedEth: 0.05 });
    const seller = wallet(), s = agentOf(seller, "Calc Shop");
    const productId = sells(seller, s, "Rate calculator", "0.002");
    const tools = shopTools({ agentId, taskId: task.taskId, payment: task.payment, traceId: task.traceId });
    const got = await tool(tools, BUY_TOOL).run({ product_id: productId });
    expect(got).toMatch(/^Bought "Rate calculator" from Calc Shop for 0\.002 ETH\. Its fingerprint: [0-9a-f]{64}\. It is on this job's receipt\./);
    expect(got).toContain("--- app.js ---\nconst rate = (y, h) => y / h;");
    // the money: out of the buyer's balance, into the seller's earnings
    expect(getAvailableBalance(agentId)).toBeCloseTo(0.048, 9);
    expect(getAgentBalance(s).totalEarned).toBe(0.002);
    // both receipts
    const pub = getPublicReceipt(task.taskId)!;
    expect(pub.materials).toEqual([expect.objectContaining({ title: "Rate calculator", seller: { agentId: s, name: "Calc Shop" }, price: "0.002 ETH", status: "delivered", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    expect(getReceipt(task.taskId).materials).toEqual(pub.materials);
    const sale = saleReceipt(pub.materials![0].saleId)!;
    expect(sale).toMatchObject({ forTaskId: task.taskId, buyer: { id: agentId, kind: "agent", name: "Builder" }, status: "delivered" });
    // and on the job's record
    const ev = getDb().prepare("SELECT kind, to_agent, output_hash FROM trace_events WHERE task_id = ? AND kind = 'material.bought'").get(task.taskId) as { kind: string; to_agent: string; output_hash: string } | undefined;
    expect(ev).toMatchObject({ to_agent: s, output_hash: sale.product.fingerprint });
    // a job that bought nothing reads as it always did
    expect(getPublicReceipt(createTask({ fromAgent: wallet(), toAgent: s, task: "y" }).taskId)!.materials).toBeUndefined();
  });

  it("refuses what is over the budget, what it already has, and its own", async () => {
    const { me, agentId, task } = buyerInJob({ maxEth: "0.003", jobEth: "0.01" });
    const seller = wallet(), s = agentOf(seller, "Calc Shop");
    const two = sells(seller, s, "Rate calculator", "0.002");
    const another = sells(seller, s, "Tip calculator", "0.002");
    const mine = sells(me, agentId, "My own", "0.001");
    const buy = tool(shopTools({ agentId, taskId: task.taskId, payment: task.payment }), BUY_TOOL);
    expect(await buy.run({ product_id: mine })).toBe("Error: that is your own product.");
    expect(await buy.run({ product_id: "nope" })).toMatch(/^Error: there is no such product/);
    expect(await buy.run({ product_id: two })).toMatch(/^Bought/);
    expect(await buy.run({ product_id: two })).toBe("Error: you already have that product.");
    // 0.003 a job, 0.002 spent: the next one is over
    expect(await buy.run({ product_id: another })).toBe("Error: it costs 0.002 ETH, and this job may spend 0.001 ETH more.");
  });

  it("buys nothing when the agent's earnings cannot pay", async () => {
    const { agentId, task } = buyerInJob({ maxEth: "0.003", jobEth: "0.01", earnedEth: 0.001 });
    const seller = wallet(), s = agentOf(seller, "Calc Shop");
    const productId = sells(seller, s, "Rate calculator", "0.002");
    expect(await tool(shopTools({ agentId, taskId: task.taskId, payment: task.payment }), BUY_TOOL).run({ product_id: productId })).toMatch(/^Error: Insufficient balance/);
    expect(getDb().prepare("SELECT COUNT(*) n FROM shop_sales").get()).toEqual({ n: 0 });
    expect(getAgentBalance(s).totalEarned).toBe(0);
  });

  it("adds the tools once", () => {
    const { agentId, task } = buyerInJob({ maxEth: "0.003", jobEth: "0.01" });
    const t = shopTools({ agentId, taskId: task.taskId, payment: task.payment });
    const once = withShop(null, t);
    expect(withShop(once, t).localTools.map((x) => x.name)).toEqual([SEARCH_TOOL, BUY_TOOL]);
    expect(once.grants).toEqual(["shop"]);
  });
});

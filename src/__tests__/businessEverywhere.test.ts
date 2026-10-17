// Agents that run their own business, everywhere: Mylo writes a start down for the owner to confirm on a card, reads
// how a business does and pauses or stops one; an assistant over MCP reads and manages, and gets a link to start one
// itself. No model is asked anything.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { myloToolDefs, runTool } from "@/lib/myloTools";
import { TOOLS } from "@/lib/myloPolicy";
import { myloBusinessNote } from "@/lib/myloBusiness";
import { confirmAction, getAction, refreshAction } from "@/lib/myloActions";
import { startConversation } from "@/lib/myloStore";
import { businessOfAgent } from "@/lib/business";
import { mcpTools } from "@/lib/mcpServer";
import { POST as mcpPOST } from "@/app/mcp/route";

const saved = process.env.AGENT_BUSINESS;
beforeEach(() => {
  process.env.AGENT_BUSINESS = "on";
  getDb().exec("DELETE FROM businesses; DELETE FROM business_decisions; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_BUSINESS; else process.env.AGENT_BUSINESS = saved;
});

let n = 0;
function owner() {
  const w = `0x${(++n + 8_900_000).toString(16).padStart(40, "0")}`;
  const { apiKey } = createApiKey(w);
  const agentId = `ev-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId, name: "Logo Smith", capabilities: ["logo"], publicKey: `pk-${agentId}`, provider: "anthropic", reputation: 0, walletAddress: w, price: "0.0005 ETH", createdAt: new Date().toISOString() });
  return { w: w.toLowerCase(), apiKey, agentId };
}
const ctx = (w: string | null) => { const o = w ?? "guest:x"; return { wallet: w, owner: o, conversationId: startConversation(o, "t").id }; };
const LIMITS = { budget_eth: "0.01", max_per_day_eth: "0.004", max_per_job_eth: "0.002", ask_above_eth: "0.001", price_min_eth: "0.0002", price_max_eth: "0.002", spend_on: ["hire"] };

describe("Mylo", () => {
  it("has the tools, with rules, only while businesses are on", () => {
    for (const t of ["start_business", "my_businesses", "manage_business"]) expect(TOOLS[t]).toBeDefined();
    expect(TOOLS.start_business).toMatchObject({ confirm: true, spends: true });
    expect(myloToolDefs().map((t) => t.name)).toEqual(expect.arrayContaining(["start_business", "my_businesses", "manage_business"]));
    expect(myloBusinessNote()).not.toMatch(/[—–]/);
    process.env.AGENT_BUSINESS = "off";
    expect(myloToolDefs().map((t) => t.name)).not.toContain("start_business");
    expect(myloBusinessNote()).toBe("");
  });

  it("writes a start down for the owner, starts it only when they confirm, then reads and stops it", async () => {
    const o = owner(), c = ctx(o.w);
    expect((await runTool("start_business", { agent_id: o.agentId, goal: "Logos", ...LIMITS }, c)).result).toEqual({ error: "Say the goal in a sentence of up to 300 characters." });
    expect((await runTool("start_business", { agent_id: o.agentId, goal: "Run a logo studio for new shops", ...LIMITS, max_per_job_eth: "1" }, c)).result).toMatchObject({ error: "The most on one job cannot be above the most a day." });
    const other = owner();
    expect((await runTool("start_business", { agent_id: other.agentId, goal: "Run a logo studio for new shops", ...LIMITS }, c)).result).toEqual({ error: "Only the agent's owner can do that." });
    const p = await runTool("start_business", { agent_id: o.agentId, goal: "Run a logo studio for new shops", ...LIMITS }, c);
    expect(p.actionId).toBeTruthy();
    expect((p.result as { summary: string }).summary).toBe('Start Logo Smith on its own business: "Run a logo studio for new shops". It may spend 0.01 ETH in all, at most 0.004 ETH a day and 0.002 ETH on one job, and asks you above 0.001 ETH, on: hire.');
    expect(businessOfAgent(o.agentId)).toBeNull(); // nothing starts before the card is confirmed
    const done = await confirmAction(p.actionId!, c.owner, o.w, { method: "wallet", clientIp: "1.1.1.1" });
    expect(typeof done === "string" ? done : done.status).toBe("running");
    const biz = businessOfAgent(o.agentId)!;
    expect(biz).toMatchObject({ status: "active", goal: "Run a logo studio for new shops" });
    const r = refreshAction(p.actionId!, c.owner);
    expect(typeof r === "string" ? r : r.message?.content).toMatch(/runs its own business now/);
    expect(getAction(p.actionId!, c.owner)?.status).toBe("done");

    const mine = (await runTool("my_businesses", {}, c)).result as { businesses: { business_id: string; status: string; total: { earned: string } }[] };
    expect(mine.businesses[0]).toMatchObject({ business_id: biz.businessId, status: "active", total: { earned: "0 ETH" } });
    expect((await runTool("manage_business", { business_id: biz.businessId, action: "pause" }, ctx(owner().w))).result).toMatchObject({ error: "There is no such business of yours." });
    expect((await runTool("manage_business", { business_id: biz.businessId, action: "stop" }, c)).result).toEqual({ done: "stop", status: "stopped" });
  });

  it("needs a wallet", async () => {
    expect((await runTool("my_businesses", {}, ctx(null))).result).toMatchObject({ error: expect.stringMatching(/Sign in with your wallet/) });
  });
});

describe("MCP", () => {
  async function call(name: string, args: Record<string, unknown>, key?: string) {
    const req = new NextRequest("https://axon-agents.com/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const json = (await (await mcpPOST(req)).json()) as { result: { content: { text: string }[] } };
    return JSON.parse(json.result.content[0].text) as Record<string, unknown>;
  }
  const LIM = { budgetEth: "0.01", maxPerDayEth: "0.004", maxPerJobEth: "0.002", approveAboveEth: "0.001", priceMinEth: "0.0002", priceMaxEth: "0.002", spendOn: ["hire"] };

  it("lists the tools only while businesses are on", () => {
    expect(mcpTools().map((t) => t.name)).toEqual(expect.arrayContaining(["list_businesses", "start_business", "manage_business"]));
    process.env.AGENT_BUSINESS = "off";
    expect(mcpTools().map((t) => t.name)).not.toContain("start_business");
  });

  it("never starts one: it checks and gives the owner a link with the form filled in", async () => {
    const o = owner();
    expect(await call("start_business", { agentId: o.agentId, goal: "Run a logo studio", ...LIM })).toMatchObject({ error: expect.stringMatching(/needs an Axon key/) });
    expect(await call("start_business", { agentId: o.agentId, goal: "Run a logo studio", ...LIM, maxPerDayEth: "1" }, o.apiKey)).toMatchObject({ error: "The most a day cannot be above the budget." });
    const r = await call("start_business", { agentId: o.agentId, goal: "Run a logo studio", ...LIM }, o.apiKey);
    expect(String(r.confirm)).toMatch(new RegExp(`/dashboard\\?business=${o.agentId}&goal=Run\\+a\\+logo\\+studio&budget=0.01.*#business$`));
    expect(businessOfAgent(o.agentId)).toBeNull();
  });

  it("reads and manages the owner's businesses through the routes", async () => {
    const o = owner(), c = ctx(o.w);
    const p = await runTool("start_business", { agent_id: o.agentId, goal: "Run a logo studio for new shops", ...LIMITS }, c);
    await confirmAction(p.actionId!, c.owner, o.w, { method: "wallet", clientIp: "1.1.1.1" });
    const listed = await call("list_businesses", {}, o.apiKey) as { businesses: { businessId: string }[] };
    expect(listed.businesses).toHaveLength(1);
    const id = listed.businesses[0].businessId;
    expect(await call("manage_business", { businessId: id, action: "pause" }, owner().apiKey)).toMatchObject({ error: "There is no such business of yours." });
    expect(await call("manage_business", { businessId: id, action: "pause" }, o.apiKey)).toMatchObject({ business: { status: "paused" } });
  });
});

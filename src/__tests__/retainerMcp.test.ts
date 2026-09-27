// Retainers from an assistant: the four MCP tools, through the real MCP endpoint and the real
// /api/retainers routes, with the keys an assistant actually holds.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

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
import { runDueRetainers, settleRetainerRuns } from "@/lib/retainerRunner";
import { POST as mcpPost } from "@/app/mcp/route";
import { GET as toolsList } from "@/app/api/tools/route";
import type { Agent } from "@/sdk/types";

const wallet = () => `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;

function agent(): string {
  const a: Agent = {
    agentId: `rm-${randomUUID().slice(0, 8)}`,
    name: "MCP Retainer Agent",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: wallet(),
    provider: "anthropic",
    price: "0.00015 ETH",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a.agentId;
}

async function mcp(name: string, args: Record<string, unknown>, key: string | null) {
  const res = await mcpPost(new NextRequest("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  const json = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
  return { isError: json.result.isError, body: JSON.parse(json.result.content[0].text) as Record<string, unknown> };
}

const daily = { kind: "daily", time: "08:00", timeZone: "America/New_York" };

let owner: string;
let paid: string;
beforeEach(() => {
  getTier.mockResolvedValue({ tier: { name: "base", rank: 0, minimum: 0 }, balance: 0, stale: false });
  owner = wallet();
  paid = agent();
});

describe("retainers over MCP", () => {
  it("an assistant with an allowance key schedules an agent, lists it, reads its runs, and cancels it", async () => {
    const { apiKey } = createAllowanceKey(owner, { label: "Claude" }) as { apiKey: string };

    const made = await mcp("schedule_agent", { agentId: paid, instructions: "Morning market brief.", schedule: daily }, apiKey);
    expect(made.isError).toBe(false);
    const r = made.body.retainer as { retainerId: string; scheduleText: string; createdByKey: boolean; nextRunAt: string };
    expect(r).toMatchObject({ scheduleText: "Every day at 08:00 (America/New York)", createdByKey: true });
    expect(made.body.note).toMatch(/Scheduled: Every day at 08:00/);

    const listed = await mcp("list_retainers", {}, apiKey);
    expect((listed.body.retainers as { retainerId: string; latest: unknown }[]).map((x) => x.retainerId)).toEqual([r.retainerId]);
    expect(listed.body.limits).toMatchObject({ inUse: 1, active: expect.any(Number), fastestHours: expect.any(Number) });

    // One run, completed, then read back the way an assistant would answer "what did it say?"
    getDb().prepare(`UPDATE retainers SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE retainer_id != ? AND status = 'active'`).run(r.retainerId);
    await runDueRetainers(Date.parse(r.nextRunAt));
    const taskId = (getDb().prepare(`SELECT task_id FROM retainer_runs WHERE retainer_id = ?`).get(r.retainerId) as { task_id: string }).task_id;
    getDb().prepare(`UPDATE tasks SET status = 'completed', output = 'S&P futures up 0.4%.' WHERE task_id = ?`).run(taskId);
    settleRetainerRuns();
    const runs = await mcp("get_retainer_runs", { retainerId: r.retainerId }, apiKey);
    expect((runs.body.runs as { output: string }[])[0].output).toBe("S&P futures up 0.4%.");
    const latest = await mcp("list_retainers", {}, apiKey);
    expect((latest.body.retainers as { latest: { output: string } }[])[0].latest.output).toBe("S&P futures up 0.4%.");

    expect((await mcp("manage_retainer", { retainerId: r.retainerId, action: "pause" }, apiKey)).body.retainer).toMatchObject({ status: "paused" });
    expect((await mcp("manage_retainer", { retainerId: r.retainerId, action: "resume" }, apiKey)).body.retainer).toMatchObject({ status: "active" });
    expect((await mcp("manage_retainer", { retainerId: r.retainerId, action: "cancel" }, apiKey)).body.retainer).toMatchObject({ status: "cancelled" });
  });

  it("refusals come back in words, as tool errors", async () => {
    const key = createApiKey(owner).apiKey;
    const tooFast = await mcp("schedule_agent", { agentId: paid, instructions: "x", schedule: { kind: "interval", everyHours: 1 } }, key);
    expect(tooFast.isError).toBe(true);
    expect(tooFast.body.error).toMatch(/hourly/);
    const bad = await mcp("manage_retainer", { retainerId: "ret_x", action: "explode" }, key);
    expect(bad.body.error).toMatch(/pause, resume or cancel/);
  });

  it("needs a key, and a key sees only its own retainers", async () => {
    expect((await mcp("list_retainers", {}, null)).body.error).toMatch(/needs an Axon key|need an Axon key/);
    const ownerKey = createApiKey(owner).apiKey;
    const byOwner = (await mcp("schedule_agent", { agentId: paid, instructions: "Owner's", schedule: daily }, ownerKey)).body.retainer as { retainerId: string };
    const { apiKey: assistant } = createAllowanceKey(owner, {}) as { apiKey: string };
    expect((await mcp("list_retainers", {}, assistant)).body.retainers).toEqual([]);
    expect((await mcp("get_retainer_runs", { retainerId: byOwner.retainerId }, assistant)).body.error).toMatch(/not found/);
    expect((await mcp("manage_retainer", { retainerId: byOwner.retainerId, action: "cancel" }, assistant)).body.error).toMatch(/not found/);
    const stranger = createApiKey(wallet()).apiKey;
    expect((await mcp("manage_retainer", { retainerId: byOwner.retainerId, action: "cancel" }, stranger)).body.error).toMatch(/not found/);
  });

  it("the function-calling door offers the same tools", async () => {
    const res = await toolsList(new NextRequest("http://localhost/api/tools?format=openai"));
    const text = JSON.stringify(await res.json());
    for (const t of ["schedule_agent", "list_retainers", "get_retainer_runs", "manage_retainer"]) expect(text).toContain(t);
  });
});

// Autonomy 3, "its own budget": the network's chores paid from an allowance, with the chain and the payment faked.
// Nothing here sends a transaction or calls a model.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { createAllowanceKey } from "@/lib/allowanceKeys";
import { AllowancePaymentError, type AllowanceHire } from "@/lib/allowancePayment";
import { getTaskById } from "@/lib/tasks";
import { recentJobs, tick } from "@/lib/autonomy3";
import { upkeepTurn, paidChoreAgent, UPKEEP } from "@/lib/autonomy3Upkeep";
import { payForChore, budgetHolder, budgetState, closeStale, BUDGET, BUDGET_KEY_ENV, type Pay } from "@/lib/autonomy3Budget";
import { startJob } from "@/lib/autonomy3";
import "@/lib/autonomy3Parts";
import type { Agent } from "@/sdk/types";

const WALLET = "0x00000000000000000000000000000000000b0d6e";
const NOW = Date.parse("2026-10-14T01:00:00Z");
const MILLI = 1_000_000_000_000_000n; // 0.001 ETH
const saved = { ...process.env };
let key = "";
let keyId = "";

function agent(id: string, caps: string[], extra: Partial<Agent> = {}) {
  createAgent({ agentId: id, name: `Agent ${id}`, capabilities: caps, publicKey: `pk-${id}`, provider: "anthropic", reputation: 5, createdAt: "2026-10-01T00:00:00Z", ...extra } as Agent, { describe: false });
}

/** The allowance payment, faked: what a successful reservation writes, and every call counted. */
function fakePay(calls: AllowanceHire[], refuse?: string): Pay {
  return async (h) => {
    calls.push(h);
    if (refuse) throw new AllowancePaymentError(refuse);
    const wei = BigInt(Math.round(Number(h.priceString.replace(/\s*ETH$/i, "")) * 1e18));
    const txId = `tx-${calls.length}`;
    const db = getDb();
    db.prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, funding_source) VALUES (?, ?, ?, ?, ?, 'escrow', ?, 0, 'ETH', ?, 'allowance')")
      .run(txId, h.taskId, h.fromAgent, h.toAgent, Number(wei) / 1e18, `0xreserve${calls.length}`, new Date(NOW).toISOString());
    db.prepare("INSERT INTO allowance_reservations (task_id, tx_id, owner, token, task_key, agent_key, amount_units, reserve_tx, state, created_at, api_key_id, eth_wei) VALUES (?, ?, ?, '0x0', ?, '0xagent', ?, ?, 'reserved', ?, ?, ?)")
      .run(h.taskId, txId, h.owner, `0xkey${calls.length}`, wei.toString(), `0xreserve${calls.length}`, new Date(NOW).toISOString(), h.apiKeyId ?? null, wei.toString());
    return { txId, reserveTx: `0xreserve${calls.length}`, token: "0x0", amountUnits: wei };
  };
}

const env = (more: Record<string, string> = {}) => ({ AUTONOMY3: "on", AUTONOMY3_UPKEEP: "on", AUTONOMY3_BUDGET: "on", [BUDGET_KEY_ENV]: key, ...more });

beforeEach(() => {
  const db = getDb();
  for (const t of ["tasks", "agents", "agent_capabilities", "autonomy3_jobs", "transactions", "allowance_reservations", "allowance_key_limits", "api_keys"]) db.exec(`DELETE FROM ${t}`);
  agent("writer", ["writing", "summarization"]);
  agent("paid-writer", ["writing"], { price: "0.001 ETH" });
  agent("dear-writer", ["writing"], { price: "0.01 ETH" });
  agent("remote-writer", ["writing"], { price: "0.0005 ETH", endpoint: "https://example.com/agent" });
  const k = createAllowanceKey(WALLET, { label: "the network", maxPerTaskWei: 2n * MILLI, maxPerDayWei: 5n * MILLI });
  key = k.apiKey;
  keyId = k.keyId;
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("its own budget: who holds it", () => {
  it("is the wallet of an allowance key, as an assistant would hold it; a full key or a revoked one is no budget", () => {
    expect(budgetHolder(env())).toMatchObject({ keyId, wallet: WALLET });
    expect(budgetHolder({})).toBeNull();
    const full = createApiKey(WALLET);
    expect(budgetHolder({ [BUDGET_KEY_ENV]: full.apiKey })).toBeNull();
    getDb().prepare("DELETE FROM api_keys WHERE key_id = ?").run(keyId);
    expect(budgetHolder(env())).toBeNull();
  });

  it("picks a paid agent that runs on Axon, within the per-task limit", () => {
    expect(paidChoreAgent("report", [], 2n * MILLI)?.agentId).toBe("paid-writer");
    expect(paidChoreAgent("report", ["paid-writer"], 2n * MILLI)).toBeNull(); // dear-writer is over, remote-writer is on its own server
    expect(paidChoreAgent("report", [], 20n * MILLI)?.agentId).toMatch(/paid-writer|dear-writer/);
  });
});

describe("its own budget: paying for a chore", () => {
  it("hires a paid agent for the chore, paid once from the allowance through the allowance path, with a receipt", async () => {
    const calls: AllowanceHire[] = [];
    const hired = (await upkeepTurn(NOW, env(), fakePay(calls)))!;
    expect(hired).toMatchObject({ chore: "report", agentId: "paid-writer", paid: true });
    expect(calls).toEqual([{ taskId: hired.taskId, fromAgent: UPKEEP.hirer, toAgent: "paid-writer", owner: WALLET, priceString: "0.001 ETH", apiKeyId: keyId }]);
    const t = getTaskById(hired.taskId)!;
    expect(t).toMatchObject({ status: "queued", payment: "0.001 ETH", fromAgent: UPKEEP.hirer });
    expect(t.context).toMatchObject({ source: UPKEEP.source, automated: true, chore: "report" });
    expect(recentJobs(5, "budget")[0]).toMatchObject({ outcome: "paid", subject: "report:2026-10-14", detail: { taskId: hired.taskId, agentId: "paid-writer", txId: "tx-1", receipt: `/r/${hired.taskId}` } });
    expect(recentJobs(5, "upkeep")[0]).toMatchObject({ subject: hired.taskId });
    const s = budgetState(NOW, env());
    expect(s).toMatchObject({ on: true, set: true, wallet: WALLET, spentToday: "0.001 ETH", leftToday: "0.004 ETH", perTask: "0.002 ETH", perDay: "0.005 ETH" });
    expect(s.payments).toEqual([expect.objectContaining({ agent: "Agent paid-writer", price: "0.001 ETH", chore: "daily report", receipt: `/r/${hired.taskId}` })]);
  });

  it("falls back to a free agent when the budget is empty, and the record notes why; the tick does not fail", async () => {
    const calls: AllowanceHire[] = [];
    const hired = (await upkeepTurn(NOW, env(), fakePay(calls, "Your allowance has 0 ETH available, this hire needs 0.001 ETH")))!;
    expect(calls).toHaveLength(1);
    expect(hired).toMatchObject({ chore: "report", agentId: "writer", paid: false });
    expect(getTaskById(hired.taskId)!.payment).toBeUndefined();
    expect(getDb().prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 1 }); // the refused paid job is gone
    expect(recentJobs(5, "budget")[0]).toMatchObject({ outcome: "fell-back", summary: expect.stringMatching(/free agent.*0 ETH available/) });
    expect(budgetState(NOW, env()).lastFellBack?.summary).toMatch(/0 ETH available/);
    getDb().exec("DELETE FROM autonomy3_jobs; DELETE FROM tasks");
    const r = await tick(NOW, env({ [BUDGET_KEY_ENV]: "axon_not-a-key" }));
    expect(r.failed).toEqual([]);
    expect(recentJobs(5, "budget")[0]).toMatchObject({ outcome: "fell-back", summary: expect.stringMatching(/no budget is set/) });
    expect(recentJobs(5, "upkeep")).toHaveLength(1);
  });

  it("falls back when no paid agent fits the per-task limit, or the key expired, without trying to pay", async () => {
    getDb().exec("DELETE FROM agents WHERE agent_id = 'paid-writer'");
    const calls: AllowanceHire[] = [];
    expect((await upkeepTurn(NOW, env(), fakePay(calls)))).toMatchObject({ agentId: "writer", paid: false });
    expect(calls).toHaveLength(0);
    expect(recentJobs(5, "budget")[0].summary).toMatch(/no paid agent for it within 0.002 ETH/);
    getDb().prepare("UPDATE allowance_key_limits SET expires_at = ? WHERE key_id = ?").run(new Date(NOW - 1).toISOString(), keyId);
    expect(await payForChore({ choreKey: "review:x", chore: "second opinion", pick: () => null, task: "t", context: {}, hirer: UPKEEP.hirer }, NOW, env(), fakePay(calls))).toBeNull();
    expect(recentJobs(5, "budget")[0].summary).toMatch(/expired/);
  });

  it("never pays twice for one chore", async () => {
    const calls: AllowanceHire[] = [];
    const chore = { choreKey: "review:weak-1", chore: "second opinion", pick: (max: bigint) => paidChoreAgent("report", [], max), task: "Review this", context: { source: UPKEEP.source }, hirer: UPKEEP.hirer };
    const [a, b] = await Promise.all([payForChore(chore, NOW, env(), fakePay(calls)), payForChore(chore, NOW, env(), fakePay(calls))]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await payForChore(chore, NOW, env(), fakePay(calls))).toBeNull();
    expect(calls).toHaveLength(1);
    // and a refused chore is not paid on a later try either
    const refused = { ...chore, choreKey: "review:weak-2" };
    expect(await payForChore(refused, NOW, env(), fakePay(calls, "Your allowance is paused"))).toBeNull();
    expect(await payForChore(refused, NOW, env(), fakePay(calls))).toBeNull();
    expect(calls).toHaveLength(2);
    expect(getDb().prepare("SELECT COUNT(*) n FROM allowance_reservations").get()).toEqual({ n: 1 });
  });

  it("does nothing while switched off: chores go to free agents as before, and nothing is recorded or paid", async () => {
    const calls: AllowanceHire[] = [];
    expect(await upkeepTurn(NOW, env({ AUTONOMY3_BUDGET: "off" }), fakePay(calls))).toMatchObject({ agentId: "writer", paid: false });
    expect(calls).toHaveLength(0);
    expect(recentJobs(5, "budget")).toHaveLength(0);
  });

  it("closes a payment its worker left open", () => {
    startJob("budget", "report:lost", NOW - (BUDGET.staleMinutes + 1) * 60_000);
    expect(closeStale(NOW)).toBe(1);
    expect(recentJobs(5, "budget")[0]).toMatchObject({ outcome: "interrupted" });
  });
});

// Mylo, phase 4: the person's own agents, earnings, withdrawals and better versions. The payout and the improvement
// decision are stand-ins (no ETH moves); the agents, earnings and Mylo's records are real rows.
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { runTool, MYLO_TOOL_DEFS } from "@/lib/myloTools";
import { studio, confirmAction, refreshAction, getAction, type WithdrawDetail, type CreateTask } from "@/lib/myloActions";
import { startConversation } from "@/lib/myloStore";
import { TOOLS, toolGate } from "@/lib/myloPolicy";
import { WITHDRAW } from "@/lib/studioPolicy";
import type { Agent } from "@/sdk/types";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "a")}`;
const ctx = (w: string | null) => { const owner = w ?? "guest:x"; return { wallet: w, owner, conversationId: startConversation(owner, "t").id }; };
const noTask: CreateTask = async () => { throw new Error("no hire here"); };

function myAgent(w: string, name: string, studioAgent = true): Agent {
  n++;
  const a = createAgent({ agentId: `mine-${n}`, name, capabilities: ["notes"], publicKey: `pk-mine-${n}`, provider: "anthropic", reputation: 0, category: "Content", price: "0.001 ETH", walletAddress: w, description: "Writes notes", createdAt: new Date().toISOString() } as Agent);
  if (studioAgent) getDb().prepare("UPDATE agents SET studio_build = ?, studio_score = 8.1 WHERE agent_id = ?").run(randomUUID(), a.agentId);
  return a;
}
function earn(agentId: string, eth: number) {
  getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at) VALUES (?, ?, 'buyer', ?, ?, 'completed', ?, 0, 'ETH', ?, ?)")
    .run(randomUUID(), randomUUID(), agentId, eth, `0x${randomUUID().replace(/-/g, "")}`, new Date().toISOString(), new Date().toISOString());
}
function proposeBetter(agentId: string, w: string): string {
  const id = randomUUID(), at = new Date().toISOString();
  getDb().prepare("INSERT INTO studio_improvements (id, agent_id, wallet, build_id, status, weak_jobs, from_score, to_score, instructions, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, agentId, w.toLowerCase(), randomUUID(), "proposed", 3, 7.2, 8.4, "Better instructions.", at, at);
  return id;
}

beforeEach(() => {
  studio.withdraw = async () => { throw new Error("not expected"); };
  studio.decideImprovement = () => { throw new Error("not expected"); };
});

describe("Mylo and your own agents", () => {
  it("has the tools in its policy: reading is free, taking money out and applying wait for an OK, all need a wallet", () => {
    for (const d of MYLO_TOOL_DEFS) expect(TOOLS[d.name]).toBeTruthy();
    expect(toolGate("withdraw_earnings", true)).toEqual({ ok: true, confirm: true });
    expect(toolGate("apply_improvement", true)).toEqual({ ok: true, confirm: true });
    expect(toolGate("my_agents", true)).toEqual({ ok: true, confirm: false });
    for (const t of ["my_agents", "my_earnings", "withdraw_earnings", "apply_improvement"]) expect(toolGate(t, false).ok).toBe(false);
  });

  it("lists your agents with their remixes, better versions waiting and token launch, and nobody else's", async () => {
    const w = wallet(), a = myAgent(w, "Notes Writer"), other = myAgent(wallet(), "Not Mine");
    const remix = myAgent(wallet(), "Notes Writer Remix");
    getDb().prepare("UPDATE agents SET remix_of = ? WHERE agent_id = ?").run(a.agentId, remix.agentId);
    const better = proposeBetter(a.agentId, w);
    const out = await runTool("my_agents", {}, ctx(w));
    const rows = (out.result as { agents: { agent_id: string; remixes: { name: string }[]; better_version_waiting: { improvement_id: string }[]; token_launch: unknown }[] }).agents;
    expect(rows.map((r) => r.agent_id)).toEqual([a.agentId]);
    expect(rows[0].remixes.map((r) => r.name)).toEqual(["Notes Writer Remix"]);
    expect(rows[0].better_version_waiting[0].improvement_id).toBe(better);
    expect(rows[0].token_launch).toBeTruthy();
    expect(JSON.stringify(out.result)).not.toContain(other.agentId);
    expect(out.card).toMatchObject({ kind: "agents", title: "Your agents" });
  });

  it("shows what your Studio agents earned and can take out", async () => {
    const w = wallet(), a = myAgent(w, "Earner"), b = myAgent(w, "Earner Two");
    earn(a.agentId, 0.004); earn(a.agentId, 0.002); earn(b.agentId, 0.001);
    const out = await runTool("my_earnings", {}, ctx(w));
    expect(out.result).toMatchObject({ total_can_withdraw_eth: 0.007, rules: { least_eth: WITHDRAW.minEth, to: "only the wallet that owns the agent" } });
    expect(out.card).toMatchObject({ kind: "earnings", availableEth: 0.007 });
  });

  it("withdraws only on your OK, only to the wallet that owns the agent, within what it can take out", async () => {
    const w = wallet(), c = ctx(w), a = myAgent(w, "Payer");
    earn(a.agentId, 0.005);
    expect((await runTool("withdraw_earnings", { agent_id: a.agentId, amount_eth: 0.01 }, c)).result).toMatchObject({ error: expect.stringMatching(/less than that/) });
    expect((await runTool("withdraw_earnings", { agent_id: a.agentId, amount_eth: WITHDRAW.minEth / 2 }, c)).result).toMatchObject({ error: expect.stringMatching(/least/) });
    expect((await runTool("withdraw_earnings", { agent_id: a.agentId }, ctx(wallet()))).result).toMatchObject({ error: expect.stringMatching(/isn't one of your Studio agents/) });
    const out = await runTool("withdraw_earnings", { agent_id: a.agentId }, c);
    expect(getAction(out.actionId!, w)).toMatchObject({ kind: "withdraw", status: "proposed", detail: { amountEth: 0.005, to: w } });
    const tx = `0x${"ab".repeat(32)}`;
    studio.withdraw = async (agentId, who, eth) => { expect([agentId, who, eth]).toEqual([a.agentId, w, 0.005]); return { id: "w1", agentId, wallet: w, amountEth: "0.005", status: "sent", txHash: tx, error: null, createdAt: "" }; };
    const sent = await confirmAction(out.actionId!, c.owner, w, { method: "wallet", clientIp: "x" }, noTask);
    expect(sent).toMatchObject({ status: "running", detail: { txHash: tx, sent: "sent" } });
    const done = refreshAction(out.actionId!, c.owner) as { action: { status: string }; message: { content: string } };
    expect(done.action.status).toBe("done");
    expect(done.message.content).toMatch(/Sent 0\.005 ETH that \*\*Payer\*\* earned to your wallet 0x/);
  });

  it("says plainly when the payout doesn't go through, and that nothing left the earnings", async () => {
    const w = wallet(), c = ctx(w), a = myAgent(w, "Shorted");
    earn(a.agentId, 0.003);
    const out = await runTool("withdraw_earnings", { agent_id: a.agentId }, c);
    studio.withdraw = async () => "Withdrawals are paused just now. Your earnings are safe and still yours.";
    const r = await confirmAction(out.actionId!, c.owner, w, { method: "wallet", clientIp: "x" }, noTask);
    expect(r).toMatchObject({ status: "failed" });
    expect((r as { detail: WithdrawDetail }).detail.error).toMatch(/paused/);
  });

  it("applies a better version only on your OK, and only one Axon proposed for your own agent", async () => {
    const w = wallet(), c = ctx(w), a = myAgent(w, "Improver");
    const better = proposeBetter(a.agentId, w);
    expect((await runTool("apply_improvement", { improvement_id: better }, ctx(wallet()))).result).toMatchObject({ error: expect.stringMatching(/no open improvement/) });
    const out = await runTool("apply_improvement", { improvement_id: better }, c);
    expect(getAction(out.actionId!, w)).toMatchObject({ kind: "improve", status: "proposed", detail: { name: "Improver", fromScore: 7.2, toScore: 8.4 } });
    studio.decideImprovement = (id, who, apply) => { expect([id, who, apply]).toEqual([better, w, true]); return { ok: true }; };
    expect(await confirmAction(out.actionId!, c.owner, w, { method: "wallet", clientIp: "x" }, noTask)).toMatchObject({ status: "running" });
    const done = refreshAction(out.actionId!, c.owner) as { message: { content: string } };
    expect(done.message.content).toMatch(/\*\*Improver\*\* now runs the better version, which tested 8\.4\/10/);
  });
});

// Agents that hire people, everywhere: Mylo writes a task down for the owner to post on a card and says how theirs go;
// an assistant over MCP posts one with the owner's key, follows it and answers a proof; anyone reads the board. No model
// is asked anything: the rules check is a stand-in.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));
vi.mock("@/lib/peopleCheck", async (orig) => ({ ...(await orig<typeof import("@/lib/peopleCheck")>()), realRulesJudge: () => async () => ({ ok: true }) }));

import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { myloToolDefs, runTool } from "@/lib/myloTools";
import { TOOLS } from "@/lib/myloPolicy";
import { myloPeopleNote } from "@/lib/myloPeople";
import { confirmAction, getAction, refreshAction } from "@/lib/myloActions";
import { startConversation } from "@/lib/myloStore";
import { getPeopleTask, tasksOfOwner } from "@/lib/people";
import { mcpTools } from "@/lib/mcpServer";
import { POST as mcpPOST } from "@/app/mcp/route";

const saved = process.env.AGENT_PEOPLE;
beforeEach(() => {
  process.env.AGENT_PEOPLE = "on";
  getDb().exec("DELETE FROM people_tasks; DELETE FROM people_events; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  if (saved === undefined) delete process.env.AGENT_PEOPLE; else process.env.AGENT_PEOPLE = saved;
});

let n = 0;
function owner() {
  const w = `0x${(++n + 9_950_000).toString(16).padStart(40, "0")}`;
  const { apiKey } = createApiKey(w);
  const agentId = `pev-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId, name: "Field Scout", capabilities: ["research"], publicKey: `pk-${agentId}`, provider: "anthropic", reputation: 0, walletAddress: w, price: "0.0005 ETH", createdAt: new Date().toISOString() });
  getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at) VALUES (?, ?, 'someone', ?, 0.001, 'completed', NULL, 0, 'ETH', ?, ?)")
    .run(randomUUID(), randomUUID(), agentId, new Date().toISOString(), new Date().toISOString());
  return { w: w.toLowerCase(), apiKey, agentId };
}
const ctx = (w: string | null) => { const o = w ?? "guest:x"; return { wallet: w, owner: o, conversationId: startConversation(o, "t").id }; };
const TASK = { title: "Call Lumen Books and ask about Sunday hours", details: "Call Lumen Books on Harbour Street and ask whether they are open on Sundays, and until when.", proof: "answer", checks: ["Says whether they open on Sundays", "Gives the closing time"] };

describe("Mylo", () => {
  it("has the tools, with rules, only while tasks for people are on", () => {
    expect(TOOLS.hire_a_person).toMatchObject({ confirm: true, spends: true, wallet: true });
    expect(TOOLS.my_people_tasks).toMatchObject({ spends: false });
    expect(myloToolDefs().map((t) => t.name)).toEqual(expect.arrayContaining(["hire_a_person", "my_people_tasks"]));
    expect(myloPeopleNote()).not.toMatch(/[—–]/);
    process.env.AGENT_PEOPLE = "off";
    expect(myloToolDefs().map((t) => t.name)).not.toContain("hire_a_person");
    expect(myloPeopleNote()).toBe("");
  });

  it("writes a task down for the owner, posts it only when they confirm, then says how it goes", async () => {
    const o = owner(), c = ctx(o.w);
    expect((await runTool("hire_a_person", { agent_id: o.agentId, ...TASK, pay_eth: "5" }, c)).result).toEqual({ error: "A task pays at most 0.01 ETH." });
    expect((await runTool("hire_a_person", { agent_id: owner().agentId, ...TASK, pay_eth: "0.0001" }, c)).result).toEqual({ error: "Only the agent's owner can do that." });
    const p = await runTool("hire_a_person", { agent_id: o.agentId, ...TASK, pay_eth: "0.0001" }, c);
    expect((p.result as { summary: string }).summary).toBe('Post a task for people for Field Scout: "Call Lumen Books and ask about Sunday hours", paying 0.0001 ETH from its earnings for a short answer that shows 2 things.');
    expect(tasksOfOwner(o.w)).toHaveLength(0);
    const done = await confirmAction(p.actionId!, c.owner, o.w, { method: "wallet", clientIp: "1.1.1.1" });
    expect(typeof done === "string" ? done : done.status).toBe("running");
    const [t] = tasksOfOwner(o.w);
    expect(t).toMatchObject({ status: "open", lockState: "held", proofKind: "answer" });
    const r = refreshAction(p.actionId!, c.owner);
    expect(typeof r === "string" ? r : r.message?.content).toMatch(/is on the \[board for people\]/);
    expect(getAction(p.actionId!, c.owner)?.status).toBe("done");
    const mine = (await runTool("my_people_tasks", {}, c)).result as { tasks: { title: string; status: string }[] };
    expect(mine.tasks[0]).toMatchObject({ title: TASK.title, status: "open" });
    expect((await runTool("my_people_tasks", {}, ctx(null))).result).toMatchObject({ error: expect.stringMatching(/Sign in with your wallet/) });
  });
});

describe("MCP", () => {
  async function call(name: string, args: Record<string, unknown>, key?: string) {
    const req = new NextRequest("https://axon-agents.com/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const json = (await (await mcpPOST(req)).json()) as { result: { content: { text: string }[] } };
    return JSON.parse(json.result.content[0].text) as Record<string, unknown>;
  }

  it("lists the tools only while tasks for people are on", () => {
    expect(mcpTools().map((t) => t.name)).toEqual(expect.arrayContaining(["hire_a_person", "list_people_tasks", "decide_people_task"]));
    process.env.AGENT_PEOPLE = "off";
    expect(mcpTools().map((t) => t.name)).not.toContain("hire_a_person");
  });

  it("posts with the owner's key, reads the board without one, and cancels", async () => {
    const o = owner();
    expect(await call("hire_a_person", { agentId: o.agentId, ...TASK, priceEth: "0.0001" })).toMatchObject({ error: expect.stringMatching(/needs an Axon key/) });
    expect(await call("hire_a_person", { agentId: o.agentId, ...TASK, priceEth: "0.0001" }, owner().apiKey)).toMatchObject({ error: "Only the agent's owner can do that." });
    const made = await call("hire_a_person", { agentId: o.agentId, ...TASK, priceEth: "0.0001" }, o.apiKey) as { task: { taskId: string; status: string } };
    expect(made.task.status).toBe("open");
    const board = await call("list_people_tasks", {}) as { tasks: { taskId: string }[] };
    expect(board.tasks.map((t) => t.taskId)).toContain(made.task.taskId);
    expect(JSON.stringify(board)).not.toContain(o.w.slice(2));
    const mine = await call("list_people_tasks", {}, o.apiKey) as { posted: { taskId: string }[] };
    expect(mine.posted.map((t) => t.taskId)).toEqual([made.task.taskId]);
    expect(await call("decide_people_task", { taskId: made.task.taskId, action: "cancel" }, o.apiKey)).toMatchObject({ task: { status: "cancelled" } });
    expect(getPeopleTask(made.task.taskId)?.lockState).toBe("returned");
  });
});

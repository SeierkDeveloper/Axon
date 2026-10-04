// Mylo, phase 2: tools, the tool loop, and hires that only run when the person confirms them.
import { describe, it, expect } from "vitest";
import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { runTurn, type MyloEvent, type Streamer, type Block } from "@/lib/myloChat";
import { runTool, agentCard, forModel, MYLO_TOOL_DEFS } from "@/lib/myloTools";
import { proposeHire, confirmAction, refreshAction, cancelAction, getAction, staleHires, PROPOSAL_MINUTES, CONFIRM_GRACE_MINUTES, TASK_CHARS, type CreateTask } from "@/lib/myloActions";
import { historyOf, startConversation } from "@/lib/myloStore";
import { TOOLS, TURN_BUDGET } from "@/lib/myloPolicy";
import type { Agent } from "@/sdk/types";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "d")}`;
function agent(over: Partial<Agent> = {}): Agent {
  n++;
  const a: Agent = { agentId: `mylo-agent-${n}`, name: `Changelog Writer ${n}`, capabilities: ["release notes", "writing"], publicKey: `pk-mylo-${n}`, provider: "anthropic", reputation: 0, category: "Content", price: "0.0004 ETH", description: "Turns a changelog into release notes", createdAt: new Date().toISOString(), ...over } as Agent;
  createAgent(a);
  return a;
}
const ctx = (w: string | null) => { const owner = w ?? "guest:x"; return { wallet: w, owner, conversationId: startConversation(owner, "t").id }; };
const TX = (i: number) => `0x${i.toString(16).padStart(64, "a")}`;

describe("Mylo's tools", () => {
  it("covers exactly the tools the policy knows, and gives the model schemas", () => {
    for (const d of MYLO_TOOL_DEFS) expect(TOOLS[d.name]).toBeTruthy();
    expect(forModel({ big: "x".repeat(TURN_BUDGET.toolResultChars + 100) }).endsWith("…(cut)")).toBe(true);
  });

  it("finds agents by what they do, within a price, and shows them as a card", async () => {
    const a = agent({ name: "Zebra Release Notes", capabilities: ["zebra release notes"] });
    agent({ name: "Zebra Pricey", capabilities: ["zebra release notes"], price: "0.5 ETH" });
    const out = await runTool("search_agents", { query: "zebra release notes", max_price_eth: 0.01 }, ctx(null));
    const names = (out.card as { agents: { name: string }[] }).agents.map((x) => x.name);
    expect(names).toContain(a.name);
    expect(names).not.toContain("Zebra Pricey");
    expect(out.label).toBe("Searching the network");
  });

  it("reads one agent and compares several, from public facts only", async () => {
    const a = agent(), b = agent({ price: undefined });
    const d = await runTool("agent_details", { agent_id: a.agentId }, ctx(null));
    expect(d.result).toMatchObject({ agentId: a.agentId, priceEth: 0.0004, page: `/agents/${a.agentId}` });
    expect(JSON.stringify(d.result)).not.toContain("publicKey");
    const c = await runTool("compare_agents", { agent_ids: [a.agentId, b.agentId] }, ctx(null));
    expect(c.card).toMatchObject({ kind: "compare" });
    expect(agentCard(b)).toMatchObject({ priceEth: null, price: "Free" });
    expect((await runTool("compare_agents", { agent_ids: [a.agentId] }, ctx(null))).result).toMatchObject({ error: expect.any(String) });
  });

  it("will not set up a hire for someone not signed in", async () => {
    const out = await runTool("hire_agent", { agent_id: agent().agentId, task: "do it" }, ctx(null));
    expect(out.result).toMatchObject({ error: expect.stringMatching(/Sign in/) });
    expect(out.actionId).toBeUndefined();
  });
});

describe("a hire Mylo proposes", () => {
  it("is only written down: nothing is hired until the person confirms", async () => {
    const w = wallet(), a = agent();
    const out = await runTool("hire_agent", { agent_id: a.agentId, task: "Write release notes for v2.4" }, ctx(w));
    expect(out.actionId).toBeTruthy();
    const act = getAction(out.actionId!, w)!;
    expect(act).toMatchObject({ status: "proposed", wallet: w, task: "Write release notes for v2.4" });
    expect(act.hires[0]).toMatchObject({ agentId: a.agentId, priceEth: 0.0004, taskId: null });
    expect(getDb().prepare("SELECT COUNT(*) n FROM tasks WHERE to_agent = ?").get(a.agentId)).toEqual({ n: 0 });
  });

  it("refuses a missing agent, a task too long, and more than three agents", () => {
    const c = ctx(wallet());
    expect(proposeHire(c, ["no-such-agent"], "x y z")).toMatch(/no agent/);
    expect(proposeHire(c, [agent().agentId], "x".repeat(TASK_CHARS + 1))).toMatch(/under/);
    expect(proposeHire(c, [agent().agentId, agent().agentId, agent().agentId, agent().agentId], "task")).toMatch(/two or three/);
  });

  it("runs once, as proposed, paid from the person's wallet, and only for that wallet", async () => {
    const w = wallet(), a = agent(), c = ctx(w);
    const p = proposeHire(c, [a.agentId], "Write release notes") as { id: string };
    const sent: Record<string, unknown>[] = [];
    const create: CreateTask = async (body) => { sent.push(body); return { status: 201, json: { taskId: `task-${n}` }, replay: false }; };
    expect(await confirmAction(p.id, c.owner, wallet(), { method: "wallet", payments: { [a.agentId]: TX(1) }, clientIp: "1.2.3.4" }, create)).toMatch(/another wallet/);
    const done = await confirmAction(p.id, c.owner, w, { method: "wallet", payments: { [a.agentId]: TX(1) }, clientIp: "1.2.3.4" }, create);
    expect(done).toMatchObject({ status: "running" });
    expect(sent).toEqual([{ to: a.agentId, task: "Write release notes", from: "anonymous", paymentSignature: TX(1), payerWallet: w }]);
    expect(await confirmAction(p.id, c.owner, w, { method: "wallet", payments: { [a.agentId]: TX(1) }, clientIp: "1.2.3.4" }, create)).toMatch(/already running/);
    expect(sent).toHaveLength(1);
  });

  it("does not run unpaid, on a reused payment, after its price moved, or once it has waited too long", async () => {
    const w = wallet(), c = ctx(w);
    const ok: CreateTask = async () => ({ status: 201, json: { taskId: "t" }, replay: false });
    const a = agent();
    const unpaid = proposeHire(c, [a.agentId], "task") as { id: string };
    expect(await confirmAction(unpaid.id, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, ok)).toMatchObject({ status: "failed", hires: [{ error: "Not paid." }] });
    const reused = proposeHire(c, [a.agentId], "task") as { id: string };
    expect(await confirmAction(reused.id, c.owner, w, { method: "wallet", payments: { [a.agentId]: TX(2) }, clientIp: "x" }, async () => ({ status: 200, json: { taskId: "someone-elses" }, replay: true }))).toMatchObject({ status: "failed", hires: [{ error: expect.stringMatching(/already used/) }] });
    const moved = proposeHire(c, [a.agentId], "task") as { id: string };
    expect(staleHires(getAction(moved.id, c.owner)!)).toEqual([]);
    getDb().prepare("UPDATE agents SET price = '0.9 ETH' WHERE agent_id = ?").run(a.agentId);
    // the page asks this before anyone pays, so a moved price stops it before money moves
    expect(staleHires(getAction(moved.id, c.owner)!)).toEqual([a.name]);
    expect(await confirmAction(moved.id, c.owner, w, { method: "wallet", payments: { [a.agentId]: TX(3) }, clientIp: "x" }, ok)).toMatchObject({ hires: [{ error: expect.stringMatching(/price changed/) }] });
    const old = proposeHire(c, [agent().agentId], "task") as { id: string };
    // just past the deadline, a confirmation already on its way still lands; well past it, it doesn't
    const late = proposeHire(c, [agent().agentId], "task") as { id: string };
    getDb().prepare("UPDATE mylo_actions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), late.id);
    expect(await confirmAction(late.id, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, ok)).toMatchObject({ status: "failed" });
    getDb().prepare("UPDATE mylo_actions SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - (CONFIRM_GRACE_MINUTES + 1) * 60_000).toISOString(), old.id);
    expect(await confirmAction(old.id, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, ok)).toMatch(/waited too long/);
    expect(PROPOSAL_MINUTES).toBe(15);
    const cancelled = proposeHire(c, [agent().agentId], "task") as { id: string };
    expect(cancelAction(cancelled.id, c.owner)).toMatchObject({ status: "cancelled" });
    expect(await confirmAction(cancelled.id, c.owner, w, { method: "wallet", payments: {}, clientIp: "x" }, ok)).toMatch(/already cancelled/);
  });

  it("pays from the allowance with the person's own key, once per hire, and a free agent needs no payment", async () => {
    const w = wallet(), c = ctx(w), paid = agent(), free = agent({ price: undefined });
    const calls: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const create: CreateTask = async (body, headers) => { calls.push({ body, headers }); return { status: 201, json: { taskId: `tk-${calls.length}-${n}` }, replay: false }; };
    const p = proposeHire(c, [paid.agentId, free.agentId], "Compare these") as { id: string };
    const r = await confirmAction(p.id, c.owner, w, { method: "allowance", apiKey: "user-key", clientIp: "x" }, create);
    expect(r).toMatchObject({ status: "running" });
    expect(calls[0]).toMatchObject({ body: { from: w, paymentMethod: "allowance" }, headers: { "x-api-key": "user-key", "Idempotency-Key": `mylo:${p.id}:${paid.agentId}` } });
    expect(calls[1].body).toMatchObject({ from: "anonymous" });
    expect(calls[1].body.paymentSignature).toBeUndefined();
  });

  it("writes the answers into the conversation once every agent has finished, and only once", async () => {
    const w = wallet(), c = ctx(w), a = agent(), b = agent();
    const ids: string[] = [];
    const create: CreateTask = async () => { const id = `real-${n}-${ids.length}`; ids.push(id); getDb().prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at) VALUES (?,?,?,?,?,?)").run(id, "anonymous", "x", "t", "running", new Date().toISOString()); return { status: 201, json: { taskId: id }, replay: false }; };
    const p = proposeHire(c, [a.agentId, b.agentId], "Summarise") as { id: string };
    await confirmAction(p.id, c.owner, w, { method: "wallet", payments: { [a.agentId]: TX(10), [b.agentId]: TX(11) }, clientIp: "x" }, create);
    expect((refreshAction(p.id, c.owner) as { message: unknown }).message).toBeNull();
    getDb().prepare("UPDATE tasks SET status = 'completed', output = 'Answer A' WHERE task_id = ?").run(ids[0]);
    getDb().prepare("UPDATE tasks SET status = 'failed', error = 'timed out' WHERE task_id = ?").run(ids[1]);
    const done = refreshAction(p.id, c.owner) as { action: { status: string }; message: { content: string } };
    expect(done.action.status).toBe("done");
    expect(done.message.content).toMatch(/side by side/);
    expect(done.message.content).toContain("Answer A");
    expect(done.message.content).toMatch(/couldn't finish: timed out/);
    expect((refreshAction(p.id, c.owner) as { message: unknown }).message).toBeNull();
    expect(historyOf(c.conversationId, 10).filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(refreshAction(p.id, "someone-else")).toMatch(/No such/);
  });
});

describe("a turn with tools", () => {
  it("searches, shows the card, then answers in words, with the face working in between", async () => {
    const w = wallet();
    agent({ name: "Quokka Notes", capabilities: ["quokka notes"] });
    let call = 0;
    const model: Streamer = async (args, onText) => {
      call++;
      if (call === 1) { onText("Let me look."); return { blocks: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "u1", name: "search_agents", input: { query: "quokka notes" } }] as Block[], stop: "tool_use" }; }
      expect(JSON.stringify(args.messages.at(-1))).toContain("tool_result");
      onText("Quokka Notes looks right.");
      return { blocks: [{ type: "text", text: "Quokka Notes looks right." }], stop: "end_turn" };
    };
    const ev: MyloEvent[] = [];
    await runTurn({ owner: w, wallet: w, speaker: "base", text: "find me quokka notes" }, (e) => ev.push(e), model);
    expect(ev.filter((e) => e.type === "face").map((e) => (e as { state: string }).state)).toEqual(["thinking", "talking", "working", "talking", "happy"]);
    expect(ev.find((e) => e.type === "tool")).toMatchObject({ name: "search_agents", label: "Searching the network" });
    expect(ev.find((e) => e.type === "card")).toMatchObject({ card: { kind: "agents" } });
    const conv = (ev[0] as { id: string }).id;
    const saved = historyOf(conv, 5).at(-1)!;
    expect(saved.content).toBe("Let me look.\n\nQuokka Notes looks right.");
    expect(saved.meta).toMatchObject({ cards: [{ kind: "agents" }] });
  });

  it("stops calling tools after the limit and still ends in words", async () => {
    const w = wallet();
    let calls = 0, lastHadTools = true;
    const model: Streamer = async (args) => {
      calls++;
      lastHadTools = args.tools;
      if (args.tools) return { blocks: [{ type: "tool_use", id: `u${calls}`, name: "network_pulse", input: {} }] as Block[], stop: "tool_use" };
      return { blocks: [{ type: "text", text: "Done looking." }], stop: "end_turn" };
    };
    const ev: MyloEvent[] = [];
    await runTurn({ owner: w, wallet: w, speaker: "base", text: "pulse forever" }, (e) => ev.push(e), model);
    expect(calls).toBe(TURN_BUDGET.toolCalls + 1);
    expect(lastHadTools).toBe(false);
    expect(ev.at(-1)).toMatchObject({ type: "done" });
  });

  it("shows a proposal to the page the moment Mylo makes it", async () => {
    const w = wallet(), a = agent();
    let call = 0;
    const model: Streamer = async () => (++call === 1
      ? { blocks: [{ type: "tool_use", id: "h1", name: "hire_agent", input: { agent_id: a.agentId, task: "Release notes for v3" } }] as Block[], stop: "tool_use" }
      : { blocks: [{ type: "text", text: "I've set that up. Confirm it to pay and start." }], stop: "end_turn" });
    const ev: MyloEvent[] = [];
    await runTurn({ owner: w, wallet: w, speaker: "base", text: "hire it" }, (e) => ev.push(e), model);
    const act = ev.find((e) => e.type === "action") as Extract<MyloEvent, { type: "action" }>;
    expect(act.action).toMatchObject({ status: "proposed", task: "Release notes for v3", hires: [{ agentId: a.agentId, priceEth: 0.0004 }] });
    expect(act.action.summary).toMatch(/0.0004 ETH/);
  });
});

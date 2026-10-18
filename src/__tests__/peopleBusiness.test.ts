// Agents that hire people, for an agent running its own business: the tool it uses in a job, its business's limits and
// its owner's OK, and the books. No model and no chain.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { createAgent, getAgentById } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import { createTask } from "@/lib/tasks";
import { decideApproval, listApprovals } from "@/lib/appPermissions";
import { decisionsOf, startBusiness, type Business } from "@/lib/business";
import { entriesOf, paidOut } from "@/lib/businessLedger";
import { getPeopleTask, cancelPeopleTask, type RulesJudge } from "@/lib/people";
import { peopleBusiness, peopleTool, withPeople, PEOPLE_TOOL } from "@/lib/peopleTool";
import { runPeopleTick, settleApprovals, syncBusinessBooks } from "@/lib/peopleRun";

const saved = { people: process.env.AGENT_PEOPLE, biz: process.env.AGENT_BUSINESS };
beforeEach(() => {
  process.env.AGENT_PEOPLE = "on";
  process.env.AGENT_BUSINESS = "on";
  getDb().exec("DELETE FROM people_tasks; DELETE FROM people_events; DELETE FROM people_payouts; DELETE FROM businesses; DELETE FROM business_ledger; DELETE FROM business_decisions; DELETE FROM app_approvals; DELETE FROM rate_limit_windows;");
});
afterEach(() => {
  for (const [k, v] of [["AGENT_PEOPLE", saved.people], ["AGENT_BUSINESS", saved.biz]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

let n = 0;
const ok: RulesJudge = async () => ({ ok: true });
function owned(spendOn: string[]) {
  const me = `0x${(++n + 9_900_000).toString(16).padStart(40, "0")}`;
  const id = `pbz-${n}-${randomUUID().slice(0, 6)}`;
  createAgent({ agentId: id, name: "Shop Scout", capabilities: ["research"], publicKey: `pk-${id}`, provider: "anthropic", reputation: 0, walletAddress: me, price: "0.0005 ETH", createdAt: new Date().toISOString() });
  createApiKey(me);
  getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at) VALUES (?, ?, 'someone', ?, 0.01, 'completed', NULL, 0, 'ETH', ?, ?)")
    .run(randomUUID(), randomUUID(), id, new Date().toISOString(), new Date().toISOString());
  const r = startBusiness(me, { agentId: id, goal: "Check shop details for online listings", budgetEth: "0.01", maxPerDayEth: "0.004", maxPerJobEth: "0.002", approveAboveEth: "0.0005", spendOn, priceMinEth: "0.0002", priceMaxEth: "0.002" });
  if (!r.ok) throw new Error(r.why);
  return { me, agentId: id, business: r.business };
}
const ARGS = { title: "Photograph the opening hours of Lumen Books", details: "Go to Lumen Books on Harbour Street and photograph the sign with the opening hours on the door.", proof: "photo", checks: ["The opening hours can be read"], pay_eth: "0.0002" };
/** The tool in one of the agent's real jobs: an owner's OK is asked about a job the agent is doing. */
const tool = (agentId: string, b: Business) => peopleTool({ agentId, taskId: createTask({ fromAgent: "someone", toAgent: agentId, task: "List the shop" }).taskId, business: b, judge: ok });
const taskIdIn = (s: string) => /Task (pt_[A-Za-z0-9_-]+)/.exec(s)?.[1] ?? null;

describe("a business that may hire people", () => {
  it("can only be set to while tasks for people are on, and only then gets the tool", () => {
    process.env.AGENT_PEOPLE = "off";
    expect(() => owned(["people"])).toThrow("What it may spend on is a list of: hire, material, model.");
    process.env.AGENT_PEOPLE = "on";
    const a = owned(["hire"]), b = owned(["people"]);
    expect(peopleBusiness(getAgentById(a.agentId)!)).toBeNull();
    expect(peopleBusiness(getAgentById(b.agentId)!)?.businessId).toBe(b.business.businessId);
    expect(peopleBusiness(getAgentById(b.agentId)!, { viaMcp: true })).toBeNull();
    const t = withPeople(null, tool(b.agentId, b.business));
    expect(t.localTools.map((x) => x.name)).toEqual([PEOPLE_TOOL]);
    expect(withPeople(t, tool(b.agentId, b.business)).localTools).toHaveLength(1);
  });

  it("posts a task within its limits, paid from its earnings, as a line in its books", async () => {
    const { agentId, business } = owned(["people"]);
    const said = await tool(agentId, business).run(ARGS);
    const id = taskIdIn(said)!;
    expect(said).toContain("Posted");
    expect(getPeopleTask(id)).toMatchObject({ status: "open", lockState: "held", postedBy: "agent", businessId: business.businessId });
    expect(paidOut(business.businessId)).toBe(2n * 10n ** 14n);
    expect(entriesOf(business.businessId)[0]).toMatchObject({ kind: "hire", ref: id });
    expect(decisionsOf(business.businessId)[0].reason).toContain("Posted a task for people for 0.0002 ETH");
    // it came back unused: the line is voided and the room is back
    cancelPeopleTask(id, getPeopleTask(id)!.ownerWallet);
    expect(syncBusinessBooks()).toBe(1);
    expect(paidOut(business.businessId)).toBe(0n);
  });

  it("refuses past its limits, and asks the owner above their amount; a yes opens the task, a no closes it", async () => {
    const { me, agentId, business } = owned(["people"]);
    expect(await tool(agentId, business).run({ ...ARGS, pay_eth: "0.003" })).toMatch(/^Error: .*limit of 0.002 ETH/);
    const asked = await tool(agentId, business).run({ ...ARGS, pay_eth: "0.001" });
    expect(asked).toContain("Asked your owner's OK");
    const waiting = getDb().prepare("SELECT task_id FROM people_tasks WHERE status = 'approval'").get() as { task_id: string };
    expect(getPeopleTask(waiting.task_id)).toMatchObject({ lockState: "none" });
    const pending = listApprovals(me).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0].title).toContain("Hire a person for 0.001 ETH");
    decideApproval(me, pending[0].approvalId, "approve");
    expect(settleApprovals()).toEqual({ opened: 1, refused: 0 });
    expect(getPeopleTask(waiting.task_id)).toMatchObject({ status: "open", lockState: "held" });
    syncBusinessBooks();
    expect(paidOut(business.businessId)).toBe(10n ** 15n);

    await tool(agentId, business).run({ ...ARGS, pay_eth: "0.001" });
    const second = getDb().prepare("SELECT task_id FROM people_tasks WHERE status = 'approval'").get() as { task_id: string };
    decideApproval(me, listApprovals(me).pending[0].approvalId, "decline");
    expect(settleApprovals()).toEqual({ opened: 0, refused: 1 });
    expect(getPeopleTask(second.task_id)).toMatchObject({ status: "cancelled", lockState: "none" });
    expect(decisionsOf(business.businessId).some((d) => d.reason.startsWith("You said no to hiring a person"))).toBe(true);
  });

  it("does nothing in the worker while tasks for people are off", async () => {
    process.env.AGENT_PEOPLE = "off";
    expect(await runPeopleTick()).toEqual({ opened: 0, refused: 0, timedOut: 0, expired: 0, paidOnSilence: 0, checked: 0, sent: 0 });
  });
});

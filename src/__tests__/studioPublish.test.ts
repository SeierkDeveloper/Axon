import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/lib/embeddings")>()),
  generateEmbedding: async () => null,
  embedQuery: async () => null,
  semanticSearchAgents: async () => null,
  scheduleAgentEmbedding: () => {},
}));
vi.mock("@/lib/holderTier", async (orig) => ({
  ...(await orig<typeof import("@/lib/holderTier")>()),
  getTier: async () => ({ tier: { name: "operator", minimum: 0, rank: 3 }, balance: 0, stale: false }),
}));

import { randomUUID } from "crypto";
import { getDb } from "@/lib/db";
import { getAgentById } from "@/lib/agents";
import { releasePayment } from "@/lib/payments";
import { getInstructions } from "@/lib/agentKnowledge";
import { startDraft, getBuild } from "@/lib/studioDraft";
import { runBuild, type Models } from "@/lib/studioTest";
import { publishBuild, remixAgent, studioInfo, remixSplit } from "@/lib/studioPublish";
import { REMIX_SHARE_BPS } from "@/lib/studioPolicy";

let n = 0;
const wallet = () => `0x${(++n + 7_700_000).toString(16).padStart(40, "0")}`;
const DRAFT = (name: string) => ({
  name, handle: name.toLowerCase().replace(/ /g, "-"), category: "Finance",
  description: "Turns any earnings call into five bullets.", capabilities: ["earnings analysis"],
  instructions: "You turn an earnings call transcript into exactly five bullets for investors, revenue first, guidance quoted exactly.",
  model: "claude-sonnet-5", tools: [],
});
const TASKS = JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ task: `Summarise call ${i}: revenue rose 12%...`, lookFor: "five bullets" })));
const scoring = (score: number): Models => ({
  tasks: async () => TASKS,
  answer: async () => "an answer",
  grade: async () => JSON.stringify({ score, feedback: "fine" }),
  rewrite: async () => "<instructions>Rewritten instructions that are long enough to be tested as a real version of the agent.</instructions>",
});

async function tested(me: string, name: string, score: number) {
  const b = await startDraft(me, "An agent that turns any earnings call into a five bullet brief", async () => JSON.stringify(DRAFT(name)));
  if (typeof b === "string") throw new Error(b);
  await runBuild(b.id, scoring(score));
  return b.id;
}

describe("publishing a Studio build", () => {
  it("puts the tested agent live, owned by its builder, at their price, with its instructions and score", async () => {
    const me = wallet();
    const id = await tested(me, `Brief ${n}`, 9);
    const r = publishBuild(id, me, 0.0003);
    expect(typeof r).toBe("object");
    const agentId = (r as { agentId: string }).agentId;
    const a = getAgentById(agentId)!;
    expect(a.walletAddress?.toLowerCase()).toBe(me);
    expect(a.price).toBe("0.0003 ETH");
    expect(a.providerModel).toBe("claude-sonnet-5");
    expect(getInstructions(agentId)).toContain("five bullets");
    expect(studioInfo(agentId)).toMatchObject({ score: 9, buildId: id, remixOf: null });
    expect(getBuild(id)!.status).toBe("published");
    expect(publishBuild(id, me)).toMatch(/already live/);
  });

  it("keeps a weak build a draft, and nobody else can publish yours", async () => {
    const me = wallet();
    const weak = await tested(me, `Weak ${n}`, 4);
    expect(publishBuild(weak, me)).toMatch(/score of 6/);
    const good = await tested(me, `Good ${n}`, 8);
    expect(publishBuild(good, wallet())).toMatch(/No such build/);
    expect(publishBuild(good, me, 50)).toMatch(/price between/);
  });
});

describe("remixing a Studio agent", () => {
  it("copies a live agent into someone else's build, tested before it can go live, and pays the original 10% of every hire", async () => {
    const maker = wallet();
    const original = (publishBuild(await tested(maker, `Original ${n}`, 9), maker) as { agentId: string }).agentId;
    expect(remixAgent(original, maker)).toMatch(/your own agent/);

    const fan = wallet();
    const rb = remixAgent(original, fan);
    expect(typeof rb).toBe("object");
    const build = rb as Exclude<typeof rb, string>;
    expect(build.status).toBe("drafted");
    expect(build.draft!.name).toContain("Remix");
    expect(publishBuild(build.id, fan)).toMatch(/Test the agent/);

    await runBuild(build.id, scoring(8));
    const remix = (publishBuild(build.id, fan) as { agentId: string }).agentId;
    expect(studioInfo(remix)?.remixOf).toBe(original);
    expect(remixSplit(remix, "t")!.map((s) => s.shareBps)).toEqual([10_000 - REMIX_SHARE_BPS, REMIX_SHARE_BPS]);

    // a hire of the remix settles 90% to it and 10% to the original
    const taskId = randomUUID();
    getDb().prepare(`INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at) VALUES (?, ?, ?, ?, ?, 'escrow', NULL, 0, 'ETH', ?)`)
      .run(randomUUID(), taskId, "buyer-x", remix, 0.001, new Date().toISOString());
    releasePayment(taskId);
    const paid = (agent: string) => (getDb().prepare("SELECT COALESCE(SUM(amount_eth),0) v FROM transactions WHERE task_id = ? AND to_agent = ? AND status = 'completed'").get(taskId, agent) as { v: number }).v;
    expect(paid(remix)).toBeCloseTo(0.0009, 12);
    expect(paid(original)).toBeCloseTo(0.0001, 12);
  });

  it("only remixes agents built in Studio", () => {
    expect(remixAgent("research-agent", wallet())).toMatch(/Only agents built in Agent Studio/);
    expect(remixSplit("research-agent", "t")).toBeNull();
  });
});

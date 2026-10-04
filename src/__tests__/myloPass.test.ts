// Mylo, phase 5: what Mylo notices, said in public and told to the person it concerns. Every event lands once; demo
// jobs (no payment) are never called hires; the public feed names nobody.
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { runMyloPass } from "@/lib/myloPass";
import { feed, inboxOf, unreadCount, startConversation } from "@/lib/myloStore";
import { runTool } from "@/lib/myloTools";
import { GET as feedGET } from "@/app/api/mylo/feed/route";
import type { Agent } from "@/sdk/types";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "9")}`;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

function agent(w: string | null, name: string, extra: Record<string, unknown> = {}): Agent {
  n++;
  const a = createAgent({ agentId: `pass-${n}`, name, capabilities: ["x"], publicKey: `pk-pass-${n}`, provider: "anthropic", reputation: 0, category: "Content", price: "0.001 ETH", walletAddress: w ?? undefined, createdAt: ago(600) } as Agent);
  for (const [k, v] of Object.entries(extra)) getDb().prepare(`UPDATE agents SET ${k} = ? WHERE agent_id = ?`).run(v, a.agentId);
  return a;
}
function task(to: string, status: "completed" | "failed", paid: boolean, error: string | null = null): string {
  const id = randomUUID();
  getDb().prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, status, error, created_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "buyer-agent", to, "private task text that must never be shown", status, error, ago(30), ago(20), ago(19.5));
  if (paid) getDb().prepare("INSERT INTO transactions (tx_id, task_id, from_agent, to_agent, amount_eth, status, incoming_signature, fee_amount, currency, created_at, settled_at) VALUES (?,?,?,?,?,?,?,0,'ETH',?,?)")
    .run(randomUUID(), id, "buyer-agent", to, 0.0006, status === "completed" ? "completed" : "refunded", `0x${randomUUID().replace(/-/g, "")}`, ago(30), ago(19));
  return id;
}

beforeEach(() => { delete process.env.MYLO; getDb().prepare("DELETE FROM mylo_feed").run(); });

describe("what Mylo notices", () => {
  it("says a paid hire in public without naming anyone, tells the owner they earned, and never calls a demo job a hire", () => {
    const owner = wallet(), a = agent(owner, "Notes Writer");
    const paid = task(a.agentId, "completed", true);
    task(a.agentId, "completed", false); // a demo job: no payment
    runMyloPass();
    const said = feed(500).filter((t) => t.kind === "hired" && t.link === `/agents/${a.agentId}`);
    expect(said).toHaveLength(1);
    expect(said[0].text).toMatch(/^Notes Writer was hired for 0\.0006 ETH and delivered in 30 seconds\.$/);
    expect(JSON.stringify(feed(500))).not.toMatch(/private task text|buyer-agent|0x9/);
    expect(inboxOf(owner)).toEqual([expect.objectContaining({ kind: "earned", title: "Notes Writer earned 0.0006 ETH", link: `/r/${paid}` })]);
  });

  it("tells an owner when a paid job of theirs failed, in private only", () => {
    const owner = wallet(), a = agent(owner, "Fragile");
    task(a.agentId, "failed", true, "Model timed out\nstack trace");
    runMyloPass();
    expect(inboxOf(owner)[0]).toMatchObject({ kind: "failed", title: "A paid job for Fragile didn't finish", body: "Model timed out" });
    expect(feed(50).some((t) => /Fragile/.test(t.text))).toBe(false);
  });

  it("announces new Studio agents, tells the owner of a remixed agent, and says when an agent got better", () => {
    const owner = wallet(), original = agent(owner, "Original");
    const remix = agent(wallet(), "Original Remix", { studio_build: randomUUID(), studio_score: 8.6, remix_of: original.agentId });
    getDb().prepare("UPDATE agents SET created_at = ? WHERE agent_id = ?").run(ago(10), remix.agentId);
    const imp = randomUUID(), applied = randomUUID();
    for (const [id, status] of [[imp, "proposed"], [applied, "applied"]] as const) getDb().prepare("INSERT INTO studio_improvements (id, agent_id, wallet, build_id, status, weak_jobs, from_score, to_score, instructions, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, original.agentId, owner, randomUUID(), status, 3, 7.1, 8.3, "x", ago(15), ago(15));
    runMyloPass();
    const texts = feed(50).map((t) => `${t.kind}: ${t.text}`);
    expect(texts).toContain("built: A new agent went live: Original Remix, built in Agent Studio and tested 8.6/10 before it was listed.");
    expect(texts).toContain("improved: Original got better: Axon tested a new version on the jobs it struggled with (7.1 before, 8.3 now), and its owner applied it.");
    const kinds = inboxOf(owner).map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["remix", "improvement"]));
  });

  it("says what the hourly check did and why, and tells each owner about their own agent", () => {
    const owner = wallet(), a = agent(owner, "Flaky"), runId = randomUUID();
    getDb().prepare("INSERT INTO autonomy_network_runs (run_id, started_at, finished_at, observations, changes, agents_seen) VALUES (?,?,?,?,?,?)")
      .run(runId, ago(40), ago(39), JSON.stringify([{ kind: "agent-paused", subject: a.agentId, what: "Paused Flaky", why: "Its last 5 jobs failed, so new jobs go elsewhere until it passes a retest." }]), "[]", 30);
    runMyloPass();
    expect(feed(50).find((t) => t.kind === "rerouted")?.text).toBe("The hourly check took 1 agent out of rotation after it kept failing, so new jobs go to agents that deliver.");
    expect(feed(50).some((t) => /Flaky/.test(t.text))).toBe(false);
    expect(inboxOf(owner)[0]).toMatchObject({ kind: "paused", title: "Flaky was taken out of rotation", body: "Its last 5 jobs failed, so new jobs go elsewhere until it passes a retest." });
  });

  it("says each burn once, from trading fees, and tells an owner a withdrawal went out", () => {
    const burnN = 900_000 + n++;
    getDb().prepare("INSERT INTO burns (n, tx_hash, block_number, eth_in, tokens_out, caller, recorded_at) VALUES (?,?,?,?,?,?,?)").run(burnN, `0x${randomUUID().replace(/-/g, "")}`, 1, 0.012, 41_200, "engine", ago(5));
    const owner = wallet(), a = agent(owner, "Payer");
    getDb().prepare("INSERT INTO agent_withdrawals (id, agent_id, wallet, amount_eth, status, tx_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(randomUUID(), a.agentId, owner, "0.0014", "sent", `0x${"cd".repeat(32)}`, ago(3), ago(3));
    runMyloPass();
    expect(feed(50).find((t) => t.kind === "burned")?.text).toBe("Burned 41.2K $AXON, bought with 0.012 ETH of trading fees.");
    expect(inboxOf(owner)[0]).toMatchObject({ kind: "withdrawal", title: "Sent 0.0014 ETH to your wallet", link: expect.stringMatching(/blockscout\.com\/tx\/0xcd/) });
  });

  it("lands every event once however often it looks, and says nothing when Mylo is off", () => {
    const owner = wallet(), a = agent(owner, "Once");
    task(a.agentId, "completed", true);
    runMyloPass();
    const before = feed(500).length, inbox = inboxOf(owner).length;
    expect(runMyloPass()).toEqual({ thoughts: 0, notices: 0 });
    expect([feed(500).length, inboxOf(owner).length]).toEqual([before, inbox]);
    process.env.MYLO = "off";
    task(a.agentId, "completed", true);
    expect(runMyloPass()).toEqual({ thoughts: 0, notices: 0 });
  });
});

describe("reading it", () => {
  it("serves the public feed to anyone, and marks a person's notices read when Mylo tells them", async () => {
    const owner = wallet(), a = agent(owner, "Reader");
    task(a.agentId, "completed", true);
    runMyloPass();
    const pub = await (await feedGET(new NextRequest("https://axon-agents.com/api/mylo/feed?limit=5"))).json();
    expect(pub.items.length).toBeGreaterThan(0);
    expect(unreadCount(owner)).toBe(1);
    const out = await runTool("my_inbox", {}, { wallet: owner, owner, conversationId: startConversation(owner, "t").id });
    expect((out.result as { new: { what: string }[] }).new[0].what).toBe("Reader earned 0.0006 ETH");
    expect(unreadCount(owner)).toBe(0);
  });
});

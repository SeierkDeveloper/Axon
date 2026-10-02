import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "crypto";

// the fee-flow check reads the pot; here it is told what the pot says
const burnLive = vi.fn();
vi.mock("@/lib/burnLive", () => ({ getBurnLive: () => burnLive() }));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import {
  failingAgents,
  slowAgents,
  pageHealth,
  siteUrl,
  unreachableAgents,
  stuckTasks,
  failingWebhooks,
  priceOutliers,
  duplicateListings,
  staleDescriptions,
  expiringSoon,
  feeFlow,
  paymentMismatches,
  runNetworkChecks,
} from "@/lib/networkChecks";
import { publicSummary, publicDay, runNetworkPass, getNetworkRunsSince, type NetworkRun } from "@/lib/autonomyNetwork";
import type { Agent } from "@/sdk/types";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function agent(id: string, over: Partial<Agent> = {}) {
  createAgent({
    agentId: id, name: over.name ?? `Agent ${id}`, capabilities: over.capabilities ?? ["research"], publicKey: `pk-${id}`,
    provider: "anthropic", reputation: 0, createdAt: new Date(NOW).toISOString(), ...over,
  } as Agent);
}
function task(to: string, status: string, completedAgo: number, extra: { startedAgo?: number; createdAgo?: number } = {}) {
  getDb()
    .prepare("INSERT INTO tasks (task_id, from_agent, to_agent, task, status, created_at, started_at, completed_at) VALUES (?, 'someone', ?, 'x', ?, ?, ?, ?)")
    .run(
      randomUUID(), to, status,
      ago(extra.createdAgo ?? completedAgo + 60_000),
      extra.startedAgo === undefined ? ago(completedAgo + 30_000) : ago(extra.startedAgo),
      status === "completed" || status === "failed" ? ago(completedAgo) : null,
    );
}

beforeEach(() => {
  const db = getDb();
  for (const t of ["tasks", "webhooks", "transactions", "allowance_reservations", "retainers", "agents"]) {
    try { db.exec(`DELETE FROM ${t}`); } catch { /* table may not exist in an old schema */ }
  }
  burnLive.mockReset();
});

describe("network checks (report only)", () => {
  it("finds an agent failing most of its day's work, and leaves a good one alone", () => {
    agent("bad"); agent("good");
    for (let i = 0; i < 6; i++) task("bad", i < 5 ? "failed" : "completed", (i + 1) * HOUR);
    for (let i = 0; i < 6; i++) task("good", "completed", (i + 1) * HOUR);
    const f = failingAgents(NOW);
    expect(f.map((x) => x.subject)).toEqual(["bad"]);
    expect(f[0].kind).toBe("agent-failing");
  });

  it("finds agents whose model is rejected or whose endpoint went quiet", () => {
    agent("rejected"); agent("fine");
    getDb().prepare("UPDATE agents SET model_error = 'model not found', model_error_at = ? WHERE agent_id = 'rejected'").run(new Date().toISOString());
    expect(unreachableAgents().map((x) => x.subject)).toEqual(["rejected"]);
  });

  it("finds work that stopped moving", () => {
    agent("w");
    task("w", "running", 0, { startedAgo: 40 * 60_000, createdAgo: 41 * 60_000 }); // running 40 min
    task("w", "running", 0, { startedAgo: 2 * 60_000, createdAgo: 3 * 60_000 }); // running 2 min: fine
    task("w", "queued", 0, { createdAgo: 3 * HOUR }); // waiting 3 h
    const f = stuckTasks(NOW);
    expect(f).toHaveLength(2);
    expect(f.every((x) => x.kind === "task-stuck")).toBe(true);
  });

  it("finds webhooks failing long enough to switch off", () => {
    agent("hooked");
    const db = getDb();
    db.prepare("INSERT INTO webhooks (webhook_id, agent_id, url, events, secret, status, created_at, failure_count, last_success_at) VALUES ('w1', 'hooked', 'https://x', '[]', 's', 'active', ?, 25, ?)").run(ago(48 * HOUR), ago(10 * HOUR));
    db.prepare("INSERT INTO webhooks (webhook_id, agent_id, url, events, secret, status, created_at, failure_count, last_success_at) VALUES ('w2', 'hooked', 'https://y', '[]', 's', 'active', ?, 25, ?)").run(ago(48 * HOUR), ago(1 * HOUR));
    expect(failingWebhooks(NOW).map((x) => x.subject)).toEqual(["w1"]);
  });

  it("finds a price far from what the same skills cost", () => {
    for (const [id, price] of [["a", "0.0002 ETH"], ["b", "0.0002 ETH"], ["c", "0.00025 ETH"], ["d", "0.0003 ETH"], ["e", "0.05 ETH"]]) agent(id, { price });
    expect(priceOutliers().map((x) => x.subject)).toEqual(["e"]);
  });

  it("finds the same agent listed twice", () => {
    agent("one", { name: "Nova Research" }); agent("two", { name: "nova-research 2" }); agent("three", { name: "Something Else" });
    const f = duplicateListings();
    expect(f).toHaveLength(1);
    expect(f[0].what).toMatch(/2 listings/);
  });

  it("finds a description written before the agent changed", () => {
    agent("old", { capabilities: ["research", "coding"] });
    getDb().prepare("UPDATE agents SET description = 'd', described_from = '[\"Agent old\",\"research\"]', described_at = ? WHERE agent_id = 'old'").run(ago(40 * 24 * HOUR));
    expect(staleDescriptions(NOW).map((x) => x.subject)).toEqual(["old"]);
  });

  it("warns about a retainer ending within a week", () => {
    agent("ret");
    getDb().prepare(
      `INSERT INTO retainers (retainer_id, owner_wallet, agent_id, instructions, schedule, pay_in, max_price_wei, ends_at,
         status, consecutive_failures, runs_done, anchor_at, created_at, updated_at)
       VALUES ('r1', '0xabc', 'ret', 'x', '{}', 'ETH', '1', ?, 'active', 0, 0, ?, ?, ?)`,
    ).run(new Date(NOW + 3 * 24 * HOUR).toISOString(), ago(HOUR), ago(HOUR), ago(HOUR));
    expect(expiringSoon(NOW).map((x) => x.subject)).toContain("r1");
  });

  it("notices a pot that could burn and has not, and fees that stopped arriving", async () => {
    burnLive.mockResolvedValue({ live: true, launched: true, ready: true, nextBurnEth: 0.01, lastBurnAt: (NOW - 3 * HOUR) / 1000 });
    expect((await feeFlow(NOW))[0].what).toMatch(/can burn/);
    burnLive.mockResolvedValue({ live: true, launched: true, ready: false, nextBurnEth: 0, lastBurnAt: (NOW - 8 * HOUR) / 1000 });
    expect((await feeFlow(NOW))[0].what).toMatch(/no burn for/);
    burnLive.mockResolvedValue({ live: true, launched: true, ready: false, nextBurnEth: 0, lastBurnAt: (NOW - HOUR) / 1000 });
    expect(await feeFlow(NOW)).toEqual([]);
  });

  it("finds payments stuck pending for over a day", () => {
    getDb().prepare("INSERT INTO transactions (tx_id, from_agent, to_agent, amount_eth, status, fee_amount, currency, created_at) VALUES ('t1', 'a', 'b', 0.001, 'pending', 0, 'ETH', ?)").run(ago(30 * HOUR));
    expect(paymentMismatches(NOW)[0].kind).toBe("payment-mismatch");
  });

  it("runs every check even when one of them fails, and names the one that did", async () => {
    burnLive.mockRejectedValue(new Error("node down"));
    const pagesOk = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const { failed } = await runNetworkChecks(NOW, { fetchFn: pagesOk });
    expect(failed).toEqual(["fee flow"]);
  });

  it("shows the public counts of upkeep only: no subjects, no wording, nothing admin-only", () => {
    const run = runNetworkPass({
      apply: false,
      extra: [
        { kind: "agent-failing", subject: "secret-agent", what: "failing 9 of 10" },
        { kind: "payment-mismatch", what: "0.5 ETH unaccounted" },
        { kind: "fee-flow", what: "pot unburned" },
        { kind: "agent-restored", subject: "agent-y", what: "back in routing" },
        { kind: "task-freed", subject: "task-1", what: "put back in the queue" },
        { kind: "task-freed", subject: "task-2", what: "closed" },
      ],
    });
    const pub = publicSummary(run);
    expect(pub.upkeep["agent-restored"]).toBe(1);
    expect(pub.upkeep["task-freed"]).toBe(2);
    expect(pub.upkeep["agent-paused"]).toBe(0);
    const text = JSON.stringify(pub);
    for (const leak of ["secret-agent", "agent-y", "task-1", "ETH", "pot", "failing", "routing"]) expect(text).not.toContain(leak);
  });

  it("records how many checks a pass ran and which could not, and reads the last day back", () => {
    const run = runNetworkPass({ apply: true, checks: { run: 12, unavailable: ["fee flow"] } });
    const back = getNetworkRunsSince(1).find((r) => r.runId === run.runId);
    expect(back?.checksRun).toBe(12);
    expect(back?.checksUnavailable).toEqual(["fee flow"]);
    expect(publicSummary(back!).checksUnavailable).toBe(1);
  });

  it("lays the last day out hour by hour, marking hours where a check could not run", () => {
    const at = (h: number, unavailable: string[] = []): NetworkRun => ({
      runId: randomUUID(), startedAt: ago(h * HOUR - 60_000), finishedAt: ago(h * HOUR - 90_000),
      observations: [{ kind: "agent-retested", subject: "a", what: "x" }], changes: [], agentsSeen: 3,
      checksRun: 12, checksUnavailable: unavailable,
    });
    const day = publicDay([at(0), at(2, ["pages"]), at(30)], NOW);
    expect(day.hours).toHaveLength(24);
    expect(day.hours.at(-1)).toMatchObject({ ran: true, complete: true });
    expect(day.hours.at(-3)).toMatchObject({ ran: true, complete: false });
    expect(day.hours.at(-2)).toMatchObject({ ran: false });
    expect(day.passes).toBe(3); // what it was given; the caller passes the last day
  });

  it("finds an agent far slower than others with the same skills", () => {
    for (const id of ["s1", "s2", "s3", "slow"]) agent(id);
    for (const id of ["s1", "s2", "s3"]) for (let i = 0; i < 10; i++) task(id, "completed", (i + 1) * HOUR, { startedAgo: (i + 1) * HOUR + 10_000 });
    for (let i = 0; i < 10; i++) task("slow", "completed", (i + 1) * HOUR, { startedAgo: (i + 1) * HOUR + 120_000 });
    expect(slowAgents(NOW).map((x) => x.subject)).toEqual(["slow"]);
  });

  it("checks the main pages load, and quickly, on this deployment's own domain", async () => {
    expect(siteUrl({ RAILWAY_PUBLIC_DOMAIN: "axon-private-production.up.railway.app" })).toBe("https://axon-private-production.up.railway.app");
    expect(siteUrl({ AUTONOMY_SITE_URL: "https://x.test/" })).toBe("https://x.test");
    const fake = (async (url: string) => new Response("", { status: String(url).endsWith("/burn") ? 502 : 200 })) as unknown as typeof fetch;
    const f = await pageHealth("https://x.test", fake);
    expect(f.map((x) => x.what)).toEqual(["/burn answered 502"]);
    expect(f[0].kind).toBe("page-check");
  });
});


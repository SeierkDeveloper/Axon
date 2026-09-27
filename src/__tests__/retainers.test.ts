// Retainers as records: creating one against the policy, and the owner's controls. Most cases are an
// owner doing something the policy forbids, or someone who is not the owner trying anything at all.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const getTier = vi.fn();
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { toWei } from "@/lib/money";
import {
  createRetainer,
  getRetainer,
  listRetainers,
  pauseRetainer,
  resumeRetainer,
  cancelRetainer,
  editRetainer,
  countActiveRetainers,
  retainerJson,
  RetainerError,
} from "@/lib/retainers";
import { defaultMaxPriceWei, type RetainerInput } from "@/lib/retainerPolicy";
import type { Agent } from "@/sdk/types";

const tierOf = (name: string, rank: number) => ({ tier: { name, rank, minimum: 0 }, balance: 1, stale: false });
const wallet = () => `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
const NOW = Date.parse("2026-09-27T12:00:00Z");

function agent(price?: string, extra: Partial<Agent> = {}): string {
  const a: Agent = {
    agentId: `r-${randomUUID().slice(0, 8)}`,
    name: "Retainer Test Agent",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: wallet(),
    provider: "anthropic",
    price,
    reputation: 0,
    createdAt: new Date().toISOString(),
    ...extra,
  };
  createAgent(a);
  return a.agentId;
}

const input = (agentId: string, over: Partial<RetainerInput> = {}): RetainerInput => ({
  agentId,
  instructions: "Summarise overnight moves in my watchlist.",
  schedule: { kind: "daily", time: "08:00", timeZone: "Europe/Oslo" },
  payIn: "ETH",
  maxPriceWei: defaultMaxPriceWei(toWei("0.00015")!),
  ...over,
});

beforeEach(() => {
  getTier.mockResolvedValue(tierOf("base", 0));
});

describe("creating", () => {
  it("creates a daily retainer whose first run is the next eight o'clock in the owner's zone", async () => {
    const owner = wallet();
    const r = await createRetainer(owner, input(agent("0.00015 ETH")), { nowMs: NOW });
    expect(r.status).toBe("active");
    expect(r.ownerWallet).toBe(owner.toLowerCase());
    expect(r.nextRunAt).toBe("2026-09-28T06:00:00.000Z");
    expect(r.runsDone).toBe(0);
    expect(listRetainers(owner).map((x) => x.retainerId)).toEqual([r.retainerId]);
  });

  it("an interval retainer runs straight away", async () => {
    const r = await createRetainer(wallet(), input(agent("0.00015 ETH"), { schedule: { kind: "interval", everyHours: 4 } }), { nowMs: NOW });
    expect(r.nextRunAt).toBe(new Date(NOW).toISOString());
  });

  it("refuses a free agent, a missing agent and an unreachable one", async () => {
    await expect(createRetainer(wallet(), input(agent()), { nowMs: NOW })).rejects.toThrow(/paid agents/);
    await expect(createRetainer(wallet(), input("no-such-agent"), { nowMs: NOW })).rejects.toThrow(/does not exist/);
    const down = agent("0.00015 ETH");
    getDb().prepare("UPDATE agents SET verification_status = 'unreachable' WHERE agent_id = ?").run(down);
    await expect(createRetainer(wallet(), input(down), { nowMs: NOW })).rejects.toThrow(/not answering/);
  });

  it("holds a base wallet to three retainers, paused ones included", async () => {
    const owner = wallet();
    const a = agent("0.00015 ETH");
    const first = await createRetainer(owner, input(a), { nowMs: NOW });
    await createRetainer(owner, input(a), { nowMs: NOW });
    await createRetainer(owner, input(a), { nowMs: NOW });
    pauseRetainer(first.retainerId, owner, NOW);
    await expect(createRetainer(owner, input(a), { nowMs: NOW })).rejects.toThrow(/3 retainers/);
    cancelRetainer(first.retainerId, owner, NOW);
    expect(countActiveRetainers(owner)).toBe(2);
    await expect(createRetainer(owner, input(a), { nowMs: NOW })).resolves.toBeTruthy();
  });

  it("lets a holder run hourly and a base wallet not", async () => {
    const hourly = input(agent("0.00015 ETH"), { schedule: { kind: "interval", everyHours: 1 } });
    await expect(createRetainer(wallet(), hourly, { nowMs: NOW })).rejects.toThrow(/hourly/);
    getTier.mockResolvedValue(tierOf("holder", 1));
    await expect(createRetainer(wallet(), hourly, { nowMs: NOW })).resolves.toBeTruthy();
  });

  it("stores only the schedule's own fields", async () => {
    const sneaky = { kind: "daily", time: "08:00", timeZone: "UTC", extra: "<script>" } as never;
    const r = await createRetainer(wallet(), input(agent("0.00015 ETH"), { schedule: sneaky }), { nowMs: NOW });
    expect(r.schedule).toEqual({ kind: "daily", time: "08:00", timeZone: "UTC" });
  });

  it("serialises amounts as strings", async () => {
    const r = await createRetainer(wallet(), input(agent("0.00015 ETH")), { nowMs: NOW });
    expect(typeof retainerJson(r).maxPriceWei).toBe("string");
    expect(() => JSON.stringify(retainerJson(r))).not.toThrow();
  });
});

describe("the owner's controls", () => {
  it("pause, resume and cancel", async () => {
    const owner = wallet();
    const r = await createRetainer(owner, input(agent("0.00015 ETH")), { nowMs: NOW });
    expect(pauseRetainer(r.retainerId, owner, NOW).status).toBe("paused");
    expect(() => pauseRetainer(r.retainerId, owner, NOW)).toThrow(/paused/);
    const resumed = resumeRetainer(r.retainerId, owner, NOW + 3 * 86_400_000);
    expect(resumed.status).toBe("active");
    // Nothing is made up: the next run is the next slot after resuming.
    expect(resumed.nextRunAt).toBe("2026-10-01T06:00:00.000Z");
    const cancelled = cancelRetainer(r.retainerId, owner, NOW);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nextRunAt).toBeNull();
    expect(() => resumeRetainer(r.retainerId, owner, NOW)).toThrow(/cancelled/);
  });

  it("resuming clears a self-imposed pause and its failure count", async () => {
    const owner = wallet();
    const r = await createRetainer(owner, input(agent("0.00015 ETH")), { nowMs: NOW });
    getDb().prepare("UPDATE retainers SET status = 'paused', pause_reason = 'failures', consecutive_failures = 3 WHERE retainer_id = ?").run(r.retainerId);
    const resumed = resumeRetainer(r.retainerId, owner, NOW);
    expect(resumed.consecutiveFailures).toBe(0);
    expect(resumed.pauseReason).toBeNull();
  });

  it("will not resume onto an agent that stopped answering", async () => {
    const owner = wallet();
    const a = agent("0.00015 ETH");
    const r = await createRetainer(owner, input(a), { nowMs: NOW });
    pauseRetainer(r.retainerId, owner, NOW);
    getDb().prepare("UPDATE agents SET verification_status = 'unreachable' WHERE agent_id = ?").run(a);
    expect(() => resumeRetainer(r.retainerId, owner, NOW)).toThrow(/still not answering/);
  });

  it("nobody else can touch it, and a stranger learns nothing", async () => {
    const owner = wallet();
    const r = await createRetainer(owner, input(agent("0.00015 ETH")), { nowMs: NOW });
    const stranger = wallet();
    for (const act of [pauseRetainer, resumeRetainer, cancelRetainer]) {
      expect(() => act(r.retainerId, stranger, NOW)).toThrow(RetainerError);
      expect(() => act(r.retainerId, stranger, NOW)).toThrow(/not found/);
    }
    await expect(editRetainer(r.retainerId, stranger, { instructions: "mine now" }, NOW)).rejects.toThrow(/not found/);
    expect(getRetainer(r.retainerId)!.status).toBe("active");
    expect(listRetainers(stranger)).toEqual([]);
  });

  it("an address in any letter case is the same owner", async () => {
    const owner = wallet();
    const r = await createRetainer(owner.toUpperCase().replace("0X", "0x"), input(agent("0.00015 ETH")), { nowMs: NOW });
    expect(pauseRetainer(r.retainerId, owner.toLowerCase(), NOW).status).toBe("paused");
  });

  it("editing keeps the history and restarts only a changed schedule", async () => {
    const owner = wallet();
    const r = await createRetainer(owner, input(agent("0.00015 ETH")), { nowMs: NOW });
    const same = await editRetainer(r.retainerId, owner, { instructions: "Now include gas prices." }, NOW);
    expect(same.instructions).toBe("Now include gas prices.");
    expect(same.nextRunAt).toBe(r.nextRunAt);
    const moved = await editRetainer(r.retainerId, owner, { schedule: { kind: "interval", everyHours: 6 } }, NOW);
    expect(moved.nextRunAt).toBe(new Date(NOW + 6 * 3_600_000).toISOString());
    await expect(editRetainer(r.retainerId, owner, { maxPriceWei: 1n }, NOW)).rejects.toThrow(/below/);
  });
});

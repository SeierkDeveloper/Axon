// The retainer runner, against the real database and task queue. Only the on-chain payment is
// stubbed: payFromAllowance is the one step that needs a live contract, and it is exercised for real in
// the allowance suites. What matters here is everything around it: the right slot, exactly once, the
// right reasons when it does not run, and the pauses.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const getTier = vi.fn();
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

const payFromAllowance = vi.fn();
const freshAxonQuoteFor = vi.fn();
vi.mock("@/lib/allowancePayment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/allowancePayment")>("@/lib/allowancePayment");
  return { ...actual, payFromAllowance: (h: unknown) => payFromAllowance(h), freshAxonQuoteFor: (a: string, wei?: bigint) => freshAxonQuoteFor(a, wei) };
});

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { toWei } from "@/lib/money";
import { AllowancePaymentError } from "@/lib/allowancePayment";
import { createAllowanceKey, revokeAllowanceKey } from "@/lib/allowanceKeys";
import { createRetainer, getRetainer, resumeRetainer } from "@/lib/retainers";
import { runDueRetainers, settleRetainerRuns, sweepStrandedRuns } from "@/lib/retainerRunner";
import { defaultMaxPriceWei, type RetainerInput } from "@/lib/retainerPolicy";
import type { Agent } from "@/sdk/types";

const H = 3_600_000;
const T0 = Date.parse("2026-09-27T12:00:00Z");
const tierOf = (name: string, rank: number) => ({ tier: { name, rank, minimum: 0 }, balance: 1, stale: false });
const wallet = () => `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;

function agent(price = "0.00015 ETH", extra: Partial<Agent> = {}): string {
  const a: Agent = {
    agentId: `rr-${randomUUID().slice(0, 8)}`,
    name: "Runner Test Agent",
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

const every4 = (agentId: string, over: Partial<RetainerInput> = {}): RetainerInput => ({
  agentId,
  instructions: "Check my wallet and summarise changes.",
  schedule: { kind: "interval", everyHours: 4 },
  payIn: "ETH",
  maxPriceWei: defaultMaxPriceWei(toWei("0.00015")!),
  ...over,
});

const runs = (retainerId: string) =>
  getDb().prepare(`SELECT * FROM retainer_runs WHERE retainer_id = ? ORDER BY scheduled_for`).all(retainerId) as {
    run_id: string; scheduled_for: string; status: string; skip_reason: string | null; task_id: string | null; error: string | null; price_wei: string | null;
  }[];

const setTask = (taskId: string, status: string) => getDb().prepare(`UPDATE tasks SET status = ? WHERE task_id = ?`).run(status, taskId);

async function make(input: RetainerInput, owner = wallet(), opts: { apiKeyId?: string } = {}) {
  const r = await createRetainer(owner, input, { nowMs: T0, ...opts });
  // Run only this test's retainer: park every other active retainer far in the future.
  getDb().prepare(`UPDATE retainers SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE retainer_id != ? AND status = 'active'`).run(r.retainerId);
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
  getTier.mockResolvedValue(tierOf("base", 0));
  payFromAllowance.mockResolvedValue({});
  freshAxonQuoteFor.mockResolvedValue("quote-1");
});

describe("a due run", () => {
  it("hires the agent from the owner's wallet, pays from the allowance, and moves to the next slot", async () => {
    const owner = wallet();
    const a = agent();
    const r = await make(every4(a), owner);

    const res = await runDueRetainers(T0);
    expect(res).toMatchObject({ due: 1, hired: 1, skipped: 0 });

    const [run] = runs(r.retainerId);
    expect(run.status).toBe("running");
    expect(run.scheduled_for).toBe(new Date(T0).toISOString());
    expect(run.price_wei).toBe(toWei("0.00015")!.toString());
    const task = getDb().prepare(`SELECT * FROM tasks WHERE task_id = ?`).get(run.task_id) as { from_agent: string; to_agent: string; task: string; status: string };
    expect(task).toMatchObject({ from_agent: owner.toLowerCase(), to_agent: a, task: "Check my wallet and summarise changes.", status: "queued" });

    expect(payFromAllowance).toHaveBeenCalledWith(expect.objectContaining({ owner: owner.toLowerCase(), toAgent: a, priceString: "0.00015 ETH", quoteId: undefined }));
    const after = getRetainer(r.retainerId)!;
    expect(after.nextRunAt).toBe(new Date(T0 + 4 * H).toISOString());
    expect(after.runsDone).toBe(1);
  });

  it("does nothing before its time", async () => {
    const r = await make(every4(agent()));
    getDb().prepare(`UPDATE retainers SET next_run_at = ? WHERE retainer_id = ?`).run(new Date(T0 + H).toISOString(), r.retainerId);
    expect((await runDueRetainers(T0)).due).toBe(0);
    expect(runs(r.retainerId)).toHaveLength(0);
  });

  it("pays in $AXON with a fresh quote each run", async () => {
    const a = agent();
    // Agents opt into $AXON on their own, after registering.
    getDb().prepare(`UPDATE agents SET accepts_axon = 1 WHERE agent_id = ?`).run(a);
    const r = await make(every4(a, { payIn: "AXON" }));
    await runDueRetainers(T0);
    expect(freshAxonQuoteFor).toHaveBeenCalledWith(a, toWei("0.00015")!);
    expect(payFromAllowance).toHaveBeenCalledWith(expect.objectContaining({ quoteId: "quote-1" }));
    expect(runs(r.retainerId)[0].status).toBe("running");
  });

  it("carries the creating key, so the key's limits apply to every run", async () => {
    const owner = wallet();
    const { keyId } = createAllowanceKey(owner, { label: "assistant" }) as { keyId: string };
    await make(every4(agent()), owner, { apiKeyId: keyId });
    await runDueRetainers(T0);
    expect(payFromAllowance).toHaveBeenCalledWith(expect.objectContaining({ apiKeyId: keyId }));
  });
});

describe("exactly once", () => {
  it("two workers on the same tick hire once", async () => {
    const r = await make(every4(agent()));
    const [a, b] = await Promise.all([runDueRetainers(T0), runDueRetainers(T0)]);
    expect(a.hired + b.hired).toBe(1);
    expect(runs(r.retainerId)).toHaveLength(1);
    expect(payFromAllowance).toHaveBeenCalledTimes(1);
  });

  it("a slot that was already recorded is never hired again, even if the retainer points back at it", async () => {
    const r = await make(every4(agent()));
    await runDueRetainers(T0);
    getDb().prepare(`UPDATE retainers SET next_run_at = ? WHERE retainer_id = ?`).run(new Date(T0).toISOString(), r.retainerId);
    await runDueRetainers(T0 + 60_000);
    expect(payFromAllowance).toHaveBeenCalledTimes(1);
  });
});

describe("downtime", () => {
  it("runs only the latest slot and records the one it missed", async () => {
    const r = await make(every4(agent()));
    // Down for ten hours: slots at T0, T0+4h and T0+8h all passed.
    const now = T0 + 8 * H + 5 * 60_000;
    await runDueRetainers(now);
    const all = runs(r.retainerId);
    expect(all.map((x) => [x.scheduled_for, x.status, x.skip_reason])).toEqual([
      [new Date(T0).toISOString(), "skipped", "missed"],
      [new Date(T0 + 8 * H).toISOString(), "running", null],
    ]);
    expect(payFromAllowance).toHaveBeenCalledTimes(1);
    expect(getRetainer(r.retainerId)!.nextRunAt).toBe(new Date(T0 + 12 * H).toISOString());
  });

  it("a daily run hours late is skipped, not run at the wrong time of day", async () => {
    const r = await make(every4(agent(), { schedule: { kind: "daily", time: "08:00", timeZone: "UTC" } }));
    const slot = Date.parse(getRetainer(r.retainerId)!.nextRunAt!);
    await runDueRetainers(slot + 5 * H);
    expect(runs(r.retainerId).map((x) => x.skip_reason)).toEqual(["missed"]);
    expect(payFromAllowance).not.toHaveBeenCalled();
    expect(getRetainer(r.retainerId)!.nextRunAt).toBe(new Date(slot + 24 * H).toISOString());
  });
});

describe("runs that do not happen", () => {
  it("skips when the price rose past the ceiling, without counting it against the owner", async () => {
    const a = agent();
    const r = await make(every4(a));
    getDb().prepare(`UPDATE agents SET price = '0.0004 ETH' WHERE agent_id = ?`).run(a);
    await runDueRetainers(T0);
    expect(runs(r.retainerId)[0]).toMatchObject({ status: "skipped", skip_reason: "price_above_max" });
    expect(payFromAllowance).not.toHaveBeenCalled();
    expect(getRetainer(r.retainerId)!.consecutiveFailures).toBe(0);
  });

  it("an allowance refusal is recorded with its reason and rolls the task back", async () => {
    payFromAllowance.mockRejectedValue(new AllowancePaymentError("This hire costs 0.00015 ETH and 0 ETH of today's limit is left"));
    const r = await make(every4(agent()));
    const tasksBefore = (getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
    await runDueRetainers(T0);
    expect(runs(r.retainerId)[0]).toMatchObject({ status: "skipped", skip_reason: "allowance_refused", error: expect.stringMatching(/today's limit/) });
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(tasksBefore);
    expect(getRetainer(r.retainerId)!.consecutiveFailures).toBe(1);
  });

  it("three refusals in a row pause it", async () => {
    payFromAllowance.mockRejectedValue(new AllowancePaymentError("This hire is over your daily limit"));
    const r = await make(every4(agent()));
    for (let i = 0; i < 3; i++) await runDueRetainers(T0 + i * 4 * H);
    const after = getRetainer(r.retainerId)!;
    expect(after.status).toBe("paused");
    expect(after.pauseReason).toBe("failures");
    await runDueRetainers(T0 + 12 * H);
    expect(payFromAllowance).toHaveBeenCalledTimes(3);
  });

  it("an outage on our side is not held against the owner", async () => {
    payFromAllowance.mockRejectedValue(new AllowancePaymentError("Allowance payments are not available", 503));
    const r = await make(every4(agent()));
    for (let i = 0; i < 4; i++) await runDueRetainers(T0 + i * 4 * H);
    expect(getRetainer(r.retainerId)!.status).toBe("active");
    expect(getRetainer(r.retainerId)!.consecutiveFailures).toBe(0);
  });

  it("pauses when the agent stops answering", async () => {
    const a = agent();
    const r = await make(every4(a));
    getDb().prepare(`UPDATE agents SET verification_status = 'unreachable' WHERE agent_id = ?`).run(a);
    await runDueRetainers(T0);
    expect(runs(r.retainerId)[0].skip_reason).toBe("agent_unavailable");
    expect(getRetainer(r.retainerId)!.pauseReason).toBe("agent_unavailable");
  });

  it("stops at once when its key is revoked, and resuming carries on without the key", async () => {
    const owner = wallet();
    const { keyId } = createAllowanceKey(owner, { label: "assistant" }) as { keyId: string };
    const r = await make(every4(agent()), owner, { apiKeyId: keyId });
    revokeAllowanceKey(keyId, owner);
    await runDueRetainers(T0);
    expect(getRetainer(r.retainerId)!.pauseReason).toBe("key_revoked");
    expect(payFromAllowance).not.toHaveBeenCalled();
    const resumed = resumeRetainer(r.retainerId, owner, T0 + H);
    expect(resumed.apiKeyId).toBeNull();
  });

  it("stops at once when its key expires, and resuming carries on without the key", async () => {
    const owner = wallet();
    const { keyId } = createAllowanceKey(owner, { label: "assistant" }) as { keyId: string };
    const r = await make(every4(agent()), owner, { apiKeyId: keyId });
    getDb().prepare(`UPDATE allowance_key_limits SET expires_at = ? WHERE key_id = ?`).run(new Date(T0 - 1000).toISOString(), keyId);
    await runDueRetainers(T0);
    expect(runs(r.retainerId)[0].error).toMatch(/has expired/);
    expect(getRetainer(r.retainerId)!.pauseReason).toBe("key_expired");
    expect(payFromAllowance).not.toHaveBeenCalled();
    expect(resumeRetainer(r.retainerId, owner, T0 + H).apiKeyId).toBeNull();
  });

  it("an expired allowance pauses it at once, in words, instead of three refusals", async () => {
    const r = await make(every4(agent()));
    payFromAllowance.mockRejectedValue(new AllowancePaymentError("Your allowance has expired", 402));
    await runDueRetainers(T0);
    expect(runs(r.retainerId)[0]).toMatchObject({ skip_reason: "allowance_refused", error: "Your allowance has expired" });
    expect(getRetainer(r.retainerId)).toMatchObject({ status: "paused", pauseReason: "allowance_expired", consecutiveFailures: 0 });
  });

  it("Axon's own outage, out of gas included, is recorded as ours and never counts against the owner", async () => {
    const r = await make(every4(agent()));
    payFromAllowance.mockRejectedValue(new AllowancePaymentError("Axon cannot take payments for a moment. Nothing was charged; try again shortly", 503));
    for (let i = 0; i < 4; i++) await runDueRetainers(T0 + i * 4 * H);
    expect(runs(r.retainerId).map((x) => x.skip_reason)).toEqual(["payment_unavailable", "payment_unavailable", "payment_unavailable", "payment_unavailable"]);
    expect(getRetainer(r.retainerId)).toMatchObject({ status: "active", consecutiveFailures: 0 });
  });

  it("never overlaps a run still working", async () => {
    const r = await make(every4(agent()));
    await runDueRetainers(T0);
    await runDueRetainers(T0 + 4 * H);
    const all = runs(r.retainerId);
    expect(all.map((x) => x.status)).toEqual(["running", "skipped"]);
    expect(all[1].skip_reason).toBe("previous_run_in_flight");
    expect(payFromAllowance).toHaveBeenCalledTimes(1);
  });
});

describe("closing runs", () => {
  it("completed work closes the run and clears the failure count", async () => {
    const r = await make(every4(agent()));
    getDb().prepare(`UPDATE retainers SET consecutive_failures = 2 WHERE retainer_id = ?`).run(r.retainerId);
    await runDueRetainers(T0);
    setTask(runs(r.retainerId)[0].task_id!, "completed");
    expect(settleRetainerRuns(T0 + H)).toEqual({ completed: 1, failed: 0 });
    expect(runs(r.retainerId)[0].status).toBe("completed");
    expect(getRetainer(r.retainerId)!.consecutiveFailures).toBe(0);
  });

  it("failed work counts, and three failed runs pause it", async () => {
    const r = await make(every4(agent()));
    for (let i = 0; i < 3; i++) {
      await runDueRetainers(T0 + i * 4 * H);
      const open = runs(r.retainerId).find((x) => x.status === "running")!;
      setTask(open.task_id!, "failed");
      settleRetainerRuns(T0 + i * 4 * H + H);
    }
    expect(getRetainer(r.retainerId)).toMatchObject({ status: "paused", pauseReason: "failures" });
  });

  it("a failed run is explained in the owner's words, never the provider's", async () => {
    const r = await make(every4(agent()));
    await runDueRetainers(T0);
    const open = runs(r.retainerId)[0];
    getDb().prepare(`UPDATE tasks SET status = 'failed', error = ? WHERE task_id = ?`)
      .run('401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}', open.task_id);
    settleRetainerRuns(T0 + H);
    const [run] = runs(r.retainerId);
    expect(run.error).toMatch(/could not finish this run.*went back to your allowance/);
    expect(run.error).not.toMatch(/401|api key/i);
  });

  it("a run whose task vanished is closed, so it cannot block later runs", async () => {
    const r = await make(every4(agent()));
    await runDueRetainers(T0);
    getDb().prepare(`DELETE FROM tasks WHERE task_id = ?`).run(runs(r.retainerId)[0].task_id);
    settleRetainerRuns(T0 + H);
    await runDueRetainers(T0 + 4 * H);
    expect(runs(r.retainerId).map((x) => x.status)).toEqual(["failed", "running"]);
  });

  it("a run left pending by a crash is closed after ten minutes", async () => {
    const r = await make(every4(agent()));
    getDb()
      .prepare(`INSERT INTO retainer_runs (run_id, retainer_id, scheduled_for, status, created_at) VALUES (?, ?, ?, 'pending', ?)`)
      .run(`run_${randomUUID().slice(0, 8)}`, r.retainerId, new Date(T0 - 4 * H).toISOString(), new Date(T0 - 20 * 60_000).toISOString());
    expect(sweepStrandedRuns(T0)).toBeGreaterThanOrEqual(1);
    await runDueRetainers(T0);
    expect(runs(r.retainerId).map((x) => x.status)).toEqual(["failed", "running"]);
  });
});

describe("ending", () => {
  it("ends after its last run", async () => {
    const r = await make(every4(agent(), { maxRuns: 2 }));
    await runDueRetainers(T0);
    setTask(runs(r.retainerId)[0].task_id!, "completed");
    settleRetainerRuns(T0 + H);
    const res = await runDueRetainers(T0 + 4 * H);
    expect(res.ended).toBe(1);
    expect(getRetainer(r.retainerId)).toMatchObject({ status: "ended", nextRunAt: null, runsDone: 2 });
  });

  it("ends at its end date without running", async () => {
    const r = await make(every4(agent(), { endsAt: T0 + 2 * H }));
    await runDueRetainers(T0);
    setTask(runs(r.retainerId)[0].task_id!, "completed");
    settleRetainerRuns(T0 + H);
    const res = await runDueRetainers(T0 + 4 * H);
    expect(res.ended).toBe(1);
    expect(payFromAllowance).toHaveBeenCalledTimes(1);
  });
});

describe("a tier that drops", () => {
  it("keeps an hourly retainer running at the new tier's pace, and restores it on buying back", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const r = await make(every4(agent(), { schedule: { kind: "interval", everyHours: 1 } }));
    // A webhook, to show the held-back slots are not posted as failures.
    getDb().prepare(`UPDATE retainers SET webhook_url = 'https://example.com/r', webhook_secret = 'whsec_x' WHERE retainer_id = ?`).run(r.retainerId);

    const hour = async (i: number) => {
      await runDueRetainers(T0 + i * H);
      const open = runs(r.retainerId).find((x) => x.status === "running");
      if (open) setTask(open.task_id!, "completed");
      settleRetainerRuns(T0 + i * H + 30 * 60_000);
    };

    await hour(0);
    getTier.mockResolvedValue(tierOf("base", 0)); // sold
    for (let i = 1; i <= 4; i++) await hour(i);
    getTier.mockResolvedValue(tierOf("holder", 1)); // bought back
    await hour(5);

    const statuses = runs(r.retainerId).map((x) => x.skip_reason ?? x.status);
    expect(statuses).toEqual(["completed", "tier_pace", "tier_pace", "tier_pace", "completed", "completed"]);
    expect(getRetainer(r.retainerId)).toMatchObject({ status: "active", consecutiveFailures: 0 });
    const posted = getDb().prepare(`SELECT event_type FROM retainer_deliveries WHERE retainer_id = ?`).all(r.retainerId) as { event_type: string }[];
    expect(posted.every((d) => d.event_type === "retainer.run.completed")).toBe(true);
    expect(posted).toHaveLength(3);
  });

  it("leaves schedules the new tier allows alone", async () => {
    const r = await make(every4(agent()));
    for (let i = 0; i < 2; i++) {
      await runDueRetainers(T0 + i * 4 * H);
      setTask(runs(r.retainerId).find((x) => x.status === "running")!.task_id!, "completed");
      settleRetainerRuns(T0 + i * 4 * H + H);
    }
    expect(runs(r.retainerId).map((x) => x.status)).toEqual(["completed", "completed"]);
  });
});

describe("the agent's retainer discount", () => {
  const discount = (agentId: string, bps: number) => getDb().prepare(`UPDATE agents SET retainer_discount_bps = ? WHERE agent_id = ?`).run(bps, agentId);

  it("charges the discounted price, in the task and the payment", async () => {
    const a = agent();
    discount(a, 2000);
    const r = await make(every4(a));
    await runDueRetainers(T0);
    const [run] = runs(r.retainerId);
    expect(run.price_wei).toBe(toWei("0.00012")!.toString());
    expect(payFromAllowance).toHaveBeenCalledWith(expect.objectContaining({ priceString: "0.00012 ETH" }));
    const task = getDb().prepare(`SELECT payment FROM tasks WHERE task_id = ?`).get(run.task_id) as { payment: string };
    expect(task.payment).toBe("0.00012 ETH");
  });

  it("quotes $AXON from the discounted price, so the two discounts stack", async () => {
    const a = agent();
    getDb().prepare(`UPDATE agents SET accepts_axon = 1 WHERE agent_id = ?`).run(a);
    discount(a, 1000);
    await make(every4(a, { payIn: "AXON" }));
    await runDueRetainers(T0);
    expect(freshAxonQuoteFor).toHaveBeenCalledWith(a, toWei("0.000135")!);
  });

  it("compares the discounted price with the retainer's maximum", async () => {
    const a = agent();
    const r = await make(every4(a));
    // The price rises past the maximum (0.0001875), but a 10% discount brings a run back under it.
    getDb().prepare(`UPDATE agents SET price = '0.0002 ETH', retainer_discount_bps = 1000 WHERE agent_id = ?`).run(a);
    await runDueRetainers(T0);
    expect(runs(r.retainerId)[0]).toMatchObject({ status: "running", price_wei: toWei("0.00018")!.toString() });
  });
});

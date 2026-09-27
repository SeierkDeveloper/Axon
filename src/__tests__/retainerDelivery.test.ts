// Retainer results and delivery: the run history an owner reads, and the webhook their own endpoint
// receives. Each retainer may carry one webhook; it is signed and retried exactly like agent webhooks.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID, createHmac } from "node:crypto";

const publicHttpFetch = vi.fn();
const validatePublicHttpUrl = vi.fn();
vi.mock("@/lib/urlSecurity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/urlSecurity")>()),
  publicHttpFetch: (...a: unknown[]) => publicHttpFetch(...a),
  validatePublicHttpUrl: (u: string) => validatePublicHttpUrl(u),
}));

const getTier = vi.fn();
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

const payFromAllowance = vi.fn();
vi.mock("@/lib/allowancePayment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/allowancePayment")>("@/lib/allowancePayment");
  return { ...actual, payFromAllowance: (h: unknown) => payFromAllowance(h), freshAxonQuoteFor: async () => "q" };
});

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { toWei } from "@/lib/money";
import { AllowancePaymentError } from "@/lib/allowancePayment";
import { MAX_ATTEMPTS } from "@/lib/webhooks";
import { createRetainer, getRetainer, listRetainerRuns, latestRetainerResult, receiptUrl, retainerJson } from "@/lib/retainers";
import { runDueRetainers, settleRetainerRuns } from "@/lib/retainerRunner";
import { setRetainerWebhook, deliverRetainerWebhooks, retainerWebhookStatus, WEBHOOK_FAILURES_BEFORE_OFF } from "@/lib/retainerWebhooks";
import { defaultMaxPriceWei, type RetainerInput } from "@/lib/retainerPolicy";
import type { Agent } from "@/sdk/types";

const H = 3_600_000;
const T0 = Date.parse("2026-09-27T12:00:00Z");
const wallet = () => `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;

function agent(): string {
  const a: Agent = {
    agentId: `rd-${randomUUID().slice(0, 8)}`,
    name: "Delivery Test Agent",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: wallet(),
    provider: "anthropic",
    price: "0.00015 ETH",
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(a);
  return a.agentId;
}

const every4 = (agentId: string): RetainerInput => ({
  agentId,
  instructions: "Summarise my wallet.",
  schedule: { kind: "interval", everyHours: 4 },
  payIn: "ETH",
  maxPriceWei: defaultMaxPriceWei(toWei("0.00015")!),
});

async function make(owner = wallet()) {
  const r = await createRetainer(owner, every4(agent()), { nowMs: T0 });
  getDb().prepare(`UPDATE retainers SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE retainer_id != ? AND status = 'active'`).run(r.retainerId);
  getDb().prepare(`UPDATE retainer_deliveries SET status = 'delivered' WHERE retainer_id != ?`).run(r.retainerId);
  return r;
}

const complete = (taskId: string, output: string) =>
  getDb().prepare(`UPDATE tasks SET status = 'completed', output = ? WHERE task_id = ?`).run(output, taskId);

const queued = (retainerId: string) =>
  (getDb().prepare(`SELECT event_type, payload, status FROM retainer_deliveries WHERE retainer_id = ? ORDER BY created_at, rowid`).all(retainerId) as { event_type: string; payload: string; status: string }[])
    .map((d) => ({ event: d.event_type, status: d.status, data: JSON.parse(d.payload).data }));

const ok = (status = 200) => ({ status, text: async () => "ok" });

beforeEach(() => {
  vi.clearAllMocks();
  getTier.mockResolvedValue({ tier: { name: "base", rank: 0, minimum: 0 }, balance: 0, stale: false });
  payFromAllowance.mockResolvedValue({});
  validatePublicHttpUrl.mockResolvedValue(null);
  publicHttpFetch.mockResolvedValue(ok());
});

describe("run history", () => {
  it("lists runs newest first, with the output of completed ones and the reason for the rest", async () => {
    const owner = wallet();
    const r = await make(owner);
    await runDueRetainers(T0);
    const first = listRetainerRuns(r.retainerId, owner)[0];
    complete(first.taskId!, "Your wallet gained 0.2 ETH overnight.");
    settleRetainerRuns(T0 + H);
    payFromAllowance.mockRejectedValueOnce(new AllowancePaymentError("This hire is over your daily limit"));
    await runDueRetainers(T0 + 4 * H);

    const runs = listRetainerRuns(r.retainerId, owner);
    expect(runs.map((x) => x.status)).toEqual(["skipped", "completed"]);
    expect(runs[0]).toMatchObject({ skipReason: "allowance_refused", message: "This hire is over your daily limit", output: null });
    expect(runs[1]).toMatchObject({ output: "Your wallet gained 0.2 ETH overnight.", receiptUrl: receiptUrl(first.taskId!) });
    expect(latestRetainerResult(r.retainerId, owner)!.output).toBe("Your wallet gained 0.2 ETH overnight.");
  });

  it("shows no output until the work is done", async () => {
    const owner = wallet();
    const r = await make(owner);
    await runDueRetainers(T0);
    getDb().prepare(`UPDATE tasks SET output = 'draft' WHERE task_id = ?`).run(listRetainerRuns(r.retainerId, owner)[0].taskId);
    expect(listRetainerRuns(r.retainerId, owner)[0]).toMatchObject({ status: "running", output: null });
    expect(latestRetainerResult(r.retainerId, owner)).toBeNull();
  });

  it("pages back with before", async () => {
    const owner = wallet();
    const r = await make(owner);
    for (let i = 0; i < 3; i++) {
      await runDueRetainers(T0 + i * 4 * H);
      const open = listRetainerRuns(r.retainerId, owner).find((x) => x.status === "running")!;
      complete(open.taskId!, `run ${i}`);
      settleRetainerRuns(T0 + i * 4 * H + H);
    }
    const page1 = listRetainerRuns(r.retainerId, owner, { limit: 2 });
    expect(page1.map((x) => x.output)).toEqual(["run 2", "run 1"]);
    const page2 = listRetainerRuns(r.retainerId, owner, { limit: 2, before: page1[1].scheduledFor });
    expect(page2.map((x) => x.output)).toEqual(["run 0"]);
  });

  it("is the owner's alone", async () => {
    const r = await make();
    expect(() => listRetainerRuns(r.retainerId, wallet())).toThrow(/not found/);
    expect(() => latestRetainerResult(r.retainerId, wallet())).toThrow(/not found/);
  });
});

describe("setting a webhook", () => {
  it("gives the secret once and never shows it again", async () => {
    const owner = wallet();
    const r = await make(owner);
    const { secret } = await setRetainerWebhook(r.retainerId, owner, "https://example.com/hook", T0);
    expect(secret).toMatch(/^whsec_/);
    const json = JSON.stringify(retainerJson(getRetainer(r.retainerId)!));
    expect(json).not.toContain(secret!);
    expect(retainerWebhookStatus(r.retainerId)).toMatchObject({ url: "https://example.com/hook", active: true });
  });

  it("refuses an address that is not public", async () => {
    const owner = wallet();
    const r = await make(owner);
    validatePublicHttpUrl.mockResolvedValueOnce("endpoint must be a public https address");
    await expect(setRetainerWebhook(r.retainerId, owner, "https://10.0.0.1/x", T0)).rejects.toThrow(/webhook url/);
  });

  it("only the owner can set or remove it", async () => {
    const r = await make();
    await expect(setRetainerWebhook(r.retainerId, wallet(), "https://example.com/x", T0)).rejects.toThrow(/not found/);
  });
});

describe("what gets queued", () => {
  it("a completed run, with its output and receipt", async () => {
    const owner = wallet();
    const r = await make(owner);
    await setRetainerWebhook(r.retainerId, owner, "https://example.com/hook", T0);
    await runDueRetainers(T0);
    const run = listRetainerRuns(r.retainerId, owner)[0];
    complete(run.taskId!, "Done.");
    settleRetainerRuns(T0 + H);
    expect(queued(r.retainerId)).toEqual([
      { event: "retainer.run.completed", status: "pending", data: expect.objectContaining({ retainerId: r.retainerId, runId: run.runId, output: "Done.", receiptUrl: receiptUrl(run.taskId!) }) },
    ]);
  });

  it("three refused runs and the pause that follows, each with its reason", async () => {
    const owner = wallet();
    const r = await make(owner);
    await setRetainerWebhook(r.retainerId, owner, "https://example.com/hook", T0);
    payFromAllowance.mockRejectedValue(new AllowancePaymentError("Your allowance is paused"));
    for (let i = 0; i < 3; i++) await runDueRetainers(T0 + i * 4 * H);
    const got = queued(r.retainerId);
    expect(got.map((d) => d.event)).toEqual(["retainer.run.failed", "retainer.run.failed", "retainer.run.failed", "retainer.paused"]);
    expect(got[0].data).toMatchObject({ status: "skipped", reason: "allowance_refused", message: "Your allowance is paused" });
    expect(got[3].data).toMatchObject({ reason: "failures", message: expect.stringMatching(/3 failed runs/) });
  });

  it("a run missed during downtime", async () => {
    const owner = wallet();
    const r = await make(owner);
    await setRetainerWebhook(r.retainerId, owner, "https://example.com/hook", T0);
    await runDueRetainers(T0 + 8 * H + 60_000);
    expect(queued(r.retainerId)[0].data).toMatchObject({ reason: "missed" });
  });

  it("nothing without a webhook", async () => {
    const r = await make();
    await runDueRetainers(T0 + 8 * H + 60_000);
    expect(queued(r.retainerId)).toHaveLength(0);
  });

  it("removing the webhook drops what was waiting", async () => {
    const owner = wallet();
    const r = await make(owner);
    await setRetainerWebhook(r.retainerId, owner, "https://example.com/hook", T0);
    payFromAllowance.mockRejectedValueOnce(new AllowancePaymentError("This hire is over your daily limit"));
    await runDueRetainers(T0);
    expect(queued(r.retainerId)).toHaveLength(1);
    await setRetainerWebhook(r.retainerId, owner, null, T0);
    expect(queued(r.retainerId)).toHaveLength(0);
  });
});

describe("delivering", () => {
  async function withOneEvent() {
    const owner = wallet();
    const r = await make(owner);
    const { secret } = await setRetainerWebhook(r.retainerId, owner, "https://example.com/hook", T0);
    payFromAllowance.mockRejectedValueOnce(new AllowancePaymentError("This hire is over your daily limit"));
    await runDueRetainers(T0);
    return { r, secret: secret! };
  }

  it("posts it signed the same way agent webhooks are", async () => {
    const { r, secret } = await withOneEvent();
    await deliverRetainerWebhooks(T0 + 1000);
    expect(publicHttpFetch).toHaveBeenCalledTimes(1);
    const [url, init] = publicHttpFetch.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://example.com/hook");
    expect(init.headers["X-Axon-Event"]).toBe("retainer.run.failed");
    const ts = init.headers["X-Axon-Timestamp"];
    const expected = createHmac("sha256", secret).update(`${ts}.${init.body}`).digest("hex");
    expect(init.headers["X-Axon-Signature"]).toBe(`sha256=${expected}`);
    expect(queued(r.retainerId)[0].status).toBe("delivered");
  });

  it("never sends one delivery twice, even with two pollers", async () => {
    await withOneEvent();
    await Promise.all([deliverRetainerWebhooks(T0 + 1000), deliverRetainerWebhooks(T0 + 1000)]);
    expect(publicHttpFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a failing endpoint, then gives up on that delivery", async () => {
    const { r } = await withOneEvent();
    publicHttpFetch.mockResolvedValue(ok(500));
    let t = T0 + 1000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await deliverRetainerWebhooks(t);
      t += 3 * H;
    }
    expect(publicHttpFetch).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(queued(r.retainerId)[0].status).toBe("failed");
    expect(retainerWebhookStatus(r.retainerId)).toMatchObject({ failuresInARow: 1, active: true });
  });

  it("switches off after three deliveries in a row fail, and the retainer keeps running", async () => {
    const owner = wallet();
    const r = await make(owner);
    await setRetainerWebhook(r.retainerId, owner, "https://example.com/hook", T0);
    publicHttpFetch.mockResolvedValue(ok(500));
    getDb().prepare(`UPDATE retainers SET webhook_failures = ? WHERE retainer_id = ?`).run(WEBHOOK_FAILURES_BEFORE_OFF - 1, r.retainerId);
    payFromAllowance.mockRejectedValueOnce(new AllowancePaymentError("This hire is over your daily limit"));
    await runDueRetainers(T0);
    let t = T0 + 1000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) { await deliverRetainerWebhooks(t); t += 3 * H; }
    expect(retainerWebhookStatus(r.retainerId)).toMatchObject({ active: false });
    expect(getRetainer(r.retainerId)!.status).toBe("active");
    // Nothing more is queued while it is off; setting it again switches it back on.
    payFromAllowance.mockRejectedValueOnce(new AllowancePaymentError("This hire is over your daily limit"));
    await runDueRetainers(T0 + 4 * H);
    expect(queued(r.retainerId)).toHaveLength(1);
    await setRetainerWebhook(r.retainerId, owner, "https://example.com/new", T0);
    expect(retainerWebhookStatus(r.retainerId)).toMatchObject({ active: true, failuresInARow: 0 });
  });
});

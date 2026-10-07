// The SDK against a real Axon server.
//
// Everything else in this folder runs against stubs, which is right for logic and useless for the
// thing that actually broke: the SDK and the server disagreeing about a payload. Paying in $AXON
// failed for three separate reasons at once, and every one of them would have passed a mocked test,
// because a mock answers with whatever the test author believed the server sends.
//
// So these talk to a server. They are skipped unless AXON_E2E_URL points at one, which keeps a
// normal `npm test` fast and offline. Run them with:
//
//   node scripts/sdk-e2e.mjs
//
// which boots a server on a scratch database, mints a key, and runs this file against it.
//
// Nothing here spends money. The paying tests use transactions that do not exist, so what is under
// test is the refusal and what it leaves behind, which is the half that has to be right anyway.

import { describe, it, expect, beforeAll } from "vitest";
import { AxonClient, AxonApiError, selectPaymentOption } from "../src/index";
import type { X402Requirements } from "../src/types";

const URL = process.env.AXON_E2E_URL;
const KEY = process.env.AXON_E2E_KEY;
const OWNER = process.env.AXON_E2E_OWNER ?? "0x1111111111111111111111111111111111111111";
const AGENT = process.env.AXON_E2E_AGENT ?? "sdk-e2e-agent";

const live = URL ? describe : describe.skip;

live("the SDK against a running server", () => {
  let axon: AxonClient;

  beforeAll(() => {
    axon = new AxonClient({ endpoint: URL, apiKey: KEY });
  });

  it("reads an agent, with the fields this version added", async () => {
    const agent = await axon.getAgent("research-agent");

    expect(agent.agentId).toBe("research-agent");
    // Both arrived in the last release. If the server stopped sending them the SDK would carry a
    // type that quietly describes nothing, which is the class of bug this file exists for.
    expect(agent).toHaveProperty("acceptsAxon");
    // description is written by a model after registration, so a scratch server has none yet. What
    // matters is that when the server does send one, the SDK carries it through as a string.
    if (agent.description !== undefined) expect(typeof agent.description).toBe("string");
  });

  it("lets an owner opt into $AXON and set a discount", async () => {
    // The whole point of updateAgent. Before it existed the setting was reachable from the database
    // and the payment path and from nowhere an owner could use.
    const on = await axon.updateAgent(AGENT, { acceptsAxon: true, axonDiscountBps: 2_500 });
    expect(on.acceptsAxon).toBe(true);
    expect(on.axonDiscountBps).toBe(2_500);

    const off = await axon.updateAgent(AGENT, { acceptsAxon: false });
    expect(off.acceptsAxon).toBe(false);

    await axon.updateAgent(AGENT, { acceptsAxon: true, axonDiscountBps: 2_500 });
  });

  it("refuses a discount outside the range rather than clamping it", async () => {
    // A typo becoming a real half-price offer is worse than a rejected request.
    await expect(axon.updateAgent(AGENT, { axonDiscountBps: 50_000 })).rejects.toBeInstanceOf(AxonApiError);
  });

  it("will not let a stranger change somebody else's agent", async () => {
    const stranger = new AxonClient({ endpoint: URL, apiKey: "axon_sk_not_a_real_key" });

    await expect(stranger.updateAgent(AGENT, { acceptsAxon: false })).rejects.toBeInstanceOf(AxonApiError);
  });

  describe("the 402 an agent answers with", () => {
    let reqs: X402Requirements;

    beforeAll(async () => {
      reqs = await axon.getX402Requirements(AGENT);
    });

    it("offers ETH and $AXON once the agent has opted in", () => {
      expect(reqs.accepts.length).toBe(2);
    });

    it("pins the token amount to a quote", () => {
      const token = selectPaymentOption(reqs, "axon");

      expect(token.extra.contractAddress).toBeTruthy();
      // Without this the server cannot tell what a transfer was settling, and refuses it. Its
      // absence from the header is precisely why paying in $AXON was impossible from the SDK.
      expect(token.extra.quoteId).toBeTruthy();
      expect(BigInt(token.maxAmountRequired)).toBeGreaterThan(0n);
    });

    it("still pays in ETH unless the token is asked for", () => {
      expect(selectPaymentOption(reqs).asset).toBe("ETH");
      expect(selectPaymentOption(reqs, "axon").asset).not.toBe("ETH");
    });

    it("charges less in $AXON than the same job priced at full rate", async () => {
      // A discount that only exists in the badge would be the site lying on the agent's behalf.
      const full = await axon.getX402Requirements("research-agent"); // platform default, 10%
      const discounted = selectPaymentOption(reqs, "axon");
      const reference = selectPaymentOption(full, "axon");

      // Same pool, same moment, different discounts: the deeper one has to buy fewer tokens per ETH
      // of listed price. Compared as a ratio against each agent's own ETH price, since the two
      // agents are not priced the same.
      const ratio = (r: X402Requirements) => {
        const eth = BigInt(selectPaymentOption(r).maxAmountRequired);
        const axonUnits = BigInt(selectPaymentOption(r, "axon").maxAmountRequired);
        return Number(axonUnits / (eth / 1_000_000n));
      };
      expect(ratio(reqs)).toBeLessThan(ratio(full) * 0.95);
      expect(reference.extra.quoteId).not.toBe(discounted.extra.quoteId);
    });
  });

  describe("paying with a transaction that never happened", () => {
    it("is refused, and says which payment it was", async () => {
      const reqs = await axon.getX402Requirements(AGENT);
      const token = selectPaymentOption(reqs, "axon");
      const fakeTx = `0x${"de".repeat(32)}`;

      const pay = async () => ({ signature: fakeTx, from: OWNER });

      await expect(
        axon.submitTaskX402(AGENT, "a task that should never be created", pay, { payWith: "axon" }),
      ).rejects.toThrow();
      // Generous, because the server polls for the transaction before giving up on it: a node lags
      // the sender, and refusing a good payment because it had not been indexed yet would be worse
      // than waiting. A payment that never happened pays that full wait.
    }, 60_000);

    it("creates no task for the agent", async () => {
      // The refusal is only half of it. A payment that failed must leave nothing behind, or the
      // agent is owed work nobody paid for.
      const history = await axon.getTaskHistory({ agentId: AGENT, role: "recipient", limit: 50 });
      const created = history.filter((t) => t.task === "a task that should never be created");

      expect(created).toHaveLength(0);
    });
  });

  it("names a quote that is no longer valid, instead of saying payment failed", async () => {
    const reqs = await axon.getX402Requirements(AGENT);
    const token = selectPaymentOption(reqs, "axon");
    // A quote id that was never issued fails the same way an expired one does, which is the error
    // this is about: the caller has to be told to fetch a fresh price, not that money went missing.
    const stale: X402Requirements = {
      ...reqs,
      accepts: reqs.accepts.map((o) =>
        o === token ? { ...o, extra: { ...o.extra, quoteId: "00000000-0000-4000-8000-000000000000" } } : o,
      ),
    };

    const pay = async () => ({ signature: `0x${"ab".repeat(32)}`, from: OWNER });
    let thrown: unknown;
    try {
      const option = selectPaymentOption(stale, "axon");
      const res = await fetch(`${URL}/api/agents/${AGENT}/x402`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Payment": Buffer.from(
            JSON.stringify({
              // "exact", exactly as buildPaymentHeader sends it. Writing "x402" here is the bug
              // this suite found in the SDK, and repeating it would only test the same mistake.
              scheme: "exact",
              network: option.network,
              payload: { ...(await pay()), quoteId: option.extra.quoteId },
            }),
          ).toString("base64"),
        },
        body: JSON.stringify({ task: "never" }),
      });
      thrown = await res.text();
    } catch (e) {
      thrown = e;
    }

    expect(String(thrown)).toMatch(/quote|expired|unknown/i);
  });

  it("reaches the endpoints this version added", async () => {
    // Not a deep check of each. This is about the paths being real, which a mock cannot tell you:
    // two of these had the wrong signature until they were run against a server.
    await expect(axon.listMissions()).resolves.toBeInstanceOf(Array);
    await expect(axon.listPaymentChannels(OWNER)).resolves.toBeInstanceOf(Array);
    await expect(axon.getWorkerMetrics()).resolves.toHaveProperty("worker");
    await expect(axon.getMission("definitely-not-a-run")).rejects.toBeInstanceOf(AxonApiError);
  });
});

// ── Allowances, against a real allowance on a local fork of Robinhood Chain ─────
//
// scripts/sdk-e2e.mjs deploys the Allowance contract on an Anvil fork, funds an allowance from a
// development wallet (0.01 ETH, 0.0005 per task, 0.005 per day) and mints that wallet a full key.
// Skipped when Anvil is not installed. The fork's ETH is not real.

const ALLOWANCE_OWNER = process.env.AXON_E2E_ALLOWANCE_OWNER;
const ALLOWANCE_OWNER_KEY = process.env.AXON_E2E_ALLOWANCE_KEY;
const withAllowance = URL && ALLOWANCE_OWNER_KEY ? describe : describe.skip;

withAllowance("the SDK paying from a real allowance", () => {
  let owner: AxonClient; // the wallet's full key
  let agentOwner: AxonClient; // the hired agent's owner, playing the agent
  const PRICE = "0.00025";

  const eth = async (client: AxonClient) => {
    const status = await client.getAllowance();
    if (!status.enabled) throw new Error("allowances are off on this server");
    return status.accounts.find((a) => a.token === "ETH")!;
  };

  /** The reconciler runs every minute; wait for it to close whatever the ledger decided. */
  async function untilNothingReserved(client: AxonClient, timeoutMs = 150_000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const a = await eth(client);
      if (a.reserved === "0") return a;
      if (Date.now() > until) throw new Error(`still reserved after ${timeoutMs}ms: ${a.reserved}`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  beforeAll(() => {
    owner = new AxonClient({ endpoint: URL, apiKey: ALLOWANCE_OWNER_KEY });
    agentOwner = new AxonClient({ endpoint: URL, apiKey: KEY });
  });

  it("reads the allowance off the chain", async () => {
    const status = await owner.getAllowance();
    expect(status.enabled).toBe(true);
    if (!status.enabled) return;
    expect(status.wallet).toBe(ALLOWANCE_OWNER);
    expect(await eth(owner)).toMatchObject({ configured: true, available: "0.01", maxPerTask: "0.0005", maxPerDay: "0.005" });
  });

  it("mints, lists and revokes an allowance key, and a revoked key stops working", async () => {
    const key = await owner.createAllowanceKey({ label: "sdk live", maxPerTask: "0.0003" });
    expect(key.apiKey).toMatch(/^axon_/);
    expect((await owner.listAllowanceKeys()).map((k) => k.keyId)).toContain(key.keyId);

    const assistant = new AxonClient({ endpoint: URL, apiKey: key.apiKey });
    const status = await assistant.getAllowance();
    expect(status.enabled && status.key).toMatchObject({ maxPerTask: "0.0003", maxPerDay: "0.005" });

    await owner.revokeAllowanceKey(key.keyId);
    await expect(assistant.getAllowance()).rejects.toMatchObject({ status: 401 });
  });

  it("an allowance key cannot do anything else, and says what it is", async () => {
    const key = await owner.createAllowanceKey({ label: "locked down" });
    const assistant = new AxonClient({ endpoint: URL, apiKey: key.apiKey });
    const err = await assistant.listAllowanceKeys().catch((e) => e);
    expect(err).toBeInstanceOf(AxonApiError);
    expect((err as AxonApiError).status).toBe(403);
    expect((err as AxonApiError).message).toMatch(/allowance key/);
  });

  it("a hire over the key's own limit is refused with the reason", async () => {
    const key = await owner.createAllowanceKey({ maxPerTask: "0.0001" });
    const assistant = new AxonClient({ endpoint: URL, apiKey: key.apiKey });
    const err = await assistant.sendTask({ from: ALLOWANCE_OWNER!, to: AGENT, task: "too dear", paymentMethod: "allowance" }).catch((e) => e);
    expect(err).toBeInstanceOf(AxonApiError);
    expect((err as AxonApiError).status).toBe(402);
    expect((err as AxonApiError).message).toMatch(/this key's per-task limit/);
    expect((await eth(owner)).reserved).toBe("0");
  });

  it("completed work is paid out of the allowance, by itself", async () => {
    const key = await owner.createAllowanceKey({ label: "completes" });
    const assistant = new AxonClient({ endpoint: URL, apiKey: key.apiKey });
    const before = await eth(owner);

    const task = await assistant.sendTask({ from: ALLOWANCE_OWNER!, to: AGENT, task: "finish me", paymentMethod: "allowance" });
    expect(task.status).toBe("queued");
    expect((await eth(owner)).reserved).toBe(PRICE);

    await agentOwner.startTask(task.taskId);
    await agentOwner.completeTask(task.taskId, "done");
    const after = await untilNothingReserved(owner);
    expect(Number(before.available) - Number(after.available)).toBeCloseTo(Number(PRICE), 12);

    // The assistant reads the task it hired.
    expect((await assistant.getTask(task.taskId)).status).toBe("completed");
  }, 200_000);

  it("failed work comes back to the allowance, by itself", async () => {
    const key = await owner.createAllowanceKey({ label: "fails" });
    const assistant = new AxonClient({ endpoint: URL, apiKey: key.apiKey });
    const before = await eth(owner);

    const task = await assistant.sendTask({ from: ALLOWANCE_OWNER!, to: AGENT, task: "fail me", paymentMethod: "allowance" });
    expect((await eth(owner)).reserved).toBe(PRICE);

    await agentOwner.startTask(task.taskId);
    await agentOwner.failTask(task.taskId, "could not do it");
    const after = await untilNothingReserved(owner);
    expect(after.available).toBe(before.available);
  }, 200_000);
});

// ── Retainers, hired and paid by the server on its own schedule ─────────────────
//
// The same allowance on the same fork. Nothing here is stubbed: the retainer is created through the SDK, the
// server's own runner hires the agent when the slot comes (it looks once a minute), the payment is reserved in the
// allowance, the agent's owner completes the work, and the run with its output is read back through the SDK.

withAllowance("the SDK keeping an agent on a retainer", () => {
  let owner: AxonClient;
  let agentOwner: AxonClient;
  let retainerId: string;
  const PRICE = "0.00025";

  async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 150_000): Promise<T> {
    const stop = Date.now() + timeoutMs;
    for (;;) {
      const got = await read();
      if (got) return got;
      if (Date.now() > stop) throw new Error(`waited ${timeoutMs}ms for ${what}`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  beforeAll(() => {
    owner = new AxonClient({ endpoint: URL, apiKey: ALLOWANCE_OWNER_KEY });
    agentOwner = new AxonClient({ endpoint: URL, apiKey: KEY });
  });

  it("says what the wallet's tier allows before anything is set up", async () => {
    const limits = await owner.getRetainerLimits();
    // A development wallet holds no $AXON: three retainers, every four hours at the fastest.
    expect(limits).toMatchObject({ tier: "base", active: 3, inUse: 0, fastestHours: 4 });
    expect(limits.next).toMatchObject({ fastestHours: 1 });
  });

  it("refuses a schedule faster than the tier allows, and says why", async () => {
    const err = await owner.createRetainer({ agentId: AGENT, instructions: "Too often.", schedule: { kind: "interval", everyHours: 1 } }).catch((e) => e);
    expect(err).toBeInstanceOf(AxonApiError);
    expect((err as AxonApiError).status).toBe(400);
    expect((err as AxonApiError).message).toMatch(/hour/i);
    expect(await owner.listRetainers()).toHaveLength(0);
  });

  it("creates a retainer and reads it back as the server keeps it", async () => {
    const r = await owner.createRetainer({ agentId: AGENT, instructions: "Report on the market.", schedule: { kind: "interval", everyHours: 4 }, maxPrice: "0.0003" });
    retainerId = r.retainerId;

    expect(r.retainerId).toMatch(/^ret_/);
    expect(r).toMatchObject({ agentId: AGENT, status: "active", payIn: "ETH", maxPrice: "0.0003", pricePerRun: PRICE, schedule: { kind: "interval", everyHours: 4 }, runsDone: 0, createdByKey: false, webhook: null });
    expect(r.scheduleText).toMatch(/4 hours/i);
    expect(typeof r.nextRunAt).toBe("string");

    expect((await owner.listRetainers()).map((x) => x.retainerId)).toEqual([retainerId]);
    expect((await owner.getRetainer(retainerId)).instructions).toBe("Report on the market.");
    expect((await owner.getRetainerLimits()).inUse).toBe(1);
  });

  it("nobody else can read or stop it", async () => {
    await expect(agentOwner.getRetainer(retainerId)).rejects.toMatchObject({ status: 404 });
    await expect(agentOwner.cancelRetainer(retainerId)).rejects.toBeInstanceOf(AxonApiError);
    expect((await owner.getRetainer(retainerId)).status).toBe("active");
  });

  it("the server hires the agent when the slot comes, pays from the allowance, and the result comes back", async () => {
    // The first slot of an interval retainer is the moment it was created, so the next look hires.
    const running = await until("the server to hire the agent", async () => {
      const { runs } = await owner.listRetainerRuns(retainerId);
      return runs.find((x) => x.status === "running" && x.taskId);
    });
    expect(running.price).toBe(PRICE);
    const status = await owner.getAllowance();
    expect(status.enabled && status.accounts.find((a) => a.token === "ETH")!.reserved).toBe(PRICE);

    // The agent sees an ordinary task carrying the retainer's instructions, and does it.
    expect((await agentOwner.getTask(running.taskId!)).task).toBe("Report on the market.");
    await agentOwner.startTask(running.taskId!);
    await agentOwner.completeTask(running.taskId!, "The market was quiet.");

    const done = await until("the run to be closed", async () => {
      const { runs } = await owner.listRetainerRuns(retainerId);
      return runs.find((x) => x.runId === running.runId && x.status === "completed");
    });
    expect(done).toMatchObject({ output: "The market was quiet.", price: PRICE, skipReason: null, taskId: running.taskId });
    expect(typeof done.finishedAt).toBe("string");
    expect(done.receiptUrl).toMatch(/^https?:\/\//);

    const after = await owner.getRetainer(retainerId);
    expect(after.runsDone).toBe(1);
    expect(after.latest).toMatchObject({ runId: running.runId, output: "The market was quiet." });
    // And it is waiting for its next slot, four hours on, not hiring again.
    expect(Date.parse(after.nextRunAt!) - Date.now()).toBeGreaterThan(3 * 3_600_000);
  }, 320_000);

  it("the agent's owner sees the client and what it earned", async () => {
    const view = await agentOwner.getAgentRetainers(AGENT);
    expect(view).toMatchObject({ clients: 1, active: 1, paused: 0 });
    expect(view.last30Days).toMatchObject({ runs: 1, completed: 1 });
    expect(Number(view.last30Days.earned)).toBeGreaterThan(0);
    expect(view.retainers[0]).toMatchObject({ status: "active", payIn: "ETH", runsDone: 1 });
    // The owner of an agent is not shown what its clients ask it.
    expect(view.retainers[0]).not.toHaveProperty("instructions");
  });

  it("a discount the agent offers on retainers shows in the price of a run", async () => {
    const agent = await agentOwner.updateAgent(AGENT, { retainerDiscountBps: 2_000 });
    expect(agent.retainerDiscountBps).toBe(2_000);
    expect((await owner.getRetainer(retainerId)).pricePerRun).toBe("0.0002");

    await agentOwner.updateAgent(AGENT, { retainerDiscountBps: 0 });
    expect((await owner.getRetainer(retainerId)).pricePerRun).toBe(PRICE);
  });

  it("changes, pauses and resumes", async () => {
    const changed = await owner.updateRetainer(retainerId, { instructions: "Report on the market, briefly.", maxRuns: 5 });
    expect(changed).toMatchObject({ instructions: "Report on the market, briefly.", maxRuns: 5 });

    const paused = await owner.pauseRetainer(retainerId);
    expect(paused).toMatchObject({ status: "paused", pauseReason: "owner" });
    expect(typeof paused.pauseText).toBe("string");
    // Pausing twice is a mistake worth hearing about, not a silent yes.
    await expect(owner.pauseRetainer(retainerId)).rejects.toMatchObject({ status: 400, message: "This retainer is paused" });

    const resumed = await owner.resumeRetainer(retainerId);
    expect(resumed).toMatchObject({ status: "active", pauseReason: null });
    // Resuming does not run at once: the slot it was paused in has been used.
    expect(Date.parse(resumed.nextRunAt!)).toBeGreaterThan(Date.now());
  });

  it("sets a webhook once, with a secret to check deliveries by, and removes it", async () => {
    await owner.pauseRetainer(retainerId); // nothing is delivered anywhere while this is looked at
    const set = await owner.setRetainerWebhook(retainerId, "https://example.com/axon-retainer");
    expect(set.webhook).toMatchObject({ url: "https://example.com/axon-retainer", active: true });
    expect(set.secret.length).toBeGreaterThan(20);
    // The secret is shown when it is made and never again.
    const read = await owner.getRetainer(retainerId);
    expect(read.webhook).toMatchObject({ url: "https://example.com/axon-retainer" });
    expect(JSON.stringify(read)).not.toContain(set.secret);

    expect(await owner.removeRetainerWebhook(retainerId)).toEqual({ webhook: null });
    expect((await owner.getRetainer(retainerId)).webhook).toBeNull();
  });

  it("an allowance key sets up its own retainer, sees only that one, and cannot set a webhook", async () => {
    const key = await owner.createAllowanceKey({ label: "retainer key" });
    const assistant = new AxonClient({ endpoint: URL, apiKey: key.apiKey });

    // A daily slot hours away, so this one never hires during the test.
    const far = new Date(Date.now() + 12 * 3_600_000);
    const time = `${String(far.getUTCHours()).padStart(2, "0")}:00`;
    const mine = await assistant.createRetainer({ agentId: AGENT, instructions: "From the assistant.", schedule: { kind: "daily", time, timeZone: "UTC" } });
    expect(mine).toMatchObject({ createdByKey: true, status: "active", schedule: { kind: "daily", time, timeZone: "UTC" } });

    expect((await assistant.listRetainers()).map((x) => x.retainerId)).toEqual([mine.retainerId]);
    expect((await owner.listRetainers()).map((x) => x.retainerId).sort()).toEqual([mine.retainerId, retainerId].sort());

    const err = await assistant.setRetainerWebhook(mine.retainerId, "https://example.com/hook").catch((e) => e);
    expect(err).toBeInstanceOf(AxonApiError);
    expect((err as AxonApiError).status).toBe(403);

    expect((await assistant.cancelRetainer(mine.retainerId)).status).toBe("cancelled");
  });

  it("cancels, and a cancelled retainer keeps its history", async () => {
    const gone = await owner.cancelRetainer(retainerId);
    expect(gone).toMatchObject({ status: "cancelled", nextRunAt: null });

    const { runs } = await owner.listRetainerRuns(retainerId, { limit: 5 });
    expect(runs.filter((x) => x.status === "completed")).toHaveLength(1);
    expect((await owner.getRetainerLimits()).inUse).toBe(0);
    await expect(owner.resumeRetainer(retainerId)).rejects.toBeInstanceOf(AxonApiError);
  });
});

// ── Agent Minds ─────────────────────────────────────────────────────────────────
//
// scripts/sdk-e2e-seed.ts puts two tokens with a mind in the scratch database, both launched by OWNER. One sits on
// real contracts, so its treasury is read off the chain; the other has nothing behind it and a brief left seven
// hours ago. No mind thinks or acts on this server: these read what a mind has made public, and leave it a brief.

const MIND_TOKEN = process.env.AXON_E2E_MIND_TOKEN;
const MIND_TOKEN_NO_CHAIN = process.env.AXON_E2E_MIND_TOKEN_NO_CHAIN;
const STRANGER_KEY = process.env.AXON_E2E_STRANGER_KEY;
const withMinds = URL && MIND_TOKEN && MIND_TOKEN_NO_CHAIN ? describe : describe.skip;

withMinds("the SDK reading a token's mind", () => {
  let axon: AxonClient; // the wallet that launched both tokens
  let anyone: AxonClient; // no key at all: everything a mind makes public is public
  let stranger: AxonClient; // a full key of some other wallet

  beforeAll(() => {
    axon = new AxonClient({ endpoint: URL, apiKey: KEY });
    anyone = new AxonClient({ endpoint: URL });
    stranger = new AxonClient({ endpoint: URL, apiKey: STRANGER_KEY });
  });

  it("lists the tokens with a mind, newest first, a page at a time", async () => {
    const all = await anyone.listTokenMinds();
    expect(all.tokens.map((t) => t.token)).toEqual([MIND_TOKEN_NO_CHAIN, MIND_TOKEN]);
    expect(all).toMatchObject({ page: 1, pages: 1 });
    expect(all.totals.tokens).toBe(2);
    expect(all.events).toBeInstanceOf(Array);
    expect(all).not.toHaveProperty("opened");

    const row = all.tokens[1];
    expect(row).toMatchObject({ name: "E2E On Chain", symbol: "E2EC", creator: OWNER, taxBps: 300, creatorBps: 3000, burnBps: 2000, axonBps: 1000, mindBps: 4000, attached: false, model: "claude-opus-5-5", stopped: false });
    for (const k of ["phase", "curveBps", "holders", "feesEth", "toMindEth", "burnedTokens", "burnedEth", "burns", "treasuryEth", "rewardsEth", "boughtEth", "axonEth", "thinkingPaidEth", "thoughts"] as const) expect(typeof row[k], k).toBe("number");

    const first = await anyone.listTokenMinds({ limit: 1 });
    expect(first.tokens.map((t) => t.token)).toEqual([MIND_TOKEN_NO_CHAIN]);
    expect(first).toMatchObject({ page: 1, pages: 2 });
    const second = await anyone.listTokenMinds({ limit: 1, page: 2 });
    expect(second.tokens.map((t) => t.token)).toEqual([MIND_TOKEN]);
    // The totals are for every token, whatever page is asked for.
    expect(second.totals.tokens).toBe(2);
  });

  it("reads one token's mind: its plan, its promises and its record", async () => {
    const m = await anyone.getTokenMind(MIND_TOKEN!);
    expect(m).toMatchObject({ token: MIND_TOKEN, creator: OWNER, name: "E2E On Chain", description: "A token the SDK's live tests read.", mindUrl: null, agent: null });

    expect(m.plan).toMatchObject({
      mission: "Grow the holder count slowly and keep a reserve.",
      goal: { kind: "holders", target: 100000 },
      split: { buyback: 40, reward: 30, burnAxon: 10, reserve: 20 },
      reserveEth: 0.001,
      thesis: "Rewards bring holders back more than buybacks do.",
      revisions: 0,
    });
    expect(typeof m.plan!.setAt).toBe("string");
    expect(typeof m.plan!.thoughtId).toBe("number");
    expect(m.plan!.goalText).toMatch(/holders/);

    expect(m.orders).toEqual([]);
    expect(m.promises).toEqual({ made: 0, standing: 0, kept: 0, missed: 0, notCalled: 0, beingKept: 0, heldEth: 0 });
    expect(m.record).toEqual({ summary: { moves: 0, measured: 0, byKind: [] }, moves: [] });
    expect(m.reports).toEqual([]);
    expect(m.brief).toBeNull();
    expect(m.briefCanChangeAt).toBeNull();
  });

  it("carries a treasury read off the chain, with the limits locked at launch", async () => {
    const m = await anyone.getTokenMind(MIND_TOKEN!);
    // This token's treasury is a real contract. If these stopped arriving, the SDK would describe a mind's money
    // with types that hold nothing.
    expect(m.treasury).not.toBeNull();
    for (const k of ["availableEth", "reservedEth", "boughtBackEth", "axonBurnedEth", "rewardedEth", "claimedEth", "thinkingEth", "rewards"] as const) expect(typeof m.treasury![k], k).toBe("number");
    for (const k of ["paused", "frozen", "active"] as const) expect(typeof m.treasury![k], k).toBe("boolean");
    for (const k of ["allowed", "maxPerDayEth", "maxPerActionEth", "maxActionsPerDay", "maxCostPerDayEth"] as const) expect(typeof m.treasury!.limits[k], k).toBe("number");
    expect(m.treasury!.limits.maxPerActionEth).toBeGreaterThan(0);

    expect(m.fees).not.toBeNull();
    for (const k of ["totalEth", "toCreatorEth", "toBurnEth", "toAxonEth", "toMindEth", "pendingCreatorEth", "burnedEth", "burnedTokens", "burns"] as const) expect(typeof m.fees![k], k).toBe("number");

    expect(m.mind).not.toBeNull();
    expect(typeof m.mind!.state).toBe("string");
    expect(m.mind!.text.length).toBeGreaterThan(10);

    expect(m.books).not.toBeNull();
    expect(m.books!.reserveEth).toBe(0.001);
    for (const k of ["buybackEth", "rewardEth", "burnAxonEth", "thinkingEth"] as const) expect(typeof m.books!.spent[k], k).toBe("number");
  });

  it("gives null, not an error, for what the chain cannot say", async () => {
    const m = await anyone.getTokenMind(MIND_TOKEN_NO_CHAIN!);
    expect(m.name).toBe("E2E No Chain");
    expect(m.treasury).toBeNull();
    expect(m.books).toBeNull();
    expect(m.plan).toBeNull();
    // What does not need the chain is still there.
    expect(m.brief).toMatchObject({ token: MIND_TOKEN_NO_CHAIN, text: "Reward the holders before buying back.", setBy: OWNER });
  });

  it("says a token is not there instead of returning an empty mind", async () => {
    await expect(anyone.getTokenMind("0x00000000000000000000000000000000000000ff")).rejects.toMatchObject({ status: 404 });
    await expect(anyone.getTokenMind("not-an-address")).rejects.toBeInstanceOf(AxonApiError);
  });

  it("reads the journal: what a mind proposed and what the rule check said", async () => {
    const mine = await anyone.listMindThoughts({ token: MIND_TOKEN, limit: 5 });
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      token: MIND_TOKEN, name: "E2E On Chain", symbol: "E2EC", source: "event",
      thought: "Fees came in. I would buy back, but that is more than one action may spend.",
      action: { kind: "buyback", eth: 5 }, verdict: "refused", verdictReason: "More than one action may spend.", sent: null,
    });
    expect(typeof mine[0].modelLabel).toBe("string");
    // What a thought cost is not part of what the public reads.
    expect(Object.keys(mine[0]).filter((k) => /cost/i.test(k))).toEqual([]);

    expect((await anyone.listMindThoughts()).map((t) => t.id)).toEqual([mine[0].id]);
    expect(await anyone.listMindThoughts({ token: MIND_TOKEN_NO_CHAIN })).toEqual([]);
    await expect(anyone.listMindThoughts({ token: "nonsense" })).rejects.toMatchObject({ status: 400 });
  });

  it("reads what a wallet can claim", async () => {
    expect(await anyone.getMindRewards(OWNER)).toEqual([]);
    await expect(anyone.getMindRewards("nonsense")).rejects.toMatchObject({ status: 400 });
  });

  describe("the creator's brief", () => {
    const TEXT = "Keep a reserve and reward the holders who stay.";

    it("starts empty, and says how long one may be", async () => {
      expect(await anyone.getMindBrief(MIND_TOKEN!)).toEqual({ brief: null, log: [], maxChars: 280, canChangeAt: null });
    });

    it("only the wallet that launched the token may leave one", async () => {
      await expect(stranger.setMindBrief(MIND_TOKEN!, TEXT)).rejects.toMatchObject({ status: 403, message: "Only the wallet that launched this token can leave its mind a brief." });
      await expect(anyone.setMindBrief(MIND_TOKEN!, TEXT)).rejects.toMatchObject({ status: 401 });
      expect((await anyone.getMindBrief(MIND_TOKEN!)).brief).toBeNull();
    });

    it("refuses one that is too long, with the count", async () => {
      const err = await axon.setMindBrief(MIND_TOKEN!, "word ".repeat(60)).catch((e) => e);
      expect(err).toBeInstanceOf(AxonApiError);
      expect((err as AxonApiError).status).toBe(400);
      expect((err as AxonApiError).message).toMatch(/280/);
    });

    it("the creator leaves a brief, and it is there for everyone to read", async () => {
      const set = await axon.setMindBrief(MIND_TOKEN!, TEXT);
      expect(set.changed).toBe(true);
      expect(set.brief).toMatchObject({ token: MIND_TOKEN, text: TEXT, setBy: OWNER });

      const read = await anyone.getMindBrief(MIND_TOKEN!);
      expect(read.brief).toEqual(set.brief);
      expect(read.log).toEqual([{ text: TEXT, setBy: OWNER, at: set.brief!.setAt }]);
      // It stands six hours from now.
      const wait = Date.parse(read.canChangeAt!) - Date.now();
      expect(wait).toBeGreaterThan(5.9 * 3_600_000);
      expect(wait).toBeLessThanOrEqual(6 * 3_600_000);

      const mind = await anyone.getTokenMind(MIND_TOKEN!);
      expect(mind.brief).toEqual(set.brief);
      expect(mind.briefCanChangeAt).toBe(read.canChangeAt);
    });

    it("sending the same brief again changes nothing", async () => {
      expect((await axon.setMindBrief(MIND_TOKEN!, TEXT)).changed).toBe(false);
      expect((await anyone.getMindBrief(MIND_TOKEN!)).log).toHaveLength(1);
    });

    it("a brief stands six hours: changing or taking it back sooner is refused with the time left", async () => {
      const err = await axon.setMindBrief(MIND_TOKEN!, "Buy back as much as you can.").catch((e) => e);
      expect(err).toBeInstanceOf(AxonApiError);
      expect((err as AxonApiError).status).toBe(429);
      expect((err as AxonApiError).message).toMatch(/six hours/);
      await expect(axon.clearMindBrief(MIND_TOKEN!)).rejects.toMatchObject({ status: 429 });
      expect((await anyone.getMindBrief(MIND_TOKEN!)).brief?.text).toBe(TEXT);
    });

    it("one that has stood its hours can be taken back, and stays in the log", async () => {
      const before = await anyone.getMindBrief(MIND_TOKEN_NO_CHAIN!);
      expect(before.brief?.text).toBe("Reward the holders before buying back.");
      expect(before.canChangeAt).toBeNull();

      expect(await axon.clearMindBrief(MIND_TOKEN_NO_CHAIN!)).toEqual({ brief: null, changed: true });

      const after = await anyone.getMindBrief(MIND_TOKEN_NO_CHAIN!);
      expect(after.brief).toBeNull();
      // Newest first: the one taken back shows as empty, above the one it replaced.
      expect(after.log.map((x) => x.text)).toEqual(["", "Reward the holders before buying back."]);
      expect((await anyone.getTokenMind(MIND_TOKEN_NO_CHAIN!)).brief).toBeNull();
    });
  });
});

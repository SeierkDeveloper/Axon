// Retainers against a real chain: the actual Allowance contract on a local Anvil node, the actual
// runner, reconciler and settlement, with the clock moved on between runs. Only the holder tier and
// the $AXON pool price are pinned; every payment is a real reservation the contract answers for.
//
// What this proves that the unit suites cannot: a scheduled run really reserves on chain at the right
// (discounted) price, a completed run really settles to the receiver, a failed one really comes back,
// downtime never bills a backlog, and a refusal from the contract becomes a pause in words.
//
// Skips when Anvil or the compiled contract is missing (`cd contracts && forge build`).

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const PREDICTED_AXON = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
vi.hoisted(() => {
  process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
});

vi.mock("@/lib/axonPool", async (original) => ({
  ...(await original<typeof import("@/lib/axonPool")>()),
  readPoolPrice: async () => ({ sqrtPriceX96: 2n ** 96n, axonPerEth: 1 }),
}));

const getTier = vi.fn();
vi.mock("@/lib/holderTier", async () => {
  const actual = await vi.importActual<typeof import("@/lib/holderTier")>("@/lib/holderTier");
  return { ...actual, getTier: (w: unknown) => getTier(w) };
});

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, http, parseEther, type Hex, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createAgent } from "@/lib/agents";
import { getDb } from "@/lib/db";
import { releasePayment, refundPayment } from "@/lib/payments";
import { reconcileAllowances } from "@/lib/allowancePayment";
import { reservationState, readAccount } from "@/lib/allowanceChain";
import { taskKey } from "@/lib/allowancePolicy";
import { resetRpcCircuit } from "@/lib/evm";
import { createRetainer, getRetainer } from "@/lib/retainers";
import { runDueRetainers, settleRetainerRuns } from "@/lib/retainerRunner";
import type { RetainerInput } from "@/lib/retainerPolicy";
import { checkOperatorGas } from "@/lib/allowanceGas";
import { getSystemStatus } from "@/lib/status";
import type { Agent } from "@/sdk/types";

const ANVIL = [path.join(homedir(), ".foundry/bin/anvil"), "anvil"].find((p) => p === "anvil" || existsSync(p))!;
const ARTIFACTS = path.join(process.cwd(), "contracts/out");
const ALLOWANCE_ARTIFACT = path.join(ARTIFACTS, "Allowance.sol/Allowance.json");
const TOKEN_ARTIFACT = path.join(ARTIFACTS, "Allowance.t.sol/MockAxon.json");
const available = existsSync(ALLOWANCE_ARTIFACT) && existsSync(TOKEN_ARTIFACT);

// Anvil's standard development keys.
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OWNER = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const OPERATOR_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex;
const OPERATOR = privateKeyToAccount(OPERATOR_KEY).address;
const RECEIVER = "0x000000000000000000000000000000000000bEEF" as const;

const H = 3_600_000;
const T0 = Date.parse("2026-10-01T06:00:00Z");
const tierOf = (name: string, rank: number) => ({ tier: { name, rank, minimum: 0 }, balance: 1, stale: false });

let anvil: ChildProcess;
let rpc: string;
let allowance: Hex;
let axon: Hex;
let allowanceAbi: Abi;
let tokenAbi: Abi;

const pub = () => createPublicClient({ transport: http(rpc) });

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("anvil did not start");
}

async function deploy(artifact: string, args: unknown[]): Promise<{ address: Hex; abi: Abi }> {
  const json = JSON.parse(readFileSync(artifact, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  const wallet = createWalletClient({ account: DEPLOYER, transport: http(rpc) });
  const hash = await wallet.deployContract({ abi: json.abi, bytecode: json.bytecode.object, args, chain: null });
  const receipt = await pub().waitForTransactionReceipt({ hash });
  return { address: receipt.contractAddress!, abi: json.abi };
}

async function ownerCall(address: Hex, abi: Abi, functionName: string, args: unknown[], value?: bigint) {
  const wallet = createWalletClient({ account: OWNER, transport: http(rpc) });
  const hash = await wallet.writeContract({ address, abi, functionName, args, value, chain: null });
  const receipt = await pub().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} reverted`);
}

async function setDailyLimit(perDay: bigint) {
  const expiry = (await pub().getBlock()).timestamp + 30n * 86_400n;
  // The contract refuses a per-task limit above the daily one.
  const perTask = perDay < parseEther("0.0005") ? perDay : parseEther("0.0005");
  await ownerCall(allowance, allowanceAbi, "setRules", ["0x0000000000000000000000000000000000000000", perTask, perDay, expiry]);
}

function paidAgent(price: string, extra: { retainerDiscountBps?: number; acceptsAxon?: boolean } = {}): string {
  const agent: Agent = {
    agentId: `chain-ret-${randomUUID().slice(0, 8)}`,
    name: "Retainer Chain Agent",
    capabilities: ["research"],
    publicKey: `pk-${randomUUID().slice(0, 6)}`,
    walletAddress: RECEIVER,
    provider: "anthropic",
    price,
    reputation: 0,
    createdAt: new Date().toISOString(),
  };
  createAgent(agent);
  getDb().prepare("UPDATE agents SET retainer_discount_bps = ?, accepts_axon = ? WHERE agent_id = ?")
    .run(extra.retainerDiscountBps ?? 0, extra.acceptsAxon ? 1 : 0, agent.agentId);
  return agent.agentId;
}

async function retain(agentId: string, over: Partial<RetainerInput> = {}) {
  const r = await createRetainer(OWNER.address, {
    agentId,
    instructions: "Scheduled check.",
    schedule: { kind: "interval", everyHours: 4 },
    payIn: "ETH",
    maxPriceWei: parseEther("0.0005"),
    ...over,
  }, { nowMs: T0 });
  // Only this retainer runs: every other one is parked far ahead, and cancelled at the end of its test.
  getDb().prepare(`UPDATE retainers SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE retainer_id != ? AND status = 'active'`).run(r.retainerId);
  return r;
}

const runs = (retainerId: string) =>
  getDb().prepare(`SELECT * FROM retainer_runs WHERE retainer_id = ? ORDER BY scheduled_for`).all(retainerId) as {
    status: string; skip_reason: string | null; task_id: string | null; price_wei: string | null; error: string | null; scheduled_for: string;
  }[];
const openRun = (retainerId: string) => runs(retainerId).find((r) => r.status === "running")!;

/** The task finishes the way the worker finishes it: status, then the payment path. */
async function finish(taskId: string, outcome: "completed" | "failed") {
  getDb().prepare(`UPDATE tasks SET status = ?, output = ?, completed_at = ? WHERE task_id = ?`)
    .run(outcome, outcome === "completed" ? "done" : null, new Date().toISOString(), taskId);
  if (outcome === "completed") releasePayment(taskId);
  else refundPayment(taskId);
  await reconcileAllowances();
}

describe.skipIf(!available)("retainers on a real chain", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    const port = 19_545 + Math.floor(Math.random() * 1000);
    rpc = `http://127.0.0.1:${port}`;
    anvil = spawn(ANVIL, ["--port", String(port), "--chain-id", "4663", "--silent"], { stdio: "ignore" });
    await waitFor(rpc);

    const token = await deploy(TOKEN_ARTIFACT, []);
    axon = token.address;
    if (axon.toLowerCase() !== PREDICTED_AXON.toLowerCase()) throw new Error(`token landed at ${axon}, not ${PREDICTED_AXON}`);
    tokenAbi = token.abi;
    const c = await deploy(ALLOWANCE_ARTIFACT, [RECEIVER, axon, DEPLOYER.address, OPERATOR]);
    allowance = c.address;
    allowanceAbi = c.abi;

    process.env.AXON_RPC_URL = rpc;
    process.env.AXON_ALLOWANCE_ADDRESS = allowance;
    process.env.AXON_ALLOWANCE_OPERATOR_KEY = OPERATOR_KEY;
    process.env.AXON_SETTLEMENT_TOKEN_ADDRESS = axon;
    resetRpcCircuit();

    await ownerCall(allowance, allowanceAbi, "deposit", [], parseEther("0.01"));
    await setDailyLimit(parseEther("0.005"));
    getTier.mockResolvedValue(tierOf("base", 0));
  }, 60_000);

  afterAll(() => {
    anvil?.kill();
    delete process.env.AXON_ALLOWANCE_ADDRESS;
    delete process.env.AXON_ALLOWANCE_OPERATOR_KEY;
    delete process.env.AXON_SETTLEMENT_TOKEN_ADDRESS;
    delete process.env.AXON_RPC_URL;
  });

  it("a week of a 4-hourly retainer: paid runs settle, a failed one comes back, downtime bills nothing extra", async () => {
    const agent = paidAgent("0.0001 ETH", { retainerDiscountBps: 2000 });
    const r = await retain(agent);
    const price = parseEther("0.00008"); // 0.0001 less the agent's 20% retainer discount
    const receiverBefore = await pub().getBalance({ address: RECEIVER });
    const ownerBefore = (await readAccount(OWNER.address)).available;

    // 06:00 runs and completes.
    await runDueRetainers(T0);
    const first = openRun(r.retainerId);
    expect(first.price_wei).toBe(price.toString());
    expect(await reservationState(taskKey(first.task_id!))).toBe("reserved");
    await finish(first.task_id!, "completed");
    expect(await reservationState(taskKey(first.task_id!))).toBe("settled");

    // 10:00 runs and fails: the money comes back.
    settleRetainerRuns(T0 + 1 * H);
    await runDueRetainers(T0 + 4 * H);
    const second = openRun(r.retainerId);
    await finish(second.task_id!, "failed");
    expect(await reservationState(taskKey(second.task_id!))).toBe("released");

    // Axon is down from 14:00 until 23:10. Only the latest slot (22:00) runs, too late to count: one
    // missed record per gap, and nothing is paid for any of them.
    settleRetainerRuns(T0 + 5 * H);
    await runDueRetainers(T0 + 17 * H + 10 * 60_000);
    const statuses = runs(r.retainerId).map((x) => x.skip_reason ?? x.status);
    expect(statuses).toEqual(["completed", "failed", "missed", "missed"]);

    // The next slot, 02:00, runs normally and completes.
    await runDueRetainers(T0 + 20 * H);
    const third = openRun(r.retainerId);
    await finish(third.task_id!, "completed");
    settleRetainerRuns(T0 + 21 * H);

    // Two runs paid, one refunded, nothing else touched.
    expect((await pub().getBalance({ address: RECEIVER })) - receiverBefore).toBe(price * 2n);
    expect(ownerBefore - (await readAccount(OWNER.address)).available).toBe(price * 2n);
    expect(getRetainer(r.retainerId)).toMatchObject({ status: "active", runsDone: 3, consecutiveFailures: 0 });
    getDb().prepare(`UPDATE retainers SET status = 'cancelled', next_run_at = NULL WHERE retainer_id = ?`).run(r.retainerId);
  });

  it("the contract's daily limit refuses runs in words, and three refusals pause it", async () => {
    const agent = paidAgent("0.0002 ETH");
    const r = await retain(agent);
    await setDailyLimit(parseEther("0.0001")); // below one run
    const nonceBefore = await pub().getTransactionCount({ address: OPERATOR });

    for (let i = 0; i < 3; i++) await runDueRetainers(T0 + i * 4 * H);

    const refused = runs(r.retainerId);
    expect(refused.map((x) => x.skip_reason)).toEqual(["allowance_refused", "allowance_refused", "allowance_refused"]);
    expect(refused[0].error).toMatch(/limit/i);
    expect(getRetainer(r.retainerId)).toMatchObject({ status: "paused", pauseReason: "failures" });
    // Refused before anything was sent: the operator spent no gas on it.
    expect(await pub().getTransactionCount({ address: OPERATOR })).toBe(nonceBefore);

    await setDailyLimit(parseEther("0.005"));
    getDb().prepare(`UPDATE retainers SET status = 'cancelled', next_run_at = NULL WHERE retainer_id = ?`).run(r.retainerId);
  });

  it("after a sell, an hourly retainer pays only at the new tier's pace", async () => {
    getTier.mockResolvedValue(tierOf("holder", 1));
    const agent = paidAgent("0.0001 ETH");
    const r = await retain(agent, { schedule: { kind: "interval", everyHours: 1 } });
    const receiverBefore = await pub().getBalance({ address: RECEIVER });

    for (let i = 0; i <= 4; i++) {
      if (i === 1) getTier.mockResolvedValue(tierOf("base", 0)); // sold after the first run
      await runDueRetainers(T0 + i * H);
      const open = runs(r.retainerId).find((x) => x.status === "running");
      if (open) await finish(open.task_id!, "completed");
      settleRetainerRuns(T0 + i * H + 30 * 60_000);
    }

    expect(runs(r.retainerId).map((x) => x.skip_reason ?? x.status)).toEqual(["completed", "tier_pace", "tier_pace", "tier_pace", "completed"]);
    expect((await pub().getBalance({ address: RECEIVER })) - receiverBefore).toBe(parseEther("0.0001") * 2n);
    getTier.mockResolvedValue(tierOf("base", 0));
    getDb().prepare(`UPDATE retainers SET status = 'cancelled', next_run_at = NULL WHERE retainer_id = ?`).run(r.retainerId);
  });

  it("an operator out of gas is Axon's problem: nothing charged, nothing held against the owner, and the status page says so", async () => {
    const agent = paidAgent("0.0001 ETH");
    const r = await retain(agent);
    const setBalance = (wei: bigint) => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [OPERATOR, `0x${wei.toString(16)}`] }) });
    await setBalance(1000n);
    const ownerBefore = (await readAccount(OWNER.address)).available;

    for (let i = 0; i < 4; i++) await runDueRetainers(T0 + i * 4 * H);
    expect(runs(r.retainerId).map((x) => x.skip_reason)).toEqual(["payment_unavailable", "payment_unavailable", "payment_unavailable", "payment_unavailable"]);
    expect(runs(r.retainerId)[0].error).toMatch(/Nothing was charged/);
    expect(getRetainer(r.retainerId)).toMatchObject({ status: "active", consecutiveFailures: 0 });
    expect((await readAccount(OWNER.address)).available).toBe(ownerBefore);

    await checkOperatorGas(Date.now(), true);
    expect(getSystemStatus().components.find((c) => c.name === "Allowance payments")).toMatchObject({ status: "degraded" });

    // Topped up: the next slot pays as normal, and the status page clears.
    await setBalance(parseEther("1"));
    await runDueRetainers(T0 + 16 * H);
    expect(openRun(r.retainerId).price_wei).toBe(parseEther("0.0001").toString());
    await checkOperatorGas(Date.now(), true);
    expect(getSystemStatus().components.find((c) => c.name === "Allowance payments")).toMatchObject({ status: "operational" });
    await finish(openRun(r.retainerId).task_id!, "completed");
    getDb().prepare(`UPDATE retainers SET status = 'cancelled', next_run_at = NULL WHERE retainer_id = ?`).run(r.retainerId);
  });

  it("pays in $AXON from the discounted price, and settles the quoted amount", async () => {
    await ownerCall(axon, tokenAbi, "mint", [OWNER.address, parseEther("10000")]);
    await ownerCall(axon, tokenAbi, "approve", [allowance, parseEther("10000")]);
    await ownerCall(allowance, allowanceAbi, "depositToken", [axon, parseEther("1")]);
    await ownerCall(allowance, allowanceAbi, "setRules", [axon, parseEther("0.5"), parseEther("1"), (await pub().getBlock()).timestamp + 30n * 86_400n]);

    const agent = paidAgent("0.0001 ETH", { retainerDiscountBps: 1000, acceptsAxon: true });
    getDb().prepare("UPDATE agents SET axon_discount_bps = 2000 WHERE agent_id = ?").run(agent);
    const r = await retain(agent, { payIn: "AXON" });
    const receiverBefore = (await pub().readContract({ address: axon, abi: tokenAbi, functionName: "balanceOf", args: [RECEIVER] })) as bigint;

    await runDueRetainers(T0);
    const run = openRun(r.retainerId);
    await finish(run.task_id!, "completed");

    // 0.0001 ETH, 10% off for the retainer, then 20% off for paying in $AXON, at 1 $AXON per ETH.
    const received = ((await pub().readContract({ address: axon, abi: tokenAbi, functionName: "balanceOf", args: [RECEIVER] })) as bigint) - receiverBefore;
    expect(received).toBe(parseEther("0.000072"));
    getDb().prepare(`UPDATE retainers SET status = 'cancelled', next_run_at = NULL WHERE retainer_id = ?`).run(r.retainerId);
  });
});

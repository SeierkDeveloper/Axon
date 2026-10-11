// One-shot hire: discover → (pay, if priced) → submit → poll to completion →
// receipt, in a single call. The code mirror of the in-browser hire flow — the
// demand-side counterpart to the agent runtime.
//
//   const result = await hire(axon, {
//     to: "research-agent",
//     task: "Summarize the top 5 L2s by TVL",
//     pay,            // omit for free-lane agents
//   });
//   console.log(result.output);   // the answer
//   console.log(result.receipt);  // the verifiable proof

import type { AxonClient } from "./client";
import type { HireOptions, HireResult, Receipt, TaskRequest, WaitOptions, X402Requirements } from "./types";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Hire an agent and wait for the result. Handles both lanes automatically:
 * free-lane agents run anonymously; priced agents are paid via x402 using the
 * supplied `pay` function. Polls the task to completion and (by default) returns
 * the verifiable receipt alongside the output.
 *
 * The private output is read back with the hire's own claim token when it was made
 * as "anonymous" (the default), otherwise as the `from` identity of an initialized
 * (`init({ apiKey })`) client: your wallet address, or an agent you own.
 *
 * A job can pause on its hirer: the agent asks a question, or its plan waits for
 * approval. Pass `onQuestion` / `onPlan` to deal with those; without them the job
 * goes on by itself once its wait runs out.
 */
export async function hire(client: AxonClient, opts: HireOptions): Promise<HireResult> {
  const {
    to,
    task,
    context,
    from = "anonymous",
    pay,
    paymentMethod,
    pollIntervalMs = 2000,
    timeoutMs = 120_000,
    withReceipt = true,
    work = {},
  } = opts;

  let created: TaskRequest;
  let paid: boolean;

  if (paymentMethod === "allowance") {
    // Paid from the on-chain allowance of the wallet this client's key belongs to. No x402 probe and
    // no `pay` function: the server reserves the price inside the owner's rules and the key's limits,
    // or refuses with the reason. The hire is made as that wallet, which is also what lets this
    // client read the output back afterwards.
    let payer = from;
    if (payer === "anonymous") {
      const status = await client.getAllowance();
      if (!status.enabled) throw new Error("Allowance payments are not available on this network");
      payer = status.wallet;
    }
    created = await client.sendTask({
      from: payer,
      to,
      task,
      context,
      ...work,
      paymentMethod: "allowance",
      ...(opts.payWith === "axon" ? { payIn: "AXON" as const } : {}),
    });
    paid = true;
  } else if (paymentMethod === "balance") {
    // Fund the hire from the `from` agent's earned balance — no x402 probe, no
    // `pay` function. The value is already pooled from when it earned. Requires an
    // authenticated, registered `from` (an identity that owns a balance).
    if (from === "anonymous") {
      throw new Error(
        'paymentMethod "balance" requires an authenticated `from` agent — init the client with an apiKey and set `from` to an agent you own. Balance is spent from that agent\'s earnings.',
      );
    }
    created = await client.sendTask({ from, to, task, context, ...work, paymentMethod: "balance" });
    paid = true;
  } else {
    // Is this agent priced? A 402 means yes (and carries the requirements); null
    // means free. Never trust a guess — ask the endpoint.
    let requirements: X402Requirements | null = null;
    try {
      requirements = await client.getX402Requirements(to);
    } catch {
      // If the probe itself fails, fall through to the free path; a genuinely paid
      // agent will reject an unpaid submit with a clear 402 below.
      requirements = null;
    }
    paid = requirements !== null;

    if (paid && !pay) {
      throw new Error(
        `Agent "${to}" is priced (x402) — pass a \`pay\` function to hire it, or set paymentMethod:"balance" to spend the \`from\` agent's earned balance. Free-lane agents need no payment.`,
      );
    }

    // Create the task — paid via x402, or free/anonymous.
    if (paid && pay) {
      created = await client.submitTaskX402(to, task, pay, { from, context, payWith: opts.payWith });
    } else {
      created = await client.sendTask({ from, to, task, context, ...work });
    }
  }

  // a hire made without signing in is read back, and acted on, with its own token
  const claimToken = created.claimToken;
  const waited = await waitForTask(client, created, { claimToken, pollIntervalMs, timeoutMs, onQuestion: opts.onQuestion, onPlan: opts.onPlan });
  const current = waited.task;

  const result: HireResult = {
    taskId: current.taskId,
    status: current.status,
    paid,
    timedOut: waited.timedOut,
    ...(claimToken ? { claimToken } : {}),
  };
  if (waited.timedOut) return result;
  if (current.status === "completed") {
    result.output = current.output ?? "";
    if (current.outputFiles?.length) result.files = current.outputFiles;
    if (current.pages?.length) result.pages = current.pages;
    if (current.sent?.length) result.sent = current.sent;
    if (withReceipt) {
      try {
        const receipt: Receipt = (await client.getReceipt(current.taskId)).receipt;
        result.receipt = receipt;
      } catch {
        // The result stands even if the receipt isn't fetchable yet.
      }
    }
  } else if (current.status === "cancelled") {
    result.error = "The job was called off before it delivered. Whatever was paid for it is refunded.";
  } else {
    result.error = current.error ?? "Task failed";
  }
  return result;
}

const DONE = new Set(["completed", "failed", "cancelled"]);

/**
 * Follow a job until it has finished, failed or been called off, or until `timeoutMs` runs out. While it pauses on
 * its hirer, `onQuestion` and `onPlan` are asked what to do, once for each question and each plan.
 */
export async function waitForTask(client: AxonClient, job: TaskRequest | string, opts: WaitOptions = {}): Promise<{ task: TaskRequest; timedOut: boolean }> {
  const { pollIntervalMs = 2000, timeoutMs = 120_000, claimToken } = opts;
  const who = claimToken ? { claimToken } : {};
  let current: TaskRequest = typeof job === "string" ? await client.getTask(job, who) : job;
  const deadline = Date.now() + timeoutMs;
  const answered = new Set<number>(), decided = new Set<number>();
  while (!DONE.has(current.status)) {
    if (current.status === "waiting") {
      const q = current.question, p = current.plan;
      if (q && opts.onQuestion && !answered.has(q.n)) {
        answered.add(q.n);
        const said = await opts.onQuestion(q, current);
        if (typeof said === "string" && said.trim()) await client.answerQuestion(current.taskId, said, who).catch(() => {});
      } else if (p && opts.onPlan && !decided.has(p.n)) {
        decided.add(p.n);
        const choice = await opts.onPlan(p, current);
        if (choice === "approve" || choice === "cancel") await client.decidePlan(current.taskId, choice, who).catch(() => {});
        else if (choice && typeof choice === "object" && choice.change) await client.decidePlan(current.taskId, "change", { ...who, change: choice.change }).catch(() => {});
      }
    }
    if (Date.now() >= deadline) return { task: current, timedOut: true };
    await sleep(pollIntervalMs);
    try {
      current = await client.getTask(current.taskId, who);
    } catch {
      // Transient read failure: keep polling until the deadline.
    }
  }
  return { task: current, timedOut: false };
}

// Hosted agents that hire. When an "orchestrator" agent is hired for a job, the
// worker runs THIS instead of a single model call: the agent decomposes the job,
// hires specialists from the marketplace (paid from its own balance, bounded by
// its budget), waits for their work, and synthesizes the final deliverable. The
// marketplace's own agents shop the marketplace.
//
// Runs in the background (fired by the worker, not awaited) so the worker's next
// poll cycles execute the sub-hires this creates, while this polls them to done.

import type { Agent } from "@/sdk/types";
import { getProvider } from "./providers";
import { createHiredTask, parsePlan, type ThinkFn } from "./planner";
import { rankAgents, selectAgent } from "./routing";
import { getTaskById, completeTask, failTask, type Task } from "./tasks";
import { settleCompletedTask } from "./sla";
import { parsePriceToEth, refundPayment } from "./payments";
import { refundDebitForTask } from "./mpp";
import { recordSubcontract } from "./subcontracts";
import { formatContext } from "./formatContext";
import { logger } from "./logger";
import {
  adoptOutputs, agentReads, attachmentsForTask, filesEnabled, filesOfTask, fitForHire, listFiles, passFiles, storeReport,
  CONTEXT_KEY, REPORT_KEY, REPORT_NOTE, type FileRow, type ModelAttachment,
} from "./agentFiles";
import { getMcpServerByAgentId } from "./mcp";
import { isWalletAddress } from "./address";
import { liveLog } from "./liveLog";
import { captureModelStep } from "./modelUsage";
import { estimateCostUsd, hashContent, safeAppendTraceEvent } from "./traceEvents";

const ORCH_SYSTEM =
  "You are an orchestrator agent on the Axon marketplace. When a job needs skills beyond your own, you break it into parts, hire a specialist for each, and assemble a clear final deliverable. You reason concisely and produce concrete, usable output, no filler.";

const planPrompt = (job: string, maxSteps: number) =>
  `You've been hired for the job below. If you can do it well yourself in one shot, return an empty array. If it needs specialists, break it into at most ${maxSteps} sub-tasks, each handled by one specialist.

Job: ${job}

Return ONLY a JSON array (it may be empty), each item: {"capability": "<one lowercase keyword for the kind of specialist, e.g. research, writing, analysis, fact-checking>", "task": "<a self-contained instruction for that specialist>"}. Order them so earlier results feed later ones.`;

const synthPrompt = (job: string, parts: { task: string; output: string }[], made: { name: string; by: string }[] = []) =>
  `You are assembling the final deliverable for a job from the work of specialists you hired.

Job: ${job}

The specialists returned:
${parts.map((p, i) => `--- Specialist ${i + 1} (${p.task}) ---\n${p.output}`).join("\n\n")}
${made.length ? `\nFiles the specialists made, which the person receives alongside your answer: ${made.map((f) => `${f.name} (by ${f.by})`).join(", ")}. Refer to them by name where they help; do not describe how to open them.\n` : ""}
Write the final deliverable now: a clear, well-structured, self-contained result that fulfils the job. Do not mention it was assembled from parts.`;

const short = (s: string, max = 90): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
};

export interface OrchestrationOptions {
  maxSteps?: number;
  perHireTimeoutMs?: number;
  pollMs?: number;
  /** Injected for tests; defaults to the agent's real provider. */
  think?: ThinkFn;
  /**
   * Who else may not be hired, beyond the orchestrator's own rules (a business hires only verified agents of other
   * owners). The best specialist that passes is taken.
   */
  accept?: (worker: Agent) => boolean;
  /**
   * How one specialist is hired. Defaults to paying from the agent's own balance (createHiredTask). Throws to skip the
   * part, with the reason in the message, the way a budget cap or a short balance does.
   */
  hire?: (worker: Agent, task: string, context?: Record<string, unknown>) => Promise<{ taskId: string; price: string | null }>;
}

/**
 * Run one orchestration for `agent`'s hired `task`. Completes (and settles) the
 * task on success; throws on failure so the worker fails + refunds it. Any budget
 * or balance shortfall on a sub-hire simply skips that part — it never strands
 * the whole job.
 */
export async function runOrchestration(agent: Agent, task: Task, opts: OrchestrationOptions = {}): Promise<void> {
  const maxSteps = opts.maxSteps ?? 4;
  // Ceiling per specialist, not the expected wait — pollOutput returns the moment a
  // hire is terminal. Sized to cover a queue wait (workers run at low concurrency)
  // plus one model call, so a normal specialist is never abandoned prematurely.
  const perHireTimeoutMs = opts.perHireTimeoutMs ?? 300_000;
  const pollMs = opts.pollMs ?? 1500;
  // Files handed over with the hire. The agent reads them itself (text in its prompt, PDFs and pictures as
  // themselves) and they travel on to every specialist it hires. Nothing is read while files are off.
  const files = filesEnabled();
  const handed: { text: string; attachments: ModelAttachment[]; files: FileRow[] } = files
    ? await attachmentsForTask(task.taskId)
    : { text: "", attachments: [], files: [] };
  const wantsReport = files && task.context?.[REPORT_KEY] === true;
  const hirerWallet = isWalletAddress(task.fromAgent) ? task.fromAgent : null;
  // Each of its own model calls (the plan, the answer put together) is a step in the job's trace with what it cost,
  // the way a single agent's call is, so the receipt and anything that reads the job's costs see them.
  const think: ThinkFn =
    opts.think ??
    (async (prompt, o) => {
      const step = await captureModelStep(() =>
        getProvider(agent).complete(ORCH_SYSTEM, prompt, o?.maxTokens ?? 1200, undefined, handed.attachments.length ? handed.attachments : undefined));
      safeAppendTraceEvent({
        traceId: task.traceId ?? task.taskId, taskId: task.taskId, kind: "step.model", fromAgent: task.fromAgent, toAgent: task.toAgent,
        workflowId: task.workflowId ?? null, stepIndex: task.stepIndex ?? null, inputHash: hashContent(prompt), outputHash: hashContent(step.result),
        model: step.model ?? null, inputTokens: step.inputTokens || null, outputTokens: step.outputTokens || null,
        costUsd: estimateCostUsd(step.model, step.inputTokens, step.outputTokens), latencyMs: step.latencyMs,
      });
      return step.result;
    });

  // Watch it work: the team as it forms, a line a step, for whoever hired the agent to follow.
  const live = liveLog(task.taskId);
  live.say(`Picked up by ${agent.name}`);
  for (const f of handed.files) live.say(`Reading ${f.name}`);

  // Fold any buyer-supplied context into the job the orchestrator reasons about —
  // parity with the normal worker path (task.task + formatContext(task.context)).
  // Without this, reference material the buyer attached is invisible to planning,
  // synthesis, and the solo fallback.
  const jobText = task.task + formatContext(task.context) + handed.text;

  // 1. Plan — decompose into specialist parts, or decide to do it directly.
  let steps: { capability: string; task: string }[] = [];
  try {
    const raw = await think(planPrompt(jobText, maxSteps), { maxTokens: 1200 });
    steps = parsePlan(raw).slice(0, maxSteps);
  } catch {
    steps = [];
  }
  live.say(steps.length ? `Split the job into ${steps.length} ${steps.length === 1 ? "part" : "parts"}` : "Doing this one without a team");

  // 2. Hire a specialist for each part, from the agent's own balance, and collect results.
  const parts: { task: string; output: string }[] = [];
  // what the team has made so far: handed to each later specialist, and to the hirer with the answer
  const made: { row: FileRow; by: string }[] = [];
  for (const step of steps) {
    // Stop doing paid work if the job died under us — e.g. an SLA sweep failed and
    // refunded the parent while this loop was mid-flight. Hiring more specialists
    // would spend the orchestrator's balance on a job that can no longer pay it.
    if (getTaskById(task.taskId)?.status !== "running") {
      logger.info("orchestration.parent_gone", "Parent task no longer running, stopping orchestration", {
        taskId: task.taskId,
      });
      return;
    }
    // A blank capability would route to an arbitrary top agent (searchAgents drops
    // empty filters); a blank task would hire a specialist with no instruction.
    // Skip either rather than hire someone unrelated to do nothing.
    if (!step.capability?.trim() || !step.task?.trim()) continue;
    const routed = opts.accept
      ? (() => {
          const found = rankAgents({ capability: step.capability, fromAgent: agent.agentId, exclude: [agent.agentId] }).find((c) => !c.agent.orchestrator && opts.accept!(c.agent));
          return found ? { agent: found.agent } : null;
        })()
      : selectAgent({ capability: step.capability, fromAgent: agent.agentId, exclude: [agent.agentId] });
    // v1: orchestrators hire non-orchestrator specialists only. Excluding self stops
    // a direct self-hire; refusing to hire another orchestrator stops cycles (A→B→A)
    // and unbounded nested fan-out. Nested teams can be enabled later behind a depth cap.
    if (!routed || routed.agent.orchestrator) {
      logger.info("orchestration.step_unroutable", "No eligible specialist for a step, skipping", {
        taskId: task.taskId,
        capability: step.capability,
      });
      live.say(`No specialist found for ${short(step.capability, 40)}`);
      continue;
    }
    // Give each specialist the buyer's original context (reference material the job
    // depends on) plus the work assembled so far, so a later step can build on
    // earlier ones (e.g. "write from the research"). The worker appends this to the
    // specialist's prompt. priorResults last so it can't be shadowed by a buyer key.
    const context: Record<string, unknown> = { ...(task.context ?? {}) };
    // Files travel with the work: the hirer's own first, then what the team has made, newest first, as far as one
    // hire of this specialist may carry. Its context lists exactly the files it is handed, so its commitment covers
    // them; the answer as a file is asked of the orchestrator alone, not of each specialist.
    let passing: FileRow[] = [];
    if (files) {
      delete context[CONTEXT_KEY];
      delete context[REPORT_KEY];
      const fit = fitForHire(
        [...handed.files, ...made.map((m) => m.row).reverse()],
        agentReads(routed.agent, { runsThroughMcp: Boolean(getMcpServerByAgentId(routed.agent.agentId)) }),
        parsePriceToEth(routed.agent.price ?? undefined) !== null,
      );
      passing = fit.rows;
      if (passing.length) context[CONTEXT_KEY] = listFiles(passing);
      if (fit.left.length) logger.info("orchestration.files_left", "Some files were not handed to a specialist", { taskId: task.taskId, toAgent: routed.agent.agentId, left: fit.left });
    }
    if (parts.length > 0) context.priorResults = parts;
    const hireContext = Object.keys(context).length > 0 ? context : undefined;
    let hire: { taskId: string; price: string | null };
    try {
      hire = opts.hire ? await opts.hire(routed.agent, step.task, hireContext) : createHiredTask(agent.agentId, routed.agent.agentId, step.task, hireContext);
    } catch (err) {
      // budget cap, insufficient balance, or no worker — skip this part, keep going.
      // A brand-new orchestrator with no earned ETH yet hits this on every priced
      // hire and quietly answers solo, so surface why rather than failing silently.
      logger.info("orchestration.hire_skipped", "Could not hire a specialist, skipping step", {
        taskId: task.taskId,
        toAgent: routed.agent.agentId,
        reason: err instanceof Error ? err.message : String(err),
      });
      live.say(`Could not hire ${routed.agent.name}`);
      continue;
    }
    // attached in the same breath as the hire is created, so the worker never picks it up without them
    if (passing.length) passFiles(passing, hire.taskId);
    live.say(`Hired ${routed.agent.name}: ${short(step.task)}`);
    recordSubcontract({
      parentTaskId: task.taskId,
      childTaskId: hire.taskId,
      fromAgent: agent.agentId,
      toAgent: routed.agent.agentId,
      price: hire.price,
    });
    const output = await pollOutput(hire.taskId, perHireTimeoutMs, pollMs);
    if (output) {
      parts.push({ task: step.task, output });
      live.say(`${routed.agent.name} delivered`);
      if (files) {
        // what the specialist made is the hirer's too, and the next specialist's to work on
        for (const row of filesOfTask(hire.taskId, "out")) made.push({ row, by: routed.agent.name });
        for (const f of adoptOutputs(task.taskId, hire.taskId, { wallet: hirerWallet })) live.say(`${routed.agent.name} made ${f.name}`);
      }
    } else {
      live.say(`${routed.agent.name} did not deliver`);
      // Timed out or the specialist never ran (e.g. an endpoint agent with no live
      // worker). Release the escrow so a slow/undelivered hire can't drain the
      // orchestrator's balance or lock funds forever. failTask no-ops (and no refund
      // fires) if the specialist already reached a terminal state — no double refund.
      if (failTask(hire.taskId, "orchestration: specialist did not deliver in time")) {
        refundPayment(hire.taskId);
        refundDebitForTask(hire.taskId);
      }
    }
  }

  // If the job died while we were gathering the team's work, don't spend a model
  // call synthesizing a deliverable for a task that can no longer accept one.
  if (getTaskById(task.taskId)?.status !== "running") {
    logger.info("orchestration.parent_gone", "Parent task no longer running, skipping synthesis", {
      taskId: task.taskId,
    });
    return;
  }

  // 3. Synthesize the deliverable — or, if it assembled no team, answer the job itself.
  live.say(parts.length > 0 ? "Putting it together" : "Writing the answer");
  const closing = wantsReport ? REPORT_NOTE : "";
  const deliverable =
    parts.length > 0
      ? (await think(synthPrompt(jobText, parts, made.map((m) => ({ name: m.row.name, by: m.by }))) + closing, { maxTokens: 3000 })).trim()
      : (await think(jobText + closing, { maxTokens: 2000 })).trim();

  // The answer as a file, kept before the job completes so its commitment covers the file too.
  if (wantsReport) {
    const kept = storeReport({ taskId: task.taskId, output: deliverable, agentName: agent.name, wallet: hirerWallet });
    if (kept?.ok) live.say(`Saved the answer as ${kept.file.name}`);
  }

  // 4. Complete + settle the orchestrator's own hired task.
  if (completeTask(task.taskId, deliverable)) settleCompletedTask(task.taskId);
}

/** Poll a hired sub-task to a terminal state and return its output (undefined if it fails/times out). */
async function pollOutput(taskId: string, timeoutMs: number, pollMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = getTaskById(taskId);
    if (t?.status === "completed") return t.output ?? "";
    if (t?.status === "failed") return undefined;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return undefined;
}

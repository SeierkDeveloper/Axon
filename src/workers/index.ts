import { getTasksByAgent, startTask, completeTask, failTask } from "../lib/tasks";
import { refundPayment } from "../lib/payments";
import { settleCompletedTask } from "../lib/sla";
import { refundDebitForTask } from "../lib/mpp";
import { getAllAgents, getAgentById } from "../lib/agents";
import { runOrchestration } from "../lib/orchestrator";
import { getSubcontractsForParent } from "../lib/subcontracts";
import { getDb } from "../lib/db";
import { syncToTurso } from "../lib/db-turso";
import { listMcpServers, createMcpAgentHandler } from "../lib/mcp";
import { deliverPendingWebhooks } from "../lib/webhooks";
import { recordTaskLatency } from "../lib/metrics";
import { formatContext } from "../lib/formatContext";
import { isWalletAddress } from "../lib/address";
import { attachmentsForTask, CODE_MAX_TOKENS, codeEnabled, filesEnabled, keepOutput, readBytes, REPORT_KEY, REPORT_NOTE, storeReport } from "../lib/agentFiles";
import { conversationBefore, earlierTurns, followUpEnabled, FOLLOW_KEY } from "../lib/followUp";
import { markRevision, REVISE_NOTE } from "../lib/revisions";
import { askEnabled, askedSoFar, askTool, closeStrays, mayAsk, parkForAnswer, resumeOverdue, withAsk, ASK_KEY, type Question } from "../lib/ask";
import { notesAtStart, notesMidway, recordDelivered, steerEnabled, takeNotes, wasStopped } from "../lib/steer";
import { officeEnabled, wantsOffice, OFFICE_MAX_TOKENS, OFFICE_NOTE } from "../lib/officeFiles";
import { canNote, memoryEnabled, memoryNote, memoryOwnerOf, rememberTool, withRemember } from "../lib/agentMemory";
import { approvedNote, approveOverdue, keepPlan, parkForPlan, planEnabled, planNote, planStage, plansOf, PLAN_KEY, PLAN_MAX_TOKENS } from "../lib/planFirst";
import { hasCode, withCode } from "../lib/agentTools";
import { liveLog } from "../lib/liveLog";
import { mayDraw, pictureTool, withPictures } from "../lib/agentPictures";
import { asksForFile, asksToSend, BROWSER_MAX_TOKENS, BROWSER_STEPS, browserTool, mayBrowse, refusalLine, withBrowser } from "../lib/browserTool";
import { recordSent } from "../lib/taskSent";
import { recordPage } from "../lib/taskPages";
import { triggersEnabled } from "../lib/triggers";
import { runChainTriggers } from "../lib/triggerChain";
import { runPageTriggers } from "../lib/triggerPage";
import { retryFileCommitments } from "../lib/outputCommitment";
import type { SandboxFile } from "../lib/providers";
import { runWithProvider, runWithProviderTools, getAgentMaxTokens } from "../lib/providers";
import { limitsForAgent } from "../lib/agentTierLimits";
import type { ToolCallEvent } from "../lib/providers";
import { resolveAgentTools, hasTools } from "../lib/agentTools";
import { safeAppendTraceEvent, hashContent, estimateCostUsd, captureModelStep } from "../lib/traceEvents";
import { verifyAgentEndpoint } from "../lib/verification";
import { logger } from "../lib/logger";
import { runWithTraceId } from "../lib/tracing";
import { checkAllThresholds } from "../lib/spendThreshold";
import { reconcileAllowances } from "../lib/allowancePayment";
import { allowancesEnabled } from "../lib/allowancePolicy";
import { checkOperatorGas } from "../lib/allowanceGas";
import { runDueRetainers, settleRetainerRuns, sweepStrandedRuns } from "../lib/retainerRunner";
import { deliverRetainerWebhooks } from "../lib/retainerWebhooks";
import { launch, drain, inFlightCount } from "./inflight";
import { runMyloPass } from "../lib/myloPass";
import { advanceRunningCrews } from "../lib/myloActions";
import { indexMinds } from "../lib/mindsIndex";
import { refreshStats } from "../lib/mindsStats";
import { thinkDue } from "../lib/mindsMind";
import { fireDue, settleOrders } from "../lib/mindsOrders";
import { trackOutcomes } from "../lib/mindsRecord";
import { reportDue } from "../lib/mindsReport";
import { actDue, settleSent, payThinkingDue, keepUp } from "../lib/mindsAct";

// Agents that append live market prices to their task message
const PRICE_AGENTS = new Set(["crypto-agent", "trading-agent"]);

// 3s: a workflow step only exists after the previous one completes, so the
// poll gap is paid per step — at 15s a 3-step pipeline wasted ~45s just waiting.
const POLL_INTERVAL_MS = 3_000;
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;
const THRESHOLD_INTERVAL_MS = 5 * 60 * 1000;
/** How often allowance reservations are settled or released. Well inside the owner's 24h reclaim window. */
const ALLOWANCE_INTERVAL_MS = 60 * 1000;
/** Retainers are scheduled to the minute; a tick a minute keeps every run inside its on-time window. */
const RETAINER_INTERVAL_MS = 60 * 1000;
/** Mylo looks at what happened on Axon (for its public feed and people's inboxes) every few minutes. */
const MYLO_PASS_INTERVAL_MS = 5 * 60 * 1000;
const MINDS_INDEX_INTERVAL_MS = 20 * 1000;
const SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.AXON_WORKER_SHUTDOWN_TIMEOUT_MS ?? "25000", 10);
// 10 min. Sized for a single inference (up to 3 retries × 120 s provider
// timeout); a tool-granted agent spends it across several model calls plus the
// searches and fetches between them, so the ceiling is the whole loop, not one
// call. Hitting it fails and refunds the task, and now also aborts the loop.
const TASK_TIMEOUT_MS = Number.parseInt(process.env.AXON_TASK_TIMEOUT_MS ?? "600000", 10);
const MAX_CONCURRENT_PER_AGENT = Number.parseInt(process.env.AXON_MAX_CONCURRENT_PER_AGENT ?? "1", 10);
const MAX_STUCK_RESETS = Number.parseInt(process.env.AXON_MAX_STUCK_RESETS ?? "3", 10);
const CIRCUIT_FAILURE_THRESHOLD = Number.parseInt(process.env.AXON_CIRCUIT_FAILURE_THRESHOLD ?? "5", 10);
const CIRCUIT_RECOVERY_WINDOW_MS = Number.parseInt(process.env.AXON_CIRCUIT_RECOVERY_WINDOW_MS ?? "300000", 10); // 5 min

// ── Per-agent circuit breaker ──────────────────────────────────────────────────
type CircuitState = "closed" | "open" | "half-open";
interface Circuit { state: CircuitState; failures: number; openedAt: number; }
const circuits = new Map<string, Circuit>();

function getCircuit(agentId: string): Circuit {
  let c = circuits.get(agentId);
  if (!c) { c = { state: "closed", failures: 0, openedAt: 0 }; circuits.set(agentId, c); }
  return c;
}

function isCircuitOpen(agentId: string): boolean {
  const c = getCircuit(agentId);
  if (c.state === "closed") return false;
  if (c.state === "open" && Date.now() - c.openedAt >= CIRCUIT_RECOVERY_WINDOW_MS) {
    c.state = "half-open";
    logger.info("worker.circuit_half_open", "Circuit breaker half-open, allowing probe task", { agentId });
  }
  return c.state === "open";
}

function recordCircuitSuccess(agentId: string): void {
  const c = getCircuit(agentId);
  if (c.state !== "closed") logger.info("worker.circuit_closed", "Circuit breaker closed after successful task", { agentId });
  c.state = "closed";
  c.failures = 0;
}

function recordCircuitFailure(agentId: string): void {
  const c = getCircuit(agentId);
  if (c.state === "half-open") {
    c.state = "open";
    c.openedAt = Date.now();
    c.failures++;
    logger.error("worker.circuit_opened", "Circuit breaker re-opened after failed probe", { agentId, recoveryWindowMs: CIRCUIT_RECOVERY_WINDOW_MS });
    return;
  }
  c.failures++;
  if (c.state === "closed" && c.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    c.state = "open";
    c.openedAt = Date.now();
    logger.error("worker.circuit_opened", "Circuit breaker opened, agent failing repeatedly", {
      agentId, consecutiveFailures: c.failures, recoveryWindowMs: CIRCUIT_RECOVERY_WINDOW_MS,
    });
  }
}
// ─────────────────────────────────────────────────────────────────────────────
let pollRunning = false;
let shutdownRequested = false;
let pollTimer: NodeJS.Timeout | null = null;
let healthTimer: NodeJS.Timeout | null = null;
let thresholdTimer: NodeJS.Timeout | null = null;
let allowanceTimer: NodeJS.Timeout | null = null;
let allowanceRunning = false;
let retainerTimer: NodeJS.Timeout | null = null;
let triggerTimer: NodeJS.Timeout | null = null;
let pageTimer: NodeJS.Timeout | null = null;
let triggerRunning = false;
let pageRunning = false;
let commitTimer: NodeJS.Timeout | null = null;
let commitRunning = false;
let myloTimer: NodeJS.Timeout | null = null;
let mindsTimer: NodeJS.Timeout | null = null;
let mindsRunning = false;
let mindsTicks = 0;
let retainerRunning = false;
let activePoll: Promise<void> | null = null;
let activeHealthCheck: Promise<void> | null = null;

async function fetchLivePrices(): Promise<string> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin&vs_currencies=usd&include_24hr_change=true&include_7d_change=true",
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return "";
    const data = await res.json() as Record<string, { usd: number; usd_24h_change: number; usd_7d_change?: number }>;
    const lines = Object.entries(data).map(([coin, d]) =>
      `${coin}: $${d.usd?.toLocaleString()} | 24h: ${d.usd_24h_change?.toFixed(2)}%${d.usd_7d_change !== undefined ? ` | 7d: ${d.usd_7d_change.toFixed(2)}%` : ""}`
    );
    return `\n\nLive market data:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/** How often a running job looks whether the person who hired it has stopped it. */
const STOP_CHECK_MS = 1_200;

async function processTasks() {
  // Reset worker-claimed tasks stuck in running longer than the task timeout.
  // HTTP streaming/gateway/manual tasks can legitimately run outside this worker.
  const stuckCutoff = new Date(Date.now() - TASK_TIMEOUT_MS).toISOString();

  // Dead-letter tasks that have hit the stuck-reset limit — they won't recover on their own.
  const deadLettered = getDb().prepare(
    "SELECT task_id FROM tasks WHERE status='running' AND started_by='worker' AND started_at < ? AND stuck_count >= ?"
  ).all(stuckCutoff, MAX_STUCK_RESETS) as { task_id: string }[];
  for (const { task_id } of deadLettered) {
    logger.warn("worker.task_dead_lettered", "Task dead-lettered after too many stuck resets", {
      taskId: task_id,
      maxStuckResets: MAX_STUCK_RESETS,
    });
    if (failTask(task_id, `Task dead-lettered after ${MAX_STUCK_RESETS} stuck resets`)) {
      refundPayment(task_id);
      refundDebitForTask(task_id);
    }
  }

  // Re-queue remaining stuck tasks and increment their reset counter.
  getDb().prepare(
    "UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL, stuck_count=stuck_count+1 WHERE status='running' AND started_by='worker' AND started_at < ? AND stuck_count < ?"
  ).run(stuckCutoff, MAX_STUCK_RESETS);

  void syncToTurso();

  // MCP servers have their own execution path (calls an external MCP endpoint)
  const mcpHandlers: Record<string, (task: string) => Promise<string>> = {};
  for (const server of listMcpServers("active")) {
    mcpHandlers[server.serverId] = createMcpAgentHandler(server.serverId);
  }

  // Gateway providers are handled synchronously in the HTTP layer — exclude them here
  // so their queued tasks aren't accidentally processed as inference tasks
  const gatewayIds = new Set(
    (getDb().prepare("SELECT provider_id FROM gateway_providers").all() as { provider_id: string }[])
      .map((r) => r.provider_id)
  );

  const agents = getAllAgents().filter((a) => !gatewayIds.has(a.agentId));

  // Only fetch live prices if a price agent actually has queued work
  const needsPrices = agents.some(
    (a) => PRICE_AGENTS.has(a.agentId) &&
      getTasksByAgent({ agentId: a.agentId, role: "recipient", status: "queued", limit: 1 }).length > 0
  );
  const livePrices = needsPrices ? await fetchLivePrices() : "";

  const processAgent = async (agent: (typeof agents)[number]) => {
    const mcpHandler = mcpHandlers[agent.agentId];
    // Endpoint agents run their own inference elsewhere, so the worker skips them —
    // EXCEPT orchestrators, which always run their hiring loop here (they think via
    // getProvider, which uses providerEndpoint, not this public endpoint). Without
    // this exception an orchestrator registered with an endpoint would silently
    // never run and every job hired to it would hang queued forever.
    if (agent.endpoint && !mcpHandler && !agent.orchestrator) return;

    if (isCircuitOpen(agent.agentId)) {
      logger.info("worker.circuit_skipped", "Skipping agent, circuit breaker open", { agentId: agent.agentId });
      return;
    }

    const queued = getTasksByAgent({
      agentId: agent.agentId,
      role: "recipient",
      status: "queued",
      limit: 5,
    });

    const getActiveCount = getDb().prepare(
      "SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ? AND status = 'running'"
    );
    for (const task of queued) {
      // Concurrency guard: skip if agent already has too many running tasks
      const activeCount = (getActiveCount.get(agent.agentId) as { n: number }).n;
      if (activeCount >= MAX_CONCURRENT_PER_AGENT) {
        logger.info("worker.concurrency_limit", "Agent at concurrency limit, skipping task", {
          agentId: agent.agentId,
          activeCount,
          limit: MAX_CONCURRENT_PER_AGENT,
        });
        return;
      }

      // Orchestrator agents don't answer with one model call — they hire a team.
      // Fire the orchestration in the background (started as "orchestrator" so the
      // "worker"-only stuck reaper leaves it alone) and move on, so the worker's
      // next poll cycles execute the sub-hires it creates. It completes/fails the
      // task itself when the team's work is assembled.
      if (agent.orchestrator) {
        const started = startTask(task.taskId, "orchestrator");
        if (!started) continue;
        logger.info("worker.orchestration_picked", "Orchestrator agent picked up a job", {
          agentId: agent.agentId,
          taskId: task.taskId,
        });
        // Run under the parent's traceId so every specialist it hires inherits the
        // same trace — without this, createHiredTask → resolveTraceId() mints a
        // fresh trace per sub-hire and the flight recorder can't show the team.
        void runWithTraceId(task.traceId ?? task.taskId, () =>
          runOrchestration(agent, task).catch((err) => {
            logger.error("worker.orchestration_failed", "Orchestration crashed", {
              err,
              agentId: agent.agentId,
              taskId: task.taskId,
            });
            if (failTask(task.taskId, err instanceof Error ? err.message : "orchestration failed")) {
              refundPayment(task.taskId);
              refundDebitForTask(task.taskId);
            }
          }),
        );
        continue;
      }

      // Claimed here, in the poll, so the concurrency count above sees it before the next task is
      // considered; executed on its own, so the poll moves straight on to the next agent.
      const started = startTask(task.taskId, "worker");
      if (!started) continue;
      logger.info("worker.task_picked", "Worker picked up task", {
        agentId: agent.agentId,
        taskId: task.taskId,
        hasMcpHandler: Boolean(mcpHandler),
      });

      launch(task.taskId, () => runWithTraceId(task.traceId ?? task.taskId, async () => {
        let timeoutTimer: NodeJS.Timeout | undefined;
        // Stop and steer: the watch that notices the person stopped the job, and whether they did
        let stopWatch: NodeJS.Timeout | undefined;
        // the job's browser, if it is given one: closed when the job ends, whichever way it ends
        let closeBrowser: (() => Promise<void>) | undefined;
        let stoppedByPerson = false;
        // set when this run stops to ask the person a question (see the ask tool below)
        let asked: Question | null = null;
        try {
          const prices = PRICE_AGENTS.has(agent.agentId) ? livePrices : "";
          // Files handed over with the hire: the text of text files follows the task in the message, and PDFs and
          // pictures go to the model as themselves. Nothing is read while the feature is off.
          const handed = filesEnabled() ? await attachmentsForTask(task.taskId) : { text: "", attachments: [], files: [] };
          // The hirer asked for the answer as a file as well: the agent is told, so it writes a document, not a chat reply.
          const wantsReport = filesEnabled() && task.context?.[REPORT_KEY] === true;
          // whoever hired it owns what it hands back; a visitor's files are read with the job's token instead
          const hirerWallet = isWalletAddress(task.fromAgent) ? task.fromAgent : null;
          // A follow-up: the agent is told so, and given the conversation so far, before the person's new words. The
          // note that says which job it follows is for the record, not for the agent, so it stays out of the context
          // the agent reads.
          const before = followUpEnabled() ? conversationBefore(task) : "";
          // The agent asks: what it asked earlier in this job and what came back follow the job's own words. A
          // question a dead run left open is closed first, since nobody is being asked now. Like the follow-up note,
          // the mark that says the agent may ask is for the record and stays out of what the agent reads.
          if (askEnabled()) closeStrays(task.taskId);
          const answered = askEnabled() ? askedSoFar(task.taskId) : "";
          const { [FOLLOW_KEY]: _followNote, [ASK_KEY]: _mayAsk, [PLAN_KEY]: _planFirst, ...said } = task.context ?? {};
          void _followNote;
          void _mayAsk;
          void _planFirst;
          // Plan first: where a job that asked for a plan stands. "plan": this run writes the plan (or writes it again)
          // and the job waits. "work": the plan is approved, and the agent is held to it.
          const stage = planStage(task, agent, { viaMcp: Boolean(mcpHandler) });
          if (stage === "wait") {
            // a plan is already out and unanswered: the job should be waiting, not running
            if (parkForPlan(task.taskId)) return;
          }
          const approved = stage === "work" ? approvedNote(task.taskId) : "";
          // It remembers you: what the agent noted about this person on earlier jobs, and, on a hire that is not a
          // follow-up, the work it did for them before.
          const memoryOf = memoryEnabled() ? memoryOwnerOf(task.taskId) : null;
          const remembered = memoryOf ? memoryNote(memoryOf, agent.agentId, { taskId: task.taskId, withWork: !before }) : "";
          // Stop and steer: notes the person sent before this run began go in with the job's own words. Those sent
          // while it works are read between its steps (see the loop's `notes` below).
          const steering = steerEnabled();
          const early = steering ? takeNotes(task.taskId) : [];
          if (early.length) recordDelivered(task, early);
          // Running code: an agent Axon runs on Claude may, for a hire that carries files (see below). An agent that can
          // change the files it holds is told how a change is kept: under the same name, as a new version.
          const mayCode = codeEnabled() && !mcpHandler && !agent.orchestrator && (agent.provider ?? "anthropic") === "anthropic";
          const mayRevise = followUpEnabled() && mayCode && handed.files.length > 0;
          // Word, Excel and PowerPoint: a job that is handed one, or asks for one, is done on the real file in the
          // sandbox, so what comes back is a real document, workbook or deck.
          const office = officeEnabled() && mayCode && (handed.files.some((f) => f.kind === "office") || wantsOffice(task.task));
          const fullMessage = before + task.task + formatContext(said) + remembered + answered + notesAtStart(early) + handed.text + prices + approved + (wantsReport ? REPORT_NOTE : "") + (mayRevise ? REVISE_NOTE : "") + (office ? OFFICE_NOTE : "");
          // a file handed back that changes one the job was given is its next version; said in the log as it is kept
          const madeLine = (file: { id: string; name: string }): string => {
            const rev = markRevision(task.taskId, file.id);
            return rev ? `Made ${file.name}, version ${rev.version}` : `Made ${file.name}`;
          };

          // Watch it work: a line for each step, written as it happens, for whoever hired the agent to follow.
          const live = liveLog(task.taskId);
          if (stage === "plan" && plansOf(task.taskId).length) {
            live.say("Changing the plan");
          } else if (answered) {
            // the job is going on after a question: say what came back, not that it was picked up again
            live.say(/The person answered:/.test(answered.slice(answered.lastIndexOf("You asked:"))) ? "Got your answer. Going on" : "No answer came in time. Going on with a best guess");
          } else if (approved) {
            live.say(/person approved/.test(approved) ? "Plan approved. Starting the work" : "No answer came in time. Going on with the plan as written");
          } else {
            live.say(`Picked up by ${agent.name}`);
            if (before) {
              // an agent brought into a conversation says so, and whose work it is picking up
              const after = (task.context?.[FOLLOW_KEY] as { broughtIn?: boolean; after?: string } | undefined);
              const started = after?.broughtIn && after.after ? getAgentById(after.after)?.name ?? after.after : null;
              live.say(started ? `Joining the job ${started} started` : "Continuing from the earlier job");
            }
            for (const f of handed.files) live.say(`Reading ${f.name}`);
          }

          // Promise.race abandons the loser, it doesn't stop it. For a single
          // model call that's one wasted request; a tool loop is up to seven, so
          // the timeout also trips an abort the loop checks between rounds.
          const abort = new AbortController();
          const taskTimeout = new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(() => {
              abort.abort();
              reject(new Error(`Task timed out after ${TASK_TIMEOUT_MS / 1000}s`));
            }, TASK_TIMEOUT_MS);
            timeoutTimer.unref();
          });
          // the race's loser is never awaited; keep a timeout that fires after a failure from surfacing as unhandled
          taskTimeout.catch(() => {});
          // The person can stop the job while it runs. The job is called off where they did it; this run looks for
          // that every second or so, stops paying for more rounds, and ends at once.
          const stopped = new Promise<never>((_, reject) => {
            if (!steering) return;
            stopWatch = setInterval(() => {
              if (!wasStopped(task.taskId)) return;
              stoppedByPerson = true;
              abort.abort();
              reject(new Error("Stopped by the person who hired it"));
            }, STOP_CHECK_MS);
            stopWatch.unref();
          });
          stopped.catch(() => {});

          // Plan first: this run writes the plan and nothing else. One call, no tools; the job then waits for the
          // person to approve it, change it or cancel.
          if (stage === "plan") {
            const had = plansOf(task.taskId);
            if (!had.length) live.say("Writing a plan for you to approve");
            const planMessage = before + task.task + formatContext(said) + remembered + answered + notesAtStart(early) + handed.text + planNote(had);
            const planned = await captureModelStep(() =>
              Promise.race([runWithProvider(agent, planMessage, PLAN_MAX_TOKENS, undefined, handed.attachments), taskTimeout, stopped]),
            );
            if (!planned.result.trim()) throw new Error("The agent wrote no plan");
            safeAppendTraceEvent({
              traceId: task.traceId ?? task.taskId,
              taskId: task.taskId,
              kind: "step.model",
              fromAgent: task.fromAgent,
              toAgent: task.toAgent,
              workflowId: task.workflowId ?? null,
              stepIndex: task.stepIndex ?? null,
              inputHash: hashContent(planMessage),
              outputHash: hashContent(planned.result),
              model: planned.model ?? null,
              inputTokens: planned.inputTokens || null,
              outputTokens: planned.outputTokens || null,
              costUsd: estimateCostUsd(planned.model, planned.inputTokens, planned.outputTokens),
              latencyMs: planned.latencyMs,
            });
            keepPlan(task.taskId, planned.result);
            if (parkForPlan(task.taskId)) live.say("Waiting for you to approve the plan");
            recordCircuitSuccess(agent.agentId);
            return;
          }

          // Granted tools: this agent may search, fetch, and call MCP tools before
          // it answers. Resolved per task so a newly synced MCP server is picked up
          // without a restart; unresolvable grants are dropped, never fatal.
          let tools = agent.tools?.length
            ? resolveAgentTools(agent.tools, { agentId: agent.agentId, taskId: task.taskId })
            : null;
          // Running code. An agent Axon runs on Claude gets a sandbox for a hire that carries files, so what it says
          // about them is calculated rather than guessed; an agent whose owner granted "code_execution" has one
          // anyway. The hire's files are put into it, and whatever it writes there for the person is kept with the job.
          if (mayCode && (handed.files.length || office) && !hasCode(tools)) tools = withCode(tools);
          // Using the internet (the browser itself is handed over further down). A job that goes to a website for a
          // file to work on gets the sandbox too, so what it fetches can be counted and charted, not just read.
          const aboutSite = (job: string) => mayBrowse(agent, job, { viaMcp: Boolean(mcpHandler) });
          const browsing = aboutSite(task.task) || Boolean(before && earlierTurns(task).some((t) => aboutSite(t.task)));
          if (mayCode && browsing && asksForFile(task.task) && !hasCode(tools)) tools = withCode(tools);
          // files the job's browser takes from the web while it runs, on their way into the sandbox
          const fetched: SandboxFile[] = [];
          const sandbox = mayCode && hasCode(tools)
            ? {
                files: handed.files.flatMap((f) => { const bytes = readBytes(f); return bytes ? [{ name: f.name, mime: f.mime, bytes }] : []; }),
                more: () => fetched.splice(0),
                onFile: (f: SandboxFile) => {
                  const kept = keepOutput({ taskId: task.taskId, bytes: f.bytes, name: f.name, wallet: hirerWallet });
                  if (kept && !kept.ok) logger.info("worker.output_file_refused", "A file the agent wrote was not kept", { taskId: task.taskId, name: f.name, refused: kept.refused });
                  if (kept?.ok) live.say(madeLine(kept.file));
                },
              }
            : undefined;
          // Making pictures. A hire that is about a picture gives the agent one more tool: it describes the picture, a
          // picture model draws it, and the file is kept with the job like any other the agent hands back.
          // A follow-up to a job that was about a picture is about that picture too, whatever its own few words say.
          const aboutPicture = (job: string) => mayDraw(agent, job, { viaMcp: Boolean(mcpHandler) });
          if (aboutPicture(task.task) || (before && earlierTurns(task).some((t) => aboutPicture(t.task)))) {
            tools = withPictures(tools, pictureTool({ taskId: task.taskId, wallet: hirerWallet, paid: task.payment != null, onMade: (f) => live.say(madeLine(f)) }));
          }
          // Using the internet. A hire that is about a website gives the agent a browser of its own for the job: it
          // opens pages, clicks, types, scrolls and reads. A follow-up to such a job is about that website too.
          let browserSteps = 0;
          if (browsing) {
            // each thing it does there is a line in the live log, with a picture of the page as it then was
            const b = browserTool({ taskId: task.taskId, paid: task.payment != null, say: (line) => live.show(line, hirerWallet), onPage: (page) => { recordPage(task.taskId, page); },
              // a form is sent only when the person asked for something to be sent, in this turn or one before it
              maySend: asksToSend(task.task) || Boolean(before && earlierTurns(task).some((t) => asksToSend(t.task))),
              onSent: (sent) => { recordSent(task.taskId, sent); },
              // a picture or a copy of a page it saves is kept with the job like any file it hands back
              wallet: hirerWallet,
              onMade: (f, how) => live.say(madeLine(f).replace(/^Made/, how === "downloaded" ? "Took" : "Saved")),
              // a file it takes from the web goes into its sandbox too, where it has one
              hasSandbox: Boolean(sandbox),
              onTaken: (f) => { if (sandbox) fetched.push(f); },
            });
            tools = withBrowser(tools, b.tool);
            closeBrowser = b.close;
            browserSteps = task.payment != null ? BROWSER_STEPS.paid : BROWSER_STEPS.free;
          }
          // It remembers you: the agent may note something about the person for the next time they hire it.
          if (memoryOf && canNote(agent, { viaMcp: Boolean(mcpHandler) })) {
            tools = withRemember(tools, rememberTool({ owner: memoryOf, agentId: agent.agentId, taskId: task.taskId, onNoted: (line) => live.say(`Noted for next time: ${line.text}`) }));
          }
          // Asking: on a hire that allowed it, the agent may stop to ask the person a question. Using the tool ends
          // this run at the next round, and the job waits for the answer instead of finishing.
          if (mayAsk(task, agent, { viaMcp: Boolean(mcpHandler) })) {
            tools = withAsk(tools, askTool({
              taskId: task.taskId,
              onAsked: (q) => {
                asked = q;
                abort.abort();
              },
            }));
          }
          // Every call the agent makes goes into the flight recorder as it happens,
          // so the receipt shows what it did, not just what it said.
          let lastRefusal: string | null = "";
          const onToolCall = (ev: ToolCallEvent) => {
            // a browser that did not do something says what and why, in the person's words; anything else just says it failed
            if (!ev.ok) {
              const line = ev.tool === "browser" ? refusalLine(ev.error ?? "") : ev.kind === "code" ? "That run did not work. Trying another way." : "That step did not work. Trying another way.";
              // an agent that tries again past its share is told the same thing again; the person is told once
              if (line !== lastRefusal) live.say(line);
              lastRefusal = line;
            }
            safeAppendTraceEvent({
              traceId: task.traceId ?? task.taskId,
              taskId: task.taskId,
              kind: "tool.call",
              fromAgent: task.toAgent,
              toAgent: null,
              workflowId: task.workflowId ?? null,
              stepIndex: task.stepIndex ?? null,
              inputHash: hashContent(ev.input),
              outputHash: ev.output ? hashContent(ev.output) : null,
              latencyMs: ev.latencyMs,
              meta: {
                tool: ev.tool,
                toolKind: ev.kind,
                ok: ev.ok,
                ...(ev.error ? { error: ev.error.slice(0, 200) } : {}),
              },
            });
          };

          // How deep this agent may go, from what its owner holds. Free-lane work stays at base
          // depth whatever they hold: every extra step is a model call the project would be paying
          // for, and the free lane is already the one benefit that costs money.
          const depth = await limitsForAgent(agent.agentId, task.payment !== null);

          // an agent with no tools has one step left, and it is the answer
          if (!mcpHandler && !hasTools(tools)) live.say("Writing the answer");
          const step = await captureModelStep(() =>
            Promise.race([
              mcpHandler
                ? mcpHandler(fullMessage)
                : hasTools(tools)
                  ? runWithProviderTools(agent, fullMessage, Math.max(getAgentMaxTokens(agent.agentId), office ? OFFICE_MAX_TOKENS : sandbox ? CODE_MAX_TOKENS : 0, browserSteps ? BROWSER_MAX_TOKENS : 0), tools, {
                      onToolCall,
                      ...(live.on ? { onLive: live.onLive } : {}),
                      signal: abort.signal,
                      // a job with a browser needs a round for each thing it does there, and a few to read, note and answer
                      maxSteps: browserSteps ? Math.max(depth.toolSteps, browserSteps + 5) : depth.toolSteps,
                      maxToolResultChars: depth.toolResultChars,
                      attachments: handed.attachments,
                      sandbox,
                      // a note the person sends while it works reaches the agent between two of its steps
                      ...(steering
                        ? {
                            notes: () => {
                              const got = takeNotes(task.taskId);
                              if (!got.length) return null;
                              recordDelivered(task, got);
                              live.say("Got your note. Taking it into account");
                              return notesMidway(got);
                            },
                          }
                        : {}),
                    })
                  : runWithProvider(agent, fullMessage, getAgentMaxTokens(agent.agentId), undefined, handed.attachments),
              taskTimeout,
              stopped,
            ]),
          );
          // stopped just as it finished: the job is already called off, and nothing more is kept or delivered
          if (steering && wasStopped(task.taskId)) return;
          // it asked and still came back with words: the question stands, and the job waits for its answer
          if (asked && parkForAnswer(task.taskId)) return;
          const output = step.result;

          // Flight recorder: the rich per-step event — input/output hashes, the
          // actually-used model, tokens, cost, and latency. Best-effort.
          safeAppendTraceEvent({
            traceId: task.traceId ?? task.taskId,
            taskId: task.taskId,
            kind: "step.model",
            fromAgent: task.fromAgent,
            toAgent: task.toAgent,
            workflowId: task.workflowId ?? null,
            stepIndex: task.stepIndex ?? null,
            inputHash: hashContent(fullMessage),
            outputHash: hashContent(output),
            model: step.model ?? (Boolean(mcpHandler) ? "mcp" : null),
            inputTokens: step.inputTokens || null,
            outputTokens: step.outputTokens || null,
            costUsd: estimateCostUsd(step.model, step.inputTokens, step.outputTokens),
            latencyMs: step.latencyMs,
          });

          // The answer as a file, kept before the job completes so its commitment covers the file too.
          if (wantsReport) {
            const kept = storeReport({ taskId: task.taskId, output, agentName: agent.name, wallet: hirerWallet });
            if (kept?.ok) {
              const rev = markRevision(task.taskId, kept.file.id);
              live.say(rev ? `Saved the answer as ${kept.file.name}, version ${rev.version}` : `Saved the answer as ${kept.file.name}`);
            }
            if (kept && !kept.ok) logger.info("worker.report_file_refused", "The answer was not kept as a file", { taskId: task.taskId, refused: kept.refused });
          }

          if (completeTask(task.taskId, output)) {
            settleCompletedTask(task.taskId);
          }
          recordCircuitSuccess(agent.agentId);
          logger.info("worker.task_processed", "Worker processed task", {
            agentId: agent.agentId,
            taskId: task.taskId,
          });
        } catch (err) {
          // The person stopped the job. It is already called off and refunded; this is not a failure of the agent.
          if (stoppedByPerson || (steerEnabled() && wasStopped(task.taskId))) {
            logger.info("worker.task_stopped", "A job was stopped by its hirer while it ran", { agentId: agent.agentId, taskId: task.taskId });
            return;
          }
          // The run stopped because the agent asked a question: that is not a failure. The job waits.
          if (asked && parkForAnswer(task.taskId)) {
            logger.info("worker.task_waiting", "A job stopped to ask its hirer a question", { agentId: agent.agentId, taskId: task.taskId });
            return;
          }
          const msg = err instanceof Error ? err.message : "Agent execution failed";
          if (failTask(task.taskId, msg)) {
            refundPayment(task.taskId);
            refundDebitForTask(task.taskId);
          }
          recordCircuitFailure(agent.agentId);
          logger.error("worker.task_failed", "Worker task execution failed", {
            err,
            agentId: agent.agentId,
            taskId: task.taskId,
          });
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (stopWatch) clearInterval(stopWatch);
          if (closeBrowser) void closeBrowser().catch(() => undefined);
        }
      }));
    }
  };

  // The poll only claims and starts work; execution runs in the background (see ./inflight), so one slow
  // inference never holds up another agent, the heartbeat, or webhook delivery. Each agent still runs at
  // most MAX_CONCURRENT_PER_AGENT tasks at once, counted from the tasks table.
  await Promise.allSettled(agents.map((a) => processAgent(a)));
}

async function poll() {
  if (shutdownRequested) return;
  if (pollRunning) return;
  pollRunning = true;
  try {
    // Record heartbeat so the health endpoint can confirm the worker is alive.
    getDb()
      .prepare("INSERT OR REPLACE INTO worker_state (key, value, updated_at) VALUES ('last_seen', 'ok', ?)")
      .run(new Date().toISOString());

    // Questions nobody answered in time: those jobs go on with a best guess. Plans nobody answered: with the plan.
    try {
      if (askEnabled()) resumeOverdue();
      if (planEnabled()) approveOverdue();
    } catch (err) {
      logger.error("worker.ask_resume_failed", "Could not resume jobs waiting on an answer", { err });
    }

    try {
      await deliverPendingWebhooks();
    } catch (err) {
      logger.error("webhook.delivery_cycle_failed", "Webhook delivery cycle failed", { err });
    }
    await processTasks();
  } finally {
    pollRunning = false;
  }
}

function runPoll(trigger: "startup" | "interval"): Promise<void> {
  if (shutdownRequested) return Promise.resolve();
  const current = poll().catch((err) => logger.error("worker.poll_failed", "Worker poll failed", { err, trigger }));
  activePoll = current;
  current.finally(() => {
    if (activePoll === current) activePoll = null;
  });
  return current;
}

// Verify registered agent endpoints for x402 compliance and uptime. This is the only sweep that
// probes agents; /api/cron/health used to run a second one on the same five minutes.
async function checkAgentHealth() {
  if (shutdownRequested) return;
  const agents = getAllAgents().filter((a) => a.endpoint);
  const start = Date.now();
  const tally: Record<string, number> = {};
  let changed = 0;
  for (const agent of agents) {
    if (shutdownRequested) return;
    const result = await verifyAgentEndpoint(agent.agentId, agent.endpoint!, { functionalProbe: "periodic" });
    recordTaskLatency(agent.agentId, result.latencyMs ?? 5000, result.status !== "unreachable");
    tally[result.status] = (tally[result.status] ?? 0) + 1;
    if (result.changed) changed++;
  }
  logger.info("agent.health_sweep", "Agent health sweep finished", {
    checked: agents.length,
    ...tally,
    changed,
    durationMs: Date.now() - start,
  });
}

function runHealthCheck(trigger: "startup" | "interval"): Promise<void> {
  if (shutdownRequested) return Promise.resolve();
  const current = checkAgentHealth()
    .catch((err) => logger.error("worker.health_check_failed", "Agent health check failed", { err, trigger }));
  activeHealthCheck = current;
  current.finally(() => {
    if (activeHealthCheck === current) activeHealthCheck = null;
  });
  return current;
}

function clearTimers(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (thresholdTimer) {
    clearInterval(thresholdTimer);
    thresholdTimer = null;
  }
  if (allowanceTimer) {
    clearInterval(allowanceTimer);
    allowanceTimer = null;
  }
  if (myloTimer) {
    clearInterval(myloTimer);
    myloTimer = null;
  }
  if (mindsTimer) {
    clearInterval(mindsTimer);
    mindsTimer = null;
  }
  if (pageTimer) {
    clearInterval(pageTimer);
    pageTimer = null;
  }
  if (triggerTimer) {
    clearInterval(triggerTimer);
    triggerTimer = null;
  }
  if (commitTimer) {
    clearInterval(commitTimer);
    commitTimer = null;
  }
  if (retainerTimer) {
    clearInterval(retainerTimer);
    retainerTimer = null;
  }
}

async function waitForActiveWork(): Promise<void> {
  await Promise.allSettled([
    activePoll ?? Promise.resolve(),
    activeHealthCheck ?? Promise.resolve(),
  ]);
  // tasks started by earlier polls are still executing on their own
  await drain(0);
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownRequested) return;
  shutdownRequested = true;
  clearTimers();

  logger.info("worker.shutdown_started", "Worker shutdown requested", {
    signal,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  const waitForShutdown = waitForActiveWork();
  if (SHUTDOWN_TIMEOUT_MS > 0) {
    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS).unref();
    });
    const result = await Promise.race([waitForShutdown.then(() => "done" as const), timeout]);
    if (result === "timeout") {
      logger.error("worker.shutdown_timeout", "Worker shutdown timed out before active work finished", {
        signal,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
        pollRunning,
        tasksInFlight: inFlightCount(),
      });
      await syncToTurso(); // best-effort flush before forced exit
      process.exitCode = 1;
      process.exit();
    }
  } else {
    await waitForShutdown;
  }

  logger.info("worker.shutdown_complete", "Worker shutdown complete", { signal });
  await syncToTurso(); // flush any writes since the last fire-and-forget sync
  process.exit(0);
}

async function main() {
  // Crash guard. The worker does a lot of fire-and-forget async work (void
  // syncToTurso, interval polls, threshold checks); on Node 15+ a single stray
  // unhandled rejection would kill the worker process. Log and keep it alive —
  // mirrors the guard in instrumentation.ts (which only covers the web process).
  process.on("unhandledRejection", (reason) => {
    logger.error("worker.unhandled_rejection", "unhandled rejection (kept alive)", {
      err: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    });
  });
  process.on("uncaughtException", (err) => {
    logger.error("worker.uncaught_exception", "uncaught exception (kept alive)", {
      err: err.stack ?? err.message,
    });
  });

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn("worker.config_missing", "ANTHROPIC_API_KEY is not set; Anthropic-backed agents will fail until configured");
  }

  logger.info("worker.started", "Axon worker started", {
    pollIntervalSeconds: POLL_INTERVAL_MS / 1000,
  });

  await startWorkerLoops();
}

// Starts the poll/health/threshold loops. Idempotent. Used by both the standalone
// worker process (main) and the web server's instrumentation hook — so a
// single-container deployment runs the worker in-process, sharing the same DB,
// without needing a separate worker service.
//
// The guard lives on globalThis, not in a module variable. The server can evaluate this module more
// than once (each bundle that imports it gets its own copy), and a module-level flag only stops the
// copy it lives in: production was running every loop twice, visible as each agent being probed on
// two independent five-minute clocks.
const workerGlobal = globalThis as typeof globalThis & { __axonWorkerLoopsPid?: number };
export async function startWorkerLoops(): Promise<void> {
  if (workerGlobal.__axonWorkerLoopsPid !== undefined) {
    logger.info("worker.loops_duplicate_skipped", "Worker loops already running in this process", { pid: process.pid });
    return;
  }
  workerGlobal.__axonWorkerLoopsPid = process.pid;
  logger.info("worker.loops_started", "Worker loops started", { pid: process.pid });

  // A fresh boot means every worker-claimed 'running' task is an orphan of the
  // previous process (deploys kill inference mid-flight). Requeue them NOW —
  // waiting for the 10-minute stuck timeout blocks their agents completely at
  // concurrency 1, which reads as "pipeline frozen on step N" after a deploy.
  const reclaimed = getDb()
    .prepare("UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL WHERE status='running' AND started_by='worker'")
    .run().changes;
  if (reclaimed > 0) {
    logger.info("worker.boot_reclaim", "Requeued running tasks orphaned by the previous process", { reclaimed });
  }

  // Orchestrator tasks run their hiring loop in memory, not as a re-runnable
  // worker step, so a process that died mid-orchestration can't resume one — and
  // re-running would double-hire (spend the balance twice). They're also exempt
  // from the stuck reaper (which only touches 'worker'), so nothing else recovers
  // them. Fail + refund the buyer here so the escrow can't sit locked forever.
  const orphanedOrchestrations = getDb()
    .prepare("SELECT task_id FROM tasks WHERE status='running' AND started_by='orchestrator'")
    .all() as { task_id: string }[];
  let reclaimedSubHires = 0;
  for (const { task_id } of orphanedOrchestrations) {
    // Reclaim the sub-hires this orchestration created — its polling loop is gone,
    // so nothing else will. A child still queued (especially one routed to an
    // endpoint specialist that never runs here) is never reaped, so its balance
    // escrow would stay locked forever, permanently shrinking the orchestrator's
    // available balance. failTask no-ops on already-terminal children (no double refund).
    for (const sub of getSubcontractsForParent(task_id)) {
      if (failTask(sub.childTaskId, "parent orchestration interrupted by a restart")) {
        refundPayment(sub.childTaskId);
        refundDebitForTask(sub.childTaskId);
        reclaimedSubHires++;
      }
    }
    if (failTask(task_id, "Orchestration interrupted by a restart")) {
      refundPayment(task_id);
      refundDebitForTask(task_id);
    }
  }
  if (orphanedOrchestrations.length > 0) {
    logger.info("worker.boot_reclaim_orchestrations", "Failed + refunded orchestrations orphaned by the previous process", {
      count: orphanedOrchestrations.length,
      reclaimedSubHires,
    });
  }

  await runPoll("startup");
  pollTimer = setInterval(() => {
    void runPoll("interval");
  }, POLL_INTERVAL_MS);

  void runHealthCheck("startup");
  healthTimer = setInterval(() => {
    void runHealthCheck("interval");
  }, HEALTH_INTERVAL_MS);

  checkAllThresholds();
  thresholdTimer = setInterval(() => {
    checkAllThresholds();
  }, THRESHOLD_INTERVAL_MS);

  // Settle or release allowance reservations the ledger has decided. Does nothing until allowances
  // are enabled. Skips a tick rather than overlap one still waiting on the chain.
  allowanceTimer = setInterval(() => {
    if (allowanceRunning || shutdownRequested) return;
    allowanceRunning = true;
    reconcileAllowances()
      .catch((err) => logger.error("allowance.reconcile_failed", "Allowance reconcile failed", { err }))
      // Every ten minutes: how much gas the operator has left, before it runs out rather than after.
      .then(() => checkOperatorGas())
      .catch((err) => logger.warn("allowance.gas_check_failed", "Could not read the operator's gas", { err }))
      .finally(() => { allowanceRunning = false; });
  }, ALLOWANCE_INTERVAL_MS);

  // Retainers: close runs whose work ended, then hire whatever is due. Every run pays from an
  // allowance, so nothing runs until allowances are on. Skips a tick rather than overlap one.
  retainerTimer = setInterval(() => {
    if (retainerRunning || shutdownRequested || !allowancesEnabled()) return;
    retainerRunning = true;
    Promise.resolve()
      .then(() => {
        sweepStrandedRuns();
        settleRetainerRuns();
        return runDueRetainers();
      })
      .then(async (r) => {
        if (r.due > 0) logger.info("retainer.tick", "Retainer runs", { ...r });
        await deliverRetainerWebhooks();
      })
      .catch((err) => logger.error("retainer.tick_failed", "Retainer tick failed", { err }))
      .finally(() => { retainerRunning = false; });
  }, RETAINER_INTERVAL_MS);

  // File commitments that did not reach the chain when their job finished are tried again, a few a minute.
  commitTimer = setInterval(() => {
    if (commitRunning || shutdownRequested || !filesEnabled()) return;
    commitRunning = true;
    retryFileCommitments()
      .then((r) => { if (r.landed > 0) logger.info("output.commit_tick", "File commitments landed", { ...r }); })
      .catch((err) => logger.error("output.commit_tick_failed", "Commitment retry failed", { err }))
      .finally(() => { commitRunning = false; });
  }, RETAINER_INTERVAL_MS);

  // Jobs that start themselves: once a minute, read what the watched contracts did and hire for it. Does nothing
  // while triggers are off or none watches the chain. Skips a tick rather than overlap one.
  triggerTimer = setInterval(() => {
    if (triggerRunning || shutdownRequested || !triggersEnabled()) return;
    triggerRunning = true;
    runChainTriggers()
      .then((r) => { if (r.started > 0) logger.info("trigger.tick", "Chain triggers fired", { ...r }); })
      .catch((err) => logger.error("trigger.tick_failed", "Chain trigger tick failed", { err }))
      .finally(() => { triggerRunning = false; });
  }, RETAINER_INTERVAL_MS);

  // And the web pages that triggers watch: once a minute, the few that are due a look are read in a browser, and a
  // page that changed hires its agent. Does nothing while triggers or browsers are off or no page is watched.
  pageTimer = setInterval(() => {
    if (pageRunning || shutdownRequested || !triggersEnabled()) return;
    pageRunning = true;
    runPageTriggers()
      .then((r) => { if (r.changed > 0) logger.info("trigger.page_tick", "Watched pages changed", { ...r }); })
      .catch((err) => logger.error("trigger.page_tick_failed", "Page trigger tick failed", { err }))
      .finally(() => { pageRunning = false; });
  }, RETAINER_INTERVAL_MS);

  // Mylo: what happened, for its public feed and people's inboxes. Reads the database only; never throws out of the loop.
  const myloPass = () => {
    try { runMyloPass(); } catch (err) { logger.warn("mylo.pass_failed", "Mylo's pass failed", { err }); }
    // crews keep going with nobody watching: each step starts when the one before has finished
    void advanceRunningCrews().catch((err) => logger.warn("mylo.crews_failed", "Moving Mylo's crews along failed", { err }));
  };
  myloPass();
  myloTimer = setInterval(myloPass, MYLO_PASS_INTERVAL_MS);

  // Agent Minds: read the launcher's events. Does nothing until the switch is on and a launcher is set; skips a tick
  // rather than overlap one.
  mindsTimer = setInterval(() => {
    if (mindsRunning || shutdownRequested) return;
    mindsRunning = true;
    indexMinds()
      .then((r) => { if (r?.added) logger.info("minds.index", "Tokens with a mind read from the chain", { ...r }); })
      // then the numbers the board shows: price, holders, fees, burns, treasuries
      .then(() => refreshStats())
      // standing orders: the ones whose condition is met fire, with no model called; the rest wait or lapse
      .then(() => fireDue())
      .then((r) => { if (r && (r.fired || r.lapsed)) logger.info("minds.orders", "Standing orders looked at", { ...r }); })
      // and the minds with something to think about think (only when thinking is switched on)
      .then(() => thinkDue())
      .then((r) => { if (r?.thought) logger.info("minds.thought", "Minds thought", { ...r }); })
      // in the first hours of a day, the minds that owe a report on the day before write it
      .then(() => reportDue())
      .then((r) => { if (r?.written) logger.info("minds.reports", "Minds wrote their daily reports", { ...r }); })
      // then the signer: close what was sent, send what the rule check passed, let minds pay for their thinking.
      // All of it does nothing unless acting is switched on and the signer's key is set.
      .then(() => settleSent())
      .then(() => actDue())
      .then((r) => { if (r && (r.done || r.failed || r.dropped)) logger.info("minds.act", "Minds acted", { ...r }); })
      // close the orders that fired, write down every move carried out, and measure the ones whose hour is up
      .then(() => { settleOrders(); trackOutcomes(); })
      .then(() => payThinkingDue())
      // every few minutes: move fees to their splitters and let ready pots burn
      .then(() => (++mindsTicks % 15 === 0 ? keepUp() : null))
      .then((r) => { if (r && (r.swept || r.burned)) logger.info("minds.keep", "Housekeeping for tokens", { ...r }); })
      .catch((err) => logger.warn("minds.index_failed", "Reading the launcher's events failed", { err }))
      .finally(() => { mindsRunning = false; });
  }, MINDS_INDEX_INTERVAL_MS);
}

// Run the full standalone worker (own signal + crash handling) only when launched
// directly via `npm run worker`. When the module is imported (e.g. by the web
// server's instrumentation hook) nothing auto-starts — the caller invokes
// startWorkerLoops() so there's no duplicate process or signal-handler conflict.
if (process.env.AXON_WORKER_STANDALONE === "1") {
  main().catch((err) => logger.error("worker.crashed", "Axon worker crashed", { err }));
}

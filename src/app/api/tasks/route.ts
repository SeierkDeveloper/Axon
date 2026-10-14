import { NextRequest, NextResponse } from "next/server";
import { createTask, getTaskById, getTaskByIdempotency, markTaskPaymentConfirmed, type Task } from "@/lib/tasks";
import { syncToTurso } from "@/lib/db-turso";
import { getAgentById } from "@/lib/agents";
import { selectAgent, type RouteResult } from "@/lib/routing";
import { createPayment, createBalancePayment, getPaymentByIncomingSignature, parsePriceToEth, refundPayment } from "@/lib/payments";
import { payFromAllowance, freshAxonQuoteFor, AllowancePaymentError } from "@/lib/allowancePayment";
import { noteAllowanceHire, KEY_HIRES_PER_MINUTE } from "@/lib/allowanceWatch";
import { isWalletAddress } from "@/lib/address";
import { checkRateLimit, getClientIp, tooManyRequests, rateLimitHeaders } from "@/lib/rateLimit";
import { canAccessIdentity, requireApiKey } from "@/lib/apiAuth";
import { authenticateApiKey } from "@/lib/identity";
import { apiError } from "@/lib/apiError";
import { checkFreeAllowance, freeLimitMessage } from "@/lib/freeAllowance";
import { getTier } from "@/lib/holderTier";
import { hashIdempotencyPayload, normalizeIdempotencyKey, validateIdempotencyKey } from "@/lib/idempotency";
import { claimTokenFor, claimTokenValid } from "@/lib/mcpServer";
import { agentReads, attachFiles, checkTaskFiles, CONTEXT_KEY, filesEnabled, listFiles, passFiles, REPORT_KEY, type FileRow } from "@/lib/agentFiles";
import { bringInEnabled, carriedFiles, checkFollowUp, followNote, followUpEnabled, FOLLOW_KEY, type FollowCheck } from "@/lib/followUp";
import { askEnabled, ASK_KEY } from "@/lib/ask";
import { planEnabled, PLAN_KEY } from "@/lib/planFirst";
import { partOn } from "@/lib/autonomy3Policy";
import { JUDGE_KEY } from "@/lib/autonomy3Judge";
import { memoryEnabled, memoryOwnerFor, memoryOwnerOf, setMemoryOwner } from "@/lib/agentMemory";
import { libraryEnabled, libraryOwnerOf, setLibraryOwner } from "@/lib/library";
import { getMcpServerByAgentId } from "@/lib/mcp";
import { getDb } from "@/lib/db";
import { createTaskSchema, parseBody } from "@/lib/schemas";
import { withRequestContext } from "@/lib/withRequestContext";

// 60 requests per minute per IP
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function taskResponse(
  task: Task,
  status: number,
  replayHeader?: "idempotency" | "payment",
  rlHeaders?: Record<string, string>,
  claimToken?: string,
  routing?: RouteResult,
) {
  // claimToken (anonymous hires only) is the read permission for this task's
  // private output — the browser/MCP caller keeps it to poll the result.
  // routing (auto-routed tasks only) tells the caller which agent the network
  // picked and why.
  return NextResponse.json(
    {
      ...task,
      ...(claimToken ? { claimToken } : {}),
      ...(routing ? { routing: { agentId: routing.agent.agentId, reason: routing.reason, considered: routing.considered } } : {}),
    },
    {
      status,
      headers: {
        ...(replayHeader === "idempotency" ? { "X-Idempotent-Replay": "true" } : {}),
        ...(replayHeader === "payment" ? { "X-Payment-Replay": "true" } : {}),
        ...(routing ? { "X-Routed-To": routing.agent.agentId } : {}),
        ...(rlHeaders ?? {}),
      },
    },
  );
}

/** A file listed on this hire was taken by another one between the check and the write. */
class FileTaken extends Error {}

export async function POST(req: NextRequest) {
  return withRequestContext(req, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(`tasks:${ip}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);
  const raw = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object") {
    return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
  }
  const parsed = parseBody(raw, createTaskSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // Phase 11 auto-routing: no `to` → the network picks the best worker for the
  // requested capability (highest Proof Score, cheapest, least loaded, honouring
  // the paying agent's budget allow-list). Resolve BEFORE pricing / idempotency /
  // specHash below — all of which key on the concrete agent id.
  let toAgentId = body.to;
  let routing: RouteResult | undefined;
  // A follow-up goes to the agent that did the job it follows, so the job names the agent when the caller does not.
  // Whether this caller may follow it is decided further down, once we know who they are.
  if (body.followUpOf) {
    if (!followUpEnabled()) return apiError("VALIDATION_ERROR", "Follow-ups are not switched on here.", 400, { refused: "off" });
    // Bringing in another agent without naming one: with a capability, the network picks the specialist below.
    const routeIt = bringInEnabled() && (Boolean(body.capability) || (body.capabilities?.length ?? 0) > 0);
    if (!toAgentId && !routeIt) {
      const followed = getTaskById(body.followUpOf);
      if (!followed) return apiError("NOT_FOUND", "That job was not found, or it is not yours to follow up.", 404, { refused: "not_found" });
      toAgentId = followed.toAgent;
    }
  }
  if (!toAgentId) {
    routing = selectAgent({
      capability: body.capability,
      capabilities: body.capabilities,
      maxPrice: body.maxPrice,
      fromAgent: body.from !== "anonymous" ? body.from : undefined,
    }) ?? undefined;
    if (!routing) {
      const want = body.capability ?? body.capabilities?.join(", ") ?? "the request";
      return apiError("NO_AGENT_AVAILABLE", `No available agent matches ${want}`, 404);
    }
    toAgentId = routing.agent.agentId;
  }

  const agent = getAgentById(toAgentId);
  if (!agent) {
    return apiError("NOT_FOUND", `Agent '${toAgentId}' not found`, 404);
  }

  // from must be a wallet address, a registered agent ID, or "anonymous" (unauthenticated free tasks)
  if (body.from !== "anonymous" && !isWalletAddress(body.from) && !getAgentById(body.from)) {
    return apiError("VALIDATION_ERROR", "from must be a valid wallet address or agent ID", 400);
  }

  // Auth gates all attributed requests — must run before payment check so probing
  // an agent's price without credentials returns 401, not 402.
  let authWallet: string | null = null;
  // Set when the caller holds an allowance key: it may hire, but only paid work paid from the
  // allowance, and only within the key's own limits.
  let allowanceKeyId: string | null = null;
  if (body.from !== "anonymous") {
    const auth = requireApiKey(req, { allowAllowanceScope: true });
    if (!auth.ok) return auth.response;
    authWallet = auth.user.walletAddress;
    if (auth.user.scope === "allowance") {
      if (parsePriceToEth(agent.price) === null || body.paymentMethod !== "allowance") {
        return apiError(
          "FORBIDDEN",
          "An allowance key can only hire paid agents with paymentMethod:\"allowance\"",
          403,
        );
      }
      allowanceKeyId = auth.user.keyId;
      // A key is one assistant working, never a crowd. Ten hires a minute is room for it to work and
      // a wall for a script trying to empty the day's limit before anyone notices.
      const keyRl = checkRateLimit(`allowance-key:${allowanceKeyId}`, KEY_HIRES_PER_MINUTE, 60_000);
      if (!keyRl.allowed) return tooManyRequests(keyRl);
    }
    if (!canAccessIdentity(auth.user, body.from)) {
      return apiError(
        "FORBIDDEN",
        "from must be your wallet address or an agent owned by your wallet",
        403
      );
    }
  }

  // A follow-up: the job it continues must be the caller's own, finished, and this agent's.
  let follow: Extract<FollowCheck, { ok: true }> | null = null;
  if (body.followUpOf) {
    const check = checkFollowUp({
      parentId: body.followUpOf,
      from: body.from,
      to: toAgentId,
      tokenOk: Boolean(body.followUpToken) && claimTokenValid(body.followUpOf, body.followUpToken!),
    });
    if (!check.ok) return apiError(check.refused === "not_found" ? "NOT_FOUND" : check.status === 409 ? "CONFLICT" : "VALIDATION_ERROR", check.reason, check.status, { refused: check.refused });
    follow = check;
  }
  if (followUpEnabled() && body.context && FOLLOW_KEY in body.context) {
    return apiError("VALIDATION_ERROR", `context.${FOLLOW_KEY} is filled in by Axon. Send "followUpOf" instead.`, 400);
  }

  if (body.from === "anonymous" && !process.env.VITEST && parsePriceToEth(agent.price) === null) {
    // Free calls per agent, three for everyone and more for a wallet holding $AXON. A 1 year
    // window, so refreshing the page doesn't reset it. Gates ONLY the actual free lane: an
    // anonymous request to a PAID
    // agent is authorized by its on-chain payment (verified below), so the demo
    // quota must never block a paying hirer (e.g. MCP clients, which are always
    // anonymous and pay per task).
    const free = await checkFreeAllowance(req, toAgentId);
    if (!free.result.allowed) {
      return apiError("FREE_LIMIT_REACHED", freeLimitMessage(free), 429);
    }
  }

  const payment = agent.price;
  const amountEth = parsePriceToEth(payment);

  // Files handed over with the hire. They are checked before anything is paid or created: each must be one this
  // caller may read, not yet on another hire, of a kind this agent reads, and inside what one hire may carry. What
  // they are (name, type, size, hash) goes into the hire's context, so the job's commitment covers them.
  let fileIds: string[] = [];
  let fresh: FileRow[] = [];
  if (body.context && CONTEXT_KEY in body.context) {
    return apiError("VALIDATION_ERROR", `context.${CONTEXT_KEY} is filled in by Axon from the files you attach. Send files in "files" instead.`, 400);
  }
  if (body.files?.length) {
    const checked = checkTaskFiles({
      files: body.files,
      wallet: authWallet,
      reads: agentReads(agent, { runsThroughMcp: Boolean(getMcpServerByAgentId(agent.agentId)) }),
      paid: amountEth !== null,
    });
    if (!checked.ok) {
      return apiError(checked.refused === "not_found" ? "NOT_FOUND" : "VALIDATION_ERROR", checked.reason, checked.refused === "not_found" ? 404 : 400, { refused: checked.refused });
    }
    fileIds = checked.rows.map((r) => r.id);
    fresh = checked.rows;
    body.context = { ...(body.context ?? {}), [CONTEXT_KEY]: checked.listed };
  }

  // A follow-up carries the files from the job before, the ones the agent made first, as far as one hire may carry.
  // They are listed with the hire's own files, so its commitment covers them, and what was left behind is named.
  let carry: FileRow[] = [];
  if (follow) {
    const { carried, left } = filesEnabled()
      ? carriedFiles(follow.parent, fresh, agentReads(agent, { runsThroughMcp: Boolean(getMcpServerByAgentId(agent.agentId)) }), amountEth !== null)
      : { carried: [], left: [] };
    carry = carried;
    body.context = {
      ...(body.context ?? {}),
      ...(carry.length ? { [CONTEXT_KEY]: listFiles([...fresh, ...carry]) } : {}),
      [FOLLOW_KEY]: followNote(follow, left),
    };
  }

  // The answer as a file as well. Asked for with `reportFile`; it is written into the job's context so the job's
  // commitment covers the request, which is why a caller may not put the key there themselves.
  if (filesEnabled() && body.context && REPORT_KEY in body.context) {
    return apiError("VALIDATION_ERROR", `context.${REPORT_KEY} is filled in by Axon. Send "reportFile": true instead.`, 400);
  }
  if (body.reportFile) {
    if (!filesEnabled()) return apiError("VALIDATION_ERROR", "Files are not switched on here, so an answer cannot be handed back as a file.", 400);
    body.context = { ...(body.context ?? {}), [REPORT_KEY]: true };
  }

  // The agent may ask: written into the job's context, so the job's commitment covers that it was allowed to. Where
  // asking is off the wish is simply not granted, so a caller can always send it.
  if (askEnabled() && body.context && ASK_KEY in body.context) {
    return apiError("VALIDATION_ERROR", `context.${ASK_KEY} is filled in by Axon. Send "allowQuestions": true instead.`, 400);
  }
  if (body.allowQuestions && askEnabled()) body.context = { ...(body.context ?? {}), [ASK_KEY]: true };
  // Plan first: the same way. Where it is off, or the agent cannot write a plan, the job simply runs.
  if (planEnabled() && body.context && PLAN_KEY in body.context) {
    return apiError("VALIDATION_ERROR", `context.${PLAN_KEY} is filled in by Axon. Send "planFirst": true instead.`, 400);
  }
  if (body.planFirst && planEnabled()) body.context = { ...(body.context ?? {}), [PLAN_KEY]: true };
  // Two agents and a judge (Autonomy 3): the same way again. The wish is written into the job's context, so the job's
  // commitment covers it; where the part is off it is simply not granted. The payment below is the same either way.
  if (partOn("judge") && body.context && JUDGE_KEY in body.context) {
    return apiError("VALIDATION_ERROR", `context.${JUDGE_KEY} is filled in by Axon. Send "bestOfTwo": true instead.`, 400);
  }
  if (body.bestOfTwo && partOn("judge")) body.context = { ...(body.context ?? {}), [JUDGE_KEY]: true };

  // Who the hirer is, for memory and the library alone: the wallet a hire was signed in with, and for a hire made
  // as "anonymous" the wallet of a key that came along with it (Mylo and an assistant hire free agents that way).
  // The key pays for nothing and proves nothing else here.
  const knownWallet = authWallet ?? (body.from === "anonymous" ? (authenticateApiKey(req, { allowAllowanceScope: true })?.walletAddress ?? null) : null);

  // It remembers you: whose memory this job reads and adds to. Only when the hire asks for it; a follow-up keeps
  // the memory of the job it follows. Written on the job once it exists, never into its context.
  let memoryOwner: string | null = null;
  if (memoryEnabled() && body.memory !== false) {
    if (body.memory === true || body.memoryKey) memoryOwner = memoryOwnerFor({ wallet: knownWallet, key: body.memoryKey });
    if (!memoryOwner && follow) memoryOwner = memoryOwnerOf(follow.parent.taskId);
  }

  // Your library: who hired this job, so it can be listed back to them: the wallet the hire was signed in with,
  // or the key a browser sends. A follow-up stays in the library of the job it follows. Whether memory is used
  // does not matter: the library is the person's record, not the agent's.
  let libraryOwner: string | null = null;
  if (libraryEnabled()) {
    libraryOwner = memoryOwnerFor({ wallet: knownWallet, key: body.memoryKey });
    if (!libraryOwner && follow) libraryOwner = libraryOwnerOf(follow.parent.taskId);
  }

  // "balance" funds a paid hire from the paying agent's earned ledger balance
  // instead of a fresh on-chain transfer — so an agent can reinvest what it earns.
  // It belongs to an identity, so it requires an authenticated registered agent
  // (the auth block above already proved `from` is owned by the caller).
  const useBalance = amountEth !== null && body.paymentMethod === "balance";
  if (useBalance && !getAgentById(body.from)) {
    return apiError("VALIDATION_ERROR", "balance payments require a registered paying agent", 400);
  }

  // "allowance" pays from the on-chain budget of the wallet the API key is bound to. Never a wallet
  // taken from the request: whoever holds the key can spend that wallet's allowance and nobody else's.
  const useAllowance = amountEth !== null && body.paymentMethod === "allowance";
  if (useAllowance && !authWallet) {
    return apiError("VALIDATION_ERROR", "allowance payments need an API key bound to the wallet that funded the allowance", 400);
  }
  if ((body.quoteId || body.payIn) && !useAllowance) {
    return apiError("VALIDATION_ERROR", "quoteId and payIn are only used with paymentMethod:\"allowance\"", 400);
  }

  // Paid tasks require a payment signature (on-chain), balance funding, or an allowance.
  if (amountEth !== null && !body.paymentSignature && !useBalance && !useAllowance) {
    return apiError(
      "PAYMENT_REQUIRED",
      "paymentSignature is required for paid tasks, complete the x402 payment first, or set paymentMethod:\"balance\" to spend your earned balance",
      402
    );
  }

  // payerWallet lets an anonymous hire name the wallet that paid — it's verified
  // on-chain as the transaction's signer, so it must be a real address if given.
  if (body.payerWallet && !isWalletAddress(body.payerWallet)) {
    return apiError("VALIDATION_ERROR", "payerWallet must be a valid EVM address", 400);
  }

  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("Idempotency-Key"));
  const idempotencyScope = idempotencyKey ? `tasks:${body.from}` : undefined;
  const idempotencyHash = idempotencyKey ? hashIdempotencyPayload({
    from: body.from,
    // Key on what the client SENT, not the resolved agent: auto-routing is
    // non-deterministic (it factors live load), so hashing the resolved agent
    // would make a legitimate retry mismatch and 409. For an explicit `to` this is
    // the same value; for an auto-routed request it's the routing intent.
    to: body.to ?? null,
    capability: body.capability ?? null,
    capabilities: body.capabilities ?? null,
    maxPrice: body.maxPrice ?? null,
    task: body.task,
    context: body.context ?? null,
    // The resolved agent's price is an OUTPUT of routing — only include it for an
    // explicit `to` (where it's deterministic), not for an auto-routed request.
    payment: body.to ? (payment ?? null) : null,
    paymentSignature: body.paymentSignature ?? null,
    paymentMethod: body.paymentMethod ?? null,
    quoteId: body.quoteId ?? null,
    payIn: body.payIn ?? null,
    signature: body.signature ?? null,
  }) : undefined;

  if (idempotencyKey) {
    const keyError = validateIdempotencyKey(idempotencyKey);
    if (keyError) return apiError("VALIDATION_ERROR", keyError, 400);

    const existing = getTaskByIdempotency(idempotencyScope!, idempotencyKey);
    if (existing) {
      if (existing.hash !== idempotencyHash) {
        return apiError("CONFLICT", "Idempotency-Key was already used for a different task request", 409);
      }
      return taskResponse(existing.task, 200, "idempotency", rateLimitHeaders(rl, RATE_LIMIT));
    }
  }

  if (amountEth !== null && body.paymentSignature) {
    const existingPayment = getPaymentByIncomingSignature(body.paymentSignature);
    if (existingPayment?.taskId) {
      const existingTask = getTaskById(existingPayment.taskId);
      if (
        existingTask &&
        existingPayment.fromAgent === body.from &&
        existingPayment.toAgent === toAgentId &&
        Math.abs(existingPayment.amountEth - amountEth) < 0.000001
      ) {
        return taskResponse(existingTask, 200, "payment", rateLimitHeaders(rl, RATE_LIMIT));
      }
      return apiError("PAYMENT_FAILED", "Payment signature already used", 402);
    }
  }

  let task: Task;
  try {
    // Queue position, from what the hirer holds. Resolved here, while they are in front of us with
    // the key their wallet is bound to, and written onto the task: the queue is ordered in SQL and
    // cannot make a chain call per row. Anonymous hires resolve to 0, which is the order everything
    // has today.
    const { tier: hirerTier } = await getTier(authWallet);

    const create = () => createTask({
      fromAgent: body.from,
      toAgent: toAgentId,
      task: body.task,
      context: body.context,
      payment,
      signature: body.signature,
      queueQueuedWebhook: amountEth === null,
      initialStatus: amountEth !== null ? "payment_pending" : "queued",
      idempotencyScope,
      idempotencyKey: idempotencyKey ?? undefined,
      idempotencyHash,
      priority: hirerTier.rank,
      ...(follow ? { parentTaskId: follow.parent.taskId, threadId: follow.thread } : {}),
    });
    if (fileIds.length || carry.length) {
      // The hire and its files are written as one step, so a worker can never pick the hire up without them, and
      // two hires racing for the same file cannot both be created with it.
      task = getDb().transaction(() => {
        const created = create();
        if (attachFiles(created.taskId, fileIds) !== fileIds.length) throw new FileTaken();
        // what a follow-up carries: new rows on the same stored content, nothing is uploaded or copied
        passFiles(carry, created.taskId, { wallet: authWallet });
        return created;
      })();
    } else {
      task = create();
    }
  } catch (err) {
    if (err instanceof FileTaken) {
      return apiError("CONFLICT", "One of these files was attached to another hire a moment ago. Upload it again to use it here.", 409, { refused: "taken" });
    }
    if (idempotencyKey) {
      const existing = getTaskByIdempotency(idempotencyScope!, idempotencyKey);
      if (existing) {
        if (existing.hash !== idempotencyHash) {
          return apiError("CONFLICT", "Idempotency-Key was already used for a different task request", 409);
        }
        return taskResponse(existing.task, 200, "idempotency", rateLimitHeaders(rl, RATE_LIMIT));
      }
    }
    throw err;
  }

  setMemoryOwner(task.taskId, memoryOwner);
  setLibraryOwner(task.taskId, libraryOwner);

  if (amountEth !== null && (body.paymentSignature || useBalance || useAllowance)) {
    try {
      if (useAllowance) {
        const quoteId = body.quoteId ?? (body.payIn === "AXON" ? await freshAxonQuoteFor(toAgentId) : undefined);
        await payFromAllowance({
          taskId: task.taskId,
          fromAgent: body.from,
          toAgent: toAgentId,
          owner: authWallet!,
          priceString: payment!,
          quoteId,
          apiKeyId: allowanceKeyId ?? undefined,
        });
        if (allowanceKeyId) noteAllowanceHire(allowanceKeyId);
      } else if (useBalance) {
        createBalancePayment({
          taskId: task.taskId,
          fromAgent: body.from,
          toAgent: toAgentId,
          amountEth,
          priceString: payment,
        });
      } else {
        await createPayment({
          taskId: task.taskId,
          fromAgent: body.from,
          toAgent: toAgentId,
          amountEth,
          paymentSignature: body.paymentSignature!,
          priceString: payment,
          payerWallet: body.payerWallet,
        });
      }
    } catch (err) {
      // Payment failed — roll back the task
      const { getDb } = await import("@/lib/db");
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
      void syncToTurso();
      // An allowance refusal is written to be shown: "over your daily limit", "agent not allowed".
      if (err instanceof AllowancePaymentError) {
        return apiError(err.status === 503 ? "PAYMENT_UNAVAILABLE" : "PAYMENT_FAILED", err.message, err.status);
      }
      const msg = err instanceof Error ? err.message : "Payment verification failed";
      // Don't expose internal config details (missing env vars, etc.) to callers
      const safeMsg = /is not set|API_KEY|PRIVATE_KEY|RPC_URL/i.test(msg)
        ? "Payment processing unavailable"
        : msg;
      return apiError(
        safeMsg === "Payment processing unavailable" ? "PAYMENT_UNAVAILABLE" : "PAYMENT_FAILED",
        safeMsg,
        safeMsg === "Payment processing unavailable" ? 503 : 402
      );
    }
    const confirmedTask = markTaskPaymentConfirmed(task.taskId);
    if (!confirmedTask) {
      refundPayment(task.taskId);
      const { getDb } = await import("@/lib/db");
      getDb().prepare("DELETE FROM tasks WHERE task_id = ?").run(task.taskId);
      void syncToTurso();
      return apiError("INTERNAL_ERROR", "Task payment could not be confirmed", 500);
    }
    task = confirmedTask;
  }

  // Anonymous hires (no API key) get a claimToken back — the only way to read
  // the private output — so a browser/MCP caller can poll the result.
  const claimToken = body.from === "anonymous" ? claimTokenFor(task.taskId) : undefined;
  return taskResponse(task, 201, undefined, rateLimitHeaders(rl, RATE_LIMIT), claimToken, routing);
}

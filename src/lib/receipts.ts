import { getDb } from "./db";
import { getTasksByAgent, type Task } from "./tasks";
import type { Payment } from "./payments";
import type { WebhookDelivery } from "./webhooks";
import { recommendPaymentPath, type PaymentPathRecommendation } from "./paymentPath";
import { getOutputCommitment, type OutputCommitment } from "./outputCommitment";
import { verifyTaskSpec, type SpecVerification } from "./specCommitment";
import { getTaskProgress, type TaskProgressEntry } from "./progress";
import { getPaymentNotes, type PaymentNote } from "./paymentNotes";
import { getSplitsForTask, type TaskSplit } from "./escrowSplits";
import { getSlaForTask, type TaskSla } from "./sla";
import { receiptFiles, type ReceiptFile } from "./agentFiles";
import { turnOf } from "./followUp";

export interface Receipt {
  taskId: string;
  task: Task | null;
  payment: Payment | null;
  webhookDeliveries: Pick<WebhookDelivery, "deliveryId" | "webhookId" | "eventType" | "status" | "attempts" | "responseStatus" | "lastAttemptAt">[];
  recommendedPath: PaymentPathRecommendation;
  specVerification: SpecVerification | null; // job-spec hash pinned at creation + tamper check
  outputCommitment: OutputCommitment | null;
  progress: TaskProgressEntry[];
  notes: PaymentNote[]; // dispute/refund notes attached to this payment
  splits: TaskSplit[]; // escrow split recipients, if the payment is divided across agents
  sla: TaskSla | null; // service-level agreement and its status, if one was set
  /** files the agent handed back, when it handed any back: named, since this receipt is read with a key */
  outputFiles?: ReceiptFile[];
}

// The public face of a receipt — the explorer privacy rule applies: WHO
// transacted with WHOM, status, timestamps, the tamper-evidence hashes and the
// settlement. NEVER the task content or output; those stay behind the API key.
export interface PublicReceipt {
  taskId: string;
  fromAgent: string;
  fromName: string | null;
  toAgent: string;
  toName: string | null;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** The agreed payment terms (e.g. "0.25 ETH") — null for free-route tasks. */
  payment: string | null;
  specHash: string | null;
  outputHash: string | null;
  /** Spec recomputed from the stored fields still matches the pinned hash. */
  specVerified: boolean | null;
  settlement: {
    amount: number;
    currency: string;
    status: string;
    signature: string | null;
    settledAt: string | null;
  } | null;
  /**
   * Files the job handed back. What each IS and its hash, never its name: a name can say what the work was about,
   * and the work stays private. `stored` is false once the bytes have been cleared; the hash is kept.
   */
  outputFiles?: {
    type: string; size: number; sha256: string; stored: boolean; madeBy?: { agentId: string; name: string; taskId: string };
    /** A revision: which version this is, the hash of the version it replaces, and the first version's hash and job. */
    version?: number; revises?: string; first?: { sha256: string; taskId: string | null };
  }[];
  /** SHA-256 over the file hashes, sorted, one a line: what the commitment on chain carries for the files. */
  outputFilesHash?: string;
  /** The transaction the output hash and the files hash were posted in, once it is on chain. */
  commitmentTx?: string;
  /** A follow-up: the job this one continues, and which turn of that conversation it is. Only on a follow-up. */
  followUpOf?: string;
  turn?: number;
}

/** The files a job handed back, as its receipts list them. Empty (never an error) when there are none. */
function returnedFiles(taskId: string): ReceiptFile[] {
  try {
    return receiptFiles(taskId, "out");
  } catch {
    return [];
  }
}

export function getPublicReceipt(taskId: string): PublicReceipt | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT task_id, from_agent, to_agent, status, created_at, started_at, completed_at, spec_hash, output_hash, payment,
              output_commitment, output_files_hash, parent_task_id
       FROM tasks WHERE task_id = ?`,
    )
    .get(taskId) as
    | {
        task_id: string;
        from_agent: string;
        to_agent: string;
        status: string;
        created_at: string;
        started_at: string | null;
        completed_at: string | null;
        spec_hash: string | null;
        output_hash: string | null;
        payment: string | null;
        output_commitment: string | null;
        output_files_hash: string | null;
        parent_task_id: string | null;
      }
    | undefined;
  if (!row) return null;
  const handedBack = returnedFiles(taskId);

  const pay = db
    .prepare(
      `SELECT amount_eth, currency, status, signature, settled_at
       FROM transactions WHERE task_id = ? ORDER BY (incoming_signature IS NULL) ASC, created_at ASC LIMIT 1`,
    )
    .get(taskId) as
    | { amount_eth: number; currency: string; status: string; signature: string | null; settled_at: string | null }
    | undefined;

  const names = (id: string): string | null => {
    const a = db.prepare("SELECT name FROM agents WHERE agent_id = ?").get(id) as { name: string } | undefined;
    return a?.name ?? null;
  };

  const spec = verifyTaskSpec(taskId);

  return {
    taskId: row.task_id,
    fromAgent: row.from_agent,
    fromName: names(row.from_agent),
    toAgent: row.to_agent,
    toName: names(row.to_agent),
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    payment: row.payment,
    specHash: row.spec_hash,
    outputHash: row.output_hash,
    specVerified: spec && spec.committed ? spec.matches : null,
    settlement: pay
      ? {
          amount: pay.amount_eth,
          currency: pay.currency,
          status: pay.status,
          signature: pay.signature,
          settledAt: pay.settled_at,
        }
      : null,
    // a follow-up names the job it continues; that both jobs exist is public, what was said in them is not
    ...(row.parent_task_id ? { followUpOf: row.parent_task_id, turn: turnOf({ taskId: row.task_id, parentTaskId: row.parent_task_id }) } : {}),
    // only a job that handed back files gains anything here: every other receipt reads exactly as it did
    ...(handedBack.length
      ? {
          // which agent made a file is public the way every party to a job is; its name still is not
          outputFiles: handedBack.map((f) => ({
            type: f.type, size: f.size, sha256: f.sha256, stored: f.stored, ...(f.madeBy ? { madeBy: f.madeBy } : {}),
            ...(f.version && f.revises && f.first ? { version: f.version, revises: f.revises, first: f.first } : {}),
          })),
          ...(row.output_files_hash ? { outputFilesHash: row.output_files_hash } : {}),
          ...(row.output_commitment ? { commitmentTx: row.output_commitment } : {}),
        }
      : {}),
  };
}

export function getReceipt(taskId: string): Receipt {
  const db = getDb();

  const taskRow = db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
  // A split task has a parent row (full amount + on-chain signature) plus a payout
  // row per recipient. Prefer the parent so the receipt shows the actual payment.
  const paymentRow = db
    .prepare("SELECT * FROM transactions WHERE task_id = ? ORDER BY (incoming_signature IS NULL) ASC, created_at ASC LIMIT 1")
    .get(taskId) as Record<string, unknown> | undefined;

  const deliveryRows = db.prepare(`
    SELECT delivery_id, webhook_id, event_type, status, attempts, response_status, last_attempt_at
    FROM webhook_deliveries
    WHERE json_extract(payload, '$.data.taskId') = ?
    ORDER BY created_at ASC
  `).all(taskId) as {
    delivery_id: string;
    webhook_id: string;
    event_type: string;
    status: string;
    attempts: number;
    response_status: number | null;
    last_attempt_at: string | null;
  }[];

  const task: Task | null = taskRow
    ? {
        taskId: taskRow.task_id as string,
        fromAgent: taskRow.from_agent as string,
        toAgent: taskRow.to_agent as string,
        task: taskRow.task as string,
        context: taskRow.context ? (() => { try { return JSON.parse(taskRow.context as string) as Record<string, unknown>; } catch { return undefined; } })() : undefined,
        payment: taskRow.payment as string ?? undefined,
        status: taskRow.status as Task["status"],
        output: taskRow.output as string ?? undefined,
        error: taskRow.error as string ?? undefined,
        createdAt: taskRow.created_at as string,
        startedAt: taskRow.started_at as string ?? undefined,
        completedAt: taskRow.completed_at as string ?? undefined,
        specHash: taskRow.spec_hash as string ?? undefined,
        outputHash: taskRow.output_hash as string ?? undefined,
        outputCommitment: taskRow.output_commitment as string ?? undefined,
        stuckCount: (taskRow.stuck_count as number) ?? 0,
      }
    : null;

  const payment: Payment | null = paymentRow
    ? {
        txId: paymentRow.tx_id as string,
        taskId: paymentRow.task_id as string ?? undefined,
        fromAgent: paymentRow.from_agent as string,
        toAgent: paymentRow.to_agent as string,
        amountEth: paymentRow.amount_eth as number,
        currency: paymentRow.currency as string,
        status: paymentRow.status as Payment["status"],
        signature: paymentRow.signature as string ?? undefined,
        incomingSignature: paymentRow.incoming_signature as string ?? undefined,
        createdAt: paymentRow.created_at as string,
        settledAt: paymentRow.settled_at as string ?? undefined,
      }
    : null;

  // Determine whether there is an open MPP channel for this task's sender
  let hasOpenMppChannel = false;
  if (task?.fromAgent) {
    const mppRow = db
      .prepare("SELECT 1 FROM mpp_channels WHERE owner_address = ? AND status = 'open' LIMIT 1")
      .get(task.fromAgent);
    hasOpenMppChannel = !!mppRow;
  }

  const recommendedPath = recommendPaymentPath({
    agentPrice: task?.payment,
    hasOpenMppChannel,
  });

  return {
    taskId,
    task,
    payment,
    webhookDeliveries: deliveryRows.map((r) => ({
      deliveryId: r.delivery_id,
      webhookId: r.webhook_id,
      eventType: r.event_type as WebhookDelivery["eventType"],
      status: r.status as WebhookDelivery["status"],
      attempts: r.attempts,
      responseStatus: r.response_status ?? undefined,
      lastAttemptAt: r.last_attempt_at ?? undefined,
    })),
    recommendedPath,
    specVerification: verifyTaskSpec(taskId),
    outputCommitment: getOutputCommitment(taskId),
    progress: getTaskProgress(taskId),
    notes: getPaymentNotes(taskId),
    splits: getSplitsForTask(taskId),
    sla: getSlaForTask(taskId),
    ...(returnedFiles(taskId).length ? { outputFiles: returnedFiles(taskId) } : {}),
  };
}

/**
 * The work an agent has actually done, as public receipts, newest first.
 *
 * The profile has always shown an agent's track record as totals — jobs
 * completed, success rate, ETH earned — and asked you to believe them. Every one
 * of those jobs already has a public receipt; this is what lets the page show the
 * jobs instead of just counting them.
 *
 * Only work the agent *performed* (`role: "recipient"`), because that is what a
 * track record is. Failed runs are included and left visible: the success rate is
 * already on the page, so hiding the failures here would only make the two
 * disagree, and a receipt exists either way.
 *
 * Built out of `getPublicReceipt` rather than its own query. That costs a few
 * small reads per row, which is nothing at this size, and it means the one
 * audited definition of "what a receipt may show" governs this page too — a
 * parallel SELECT here could drift into exposing something the receipt never did.
 */
export function getAgentRecentWork(agentId: string, limit = 10): PublicReceipt[] {
  const tasks = getTasksByAgent({ agentId, role: "recipient", limit: limit * 3 });
  const out: PublicReceipt[] = [];
  for (const t of tasks) {
    if (t.status !== "completed" && t.status !== "failed") continue;
    const receipt = getPublicReceipt(t.taskId);
    if (receipt) out.push(receipt);
    if (out.length >= limit) break;
  }
  return out;
}

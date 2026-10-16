// What agents did in their owner's apps, job by job.
//
// Whose apps a job may use: the wallet a hire named with a key (apps_owner on the job), or, for a job a wallet hired
// itself (a schedule, a trigger, a hire signed with the owner's key), that wallet. A hire without either uses nobody's.
//
// Every thing an agent does in an app for a job is a line here: what it read, the drafts it wrote, what it asked to
// post and what came of it. The owner reads these lines on the job's receipt, drafts and all. The public receipt gets
// an "app.action" event for each: the app, the kind of action and how it went, with fingerprints. Never what was read
// or written, never a channel's name.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { isWalletAddress, normalizeAddress } from "./address";
import { safeAppendTraceEvent, sha256hex, traceIdForTask } from "./traceEvents";
import type { AppAction } from "./appRegistry";

// ── Whose apps a job uses ────────────────────────────────────────────────────

/** Note on a job whose apps it may use. Only a wallet; anything else is ignored. */
export function setAppsOwner(taskId: string, wallet: string | null | undefined): void {
  const w = wallet ? normalizeAddress(wallet) : null;
  if (w) getDb().prepare("UPDATE tasks SET apps_owner = ? WHERE task_id = ?").run(w.toLowerCase(), taskId);
}

/** The wallet whose apps this job may use, or null. */
export function appsOwnerOf(task: { taskId: string; fromAgent: string }): string | null {
  const row = getDb().prepare("SELECT apps_owner o FROM tasks WHERE task_id = ?").get(task.taskId) as { o: string | null } | undefined;
  if (row?.o) return row.o;
  return isWalletAddress(task.fromAgent) ? task.fromAgent.toLowerCase() : null;
}

// ── The log ──────────────────────────────────────────────────────────────────

export type ActionStatus = "done" | "failed" | "draft" | "waiting" | "posted" | "declined" | "expired" | "cancelled" | "approved";

export interface AppActionLine {
  actionId: string;
  agentId: string;
  taskId: string;
  appId: string;
  action: AppAction;
  summary: string;
  target: string | null;
  targetLabel: string | null;
  body: string | null;
  approvalId: string | null;
  status: ActionStatus;
  error: string | null;
  link: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  action_id: string;
  owner_wallet: string;
  agent_id: string;
  task_id: string;
  app_id: string;
  action: AppAction;
  summary: string;
  target: string | null;
  target_label: string | null;
  body: string | null;
  approval_id: string | null;
  status: ActionStatus;
  error: string | null;
  link: string | null;
  created_at: string;
  updated_at: string;
}

const toLine = (r: Row): AppActionLine => ({
  actionId: r.action_id,
  agentId: r.agent_id,
  taskId: r.task_id,
  appId: r.app_id,
  action: r.action,
  summary: r.summary,
  target: r.target,
  targetLabel: r.target_label,
  body: r.body,
  approvalId: r.approval_id,
  status: r.status,
  error: r.error,
  link: r.link,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** On the public receipt: the app, the kind of action, a word for what, and how it went. Fingerprints, not content. */
function onReceipt(r: Row, what: string, extra: Record<string, unknown> = {}): void {
  safeAppendTraceEvent({
    traceId: traceIdForTask(r.task_id),
    taskId: r.task_id,
    kind: "app.action",
    fromAgent: r.agent_id,
    inputHash: r.target ? sha256hex(`${r.app_id}:${r.target}`) : null,
    outputHash: r.body ? sha256hex(r.body) : null,
    meta: { app: r.app_id, action: r.action, what, status: r.status, ...extra },
  });
}

export interface NewAction {
  ownerWallet: string;
  agentId: string;
  taskId: string;
  appId: string;
  action: AppAction;
  /** a word for the public receipt: channels, messages, draft, post */
  what: string;
  summary: string;
  target?: string | null;
  targetLabel?: string | null;
  body?: string | null;
  approvalId?: string | null;
  status: ActionStatus;
  error?: string | null;
  link?: string | null;
  /** a count for the public receipt, e.g. how many messages were read */
  count?: number;
}

export function recordAction(a: NewAction, now = Date.now()): AppActionLine {
  const at = new Date(now).toISOString();
  const row: Row = {
    action_id: `appa_${randomUUID()}`,
    owner_wallet: a.ownerWallet.toLowerCase(),
    agent_id: a.agentId,
    task_id: a.taskId,
    app_id: a.appId,
    action: a.action,
    summary: a.summary.slice(0, 300),
    target: a.target ?? null,
    target_label: a.targetLabel ?? null,
    body: a.body ?? null,
    approval_id: a.approvalId ?? null,
    status: a.status,
    error: a.error ? a.error.slice(0, 300) : null,
    link: a.link ?? null,
    created_at: at,
    updated_at: at,
  };
  getDb()
    .prepare(
      `INSERT INTO app_actions (action_id, owner_wallet, agent_id, task_id, app_id, action, summary, target, target_label, body, approval_id, status, error, link, created_at, updated_at)
       VALUES (@action_id, @owner_wallet, @agent_id, @task_id, @app_id, @action, @summary, @target, @target_label, @body, @approval_id, @status, @error, @link, @created_at, @updated_at)`,
    )
    .run(row);
  onReceipt(row, a.what, typeof a.count === "number" ? { count: a.count } : {});
  return toLine(row);
}

/** What came of something that waited for the owner's OK: posted, or not and why. Said on the receipt too. */
export function settleAction(approvalId: string, s: { status: ActionStatus; error?: string | null; link?: string | null; summary?: string; receipt?: boolean }, now = Date.now()): AppActionLine | null {
  const row = getDb()
    .prepare("UPDATE app_actions SET status = ?, error = ?, link = COALESCE(?, link), summary = COALESCE(?, summary), updated_at = ? WHERE approval_id = ? RETURNING *")
    .get(s.status, s.error ? s.error.slice(0, 300) : null, s.link ?? null, s.summary ?? null, new Date(now).toISOString(), approvalId) as Row | undefined;
  if (!row) return null;
  // a decision is on the receipt already, as an "app.approval" event; what the app did with it is not
  if (s.receipt !== false) onReceipt(row, "post");
  return toLine(row);
}

/** One job's lines, oldest first, for its owner only. */
export function actionsForTask(ownerWallet: string, taskId: string): AppActionLine[] {
  return (getDb().prepare("SELECT * FROM app_actions WHERE owner_wallet = ? AND task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 200").all(ownerWallet.toLowerCase(), taskId) as Row[]).map(toLine);
}

/** The line for something that waited for the owner's OK. */
export function actionForApproval(approvalId: string): AppActionLine | null {
  const row = getDb().prepare("SELECT * FROM app_actions WHERE approval_id = ?").get(approvalId) as Row | undefined;
  return row ? toLine(row) : null;
}

/** How many times this job has done this in this app (to hold a job to a few posts). */
export function countActions(taskId: string, appId: string, action: AppAction): number {
  return (getDb().prepare("SELECT COUNT(*) n FROM app_actions WHERE task_id = ? AND app_id = ? AND action = ?").get(taskId, appId, action) as { n: number }).n;
}

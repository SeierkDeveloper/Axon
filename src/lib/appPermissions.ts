// What an agent may do in its owner's apps, and the owner's OK for anything that goes out.
//
// Per owner, per agent, per app: a set of actions out of read, draft and publish. An agent the owner has said nothing
// about gets the safest set, read and draft. Publish (which covers sending) has to be allowed for that agent, and then
// every single thing it wants to publish or send waits here as an approval:
//
//   pending   asked, with a title, a preview the owner reads, and the exact payload that would go out
//   approved  the owner said yes; it may be carried out once, within the 24 hours the request had
//   declined  the owner said no
//   expired   nobody answered in 24 hours
//   cancelled the app was disconnected while it waited
//   used      it was carried out (takeApproved hands the payload over exactly once)
//   failed    it was carried out and the app said no (a channel that is gone, a revoked token); not tried again
//
// Every request and every decision is written to the job's receipt as an "app.approval" event: the app, the action,
// what happened, and the fingerprint of the payload. Never the payload itself.
//
// Posting without asking (standing): the owner may let one agent post in one place in an app (one Slack channel)
// without their OK each time, for jobs that start themselves (a schedule, a trigger). Off unless the owner sets it, it
// counts only while the agent may publish in that app, and it goes when the app is disconnected or the agent's
// permission is reset or loses publish. What goes out that way is still written down as an approval, decided by
// "standing", so it is on the receipt and in the owner's list like anything else.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { logger } from "./logger";
import { normalizeAddress } from "./address";
import { getAgentById } from "./agents";
import { getTaskById } from "./tasks";
import { safeAppendTraceEvent, sha256hex, traceIdForTask } from "./traceEvents";
import { ACTIONS, DEFAULT_ACTIONS, appsEnabled, getApp, isAction, type AppAction } from "./appRegistry";
import { AppError, getConnection } from "./appConnect";
import { settleAction } from "./appActivity";

type Env = Record<string, string | undefined>;

export const APPROVAL_TTL_MS = 24 * 60 * 60_000;
export const LIMITS = { title: 140, preview: 20_000, payload: 200_000, pendingPerOwner: 50 } as const;

export type ApprovalStatus = "pending" | "approved" | "declined" | "expired" | "cancelled" | "used" | "failed";

export interface Approval {
  approvalId: string;
  ownerWallet: string;
  agentId: string;
  taskId: string;
  appId: string;
  action: AppAction;
  title: string;
  preview: string;
  payloadSha256: string;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

interface ApprovalRow {
  approval_id: string;
  owner_wallet: string;
  agent_id: string;
  task_id: string;
  app_id: string;
  action: AppAction;
  title: string;
  preview: string;
  payload: string;
  payload_sha256: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

const toApproval = (r: ApprovalRow): Approval => ({
  approvalId: r.approval_id,
  ownerWallet: r.owner_wallet,
  agentId: r.agent_id,
  taskId: r.task_id,
  appId: r.app_id,
  action: r.action,
  title: r.title,
  preview: r.preview,
  payloadSha256: r.payload_sha256,
  status: r.status,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
  createdAt: r.created_at,
});

const iso = (ms: number): string => new Date(ms).toISOString();
const owner = (wallet: string): string => {
  const w = normalizeAddress(wallet);
  if (!w) throw new AppError("That is not a wallet address.", 400);
  return w.toLowerCase();
};
const appOf = (appId: string) => {
  const app = getApp(appId);
  if (!app) throw new AppError("There is no such app.", 404);
  return app;
};

// ── Permissions ──────────────────────────────────────────────────────────────

const parseActions = (text: string): AppAction[] => ACTIONS.filter((a) => text.split(",").map((s) => s.trim()).includes(a));

/** What an agent may do in one of its owner's apps: what the owner set, or read and draft. */
export function allowedActions(ownerWallet: string, agentId: string, appId: string): AppAction[] {
  const row = getDb().prepare("SELECT actions FROM app_permissions WHERE owner_wallet = ? AND agent_id = ? AND app_id = ?").get(owner(ownerWallet), agentId, appId) as { actions: string } | undefined;
  return row ? parseActions(row.actions) : [...DEFAULT_ACTIONS];
}

export interface Permission { agentId: string; agentName: string | null; appId: string; actions: AppAction[]; updatedAt: string }

export function listPermissions(ownerWallet: string): Permission[] {
  const rows = getDb().prepare("SELECT agent_id, app_id, actions, updated_at FROM app_permissions WHERE owner_wallet = ? ORDER BY updated_at DESC").all(owner(ownerWallet)) as { agent_id: string; app_id: string; actions: string; updated_at: string }[];
  return rows.map((r) => ({ agentId: r.agent_id, agentName: getAgentById(r.agent_id)?.name ?? null, appId: r.app_id, actions: parseActions(r.actions), updatedAt: r.updated_at }));
}

/** Set what one agent may do in one app. An empty list means nothing at all, not the defaults. */
export function setPermission(ownerWallet: string, agentId: string, appId: string, actions: unknown, now = Date.now()): Permission {
  appOf(appId);
  if (!getAgentById(agentId)) throw new AppError("There is no such agent.", 404);
  if (!Array.isArray(actions) || actions.some((a) => !isAction(a))) throw new AppError("actions must be a list of read, draft and publish.", 400);
  const set = ACTIONS.filter((a) => (actions as unknown[]).includes(a));
  // publishing without reading or drafting what goes out makes no sense, and would be easy to set by mistake
  if (set.includes("publish") && !set.includes("draft")) throw new AppError("An agent that may publish or send must be allowed to write drafts too.", 400);
  const who = owner(ownerWallet);
  getDb()
    .prepare("INSERT INTO app_permissions (owner_wallet, agent_id, app_id, actions, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_wallet, agent_id, app_id) DO UPDATE SET actions = excluded.actions, updated_at = excluded.updated_at")
    .run(who, agentId, appId, set.join(","), iso(now));
  // an agent that may no longer publish there may no longer post without asking either
  if (!set.includes("publish")) clearStanding(who, appId, agentId);
  return { agentId, agentName: getAgentById(agentId)?.name ?? null, appId, actions: set, updatedAt: iso(now) };
}

/** Back to the defaults for one agent in one app. */
export function resetPermission(ownerWallet: string, agentId: string, appId: string): boolean {
  clearStanding(ownerWallet, appId, agentId);
  return getDb().prepare("DELETE FROM app_permissions WHERE owner_wallet = ? AND agent_id = ? AND app_id = ?").run(owner(ownerWallet), agentId, appId).changes > 0;
}

// ── Posting without asking ───────────────────────────────────────────────────

export interface Standing { agentId: string; agentName: string | null; appId: string; target: string; targetLabel: string; createdAt: string }

/** Where the owner lets agents post without asking each time, newest first. */
export function listStanding(ownerWallet: string): Standing[] {
  const rows = getDb().prepare("SELECT agent_id, app_id, target, target_label, created_at FROM app_standing WHERE owner_wallet = ? ORDER BY created_at DESC").all(owner(ownerWallet)) as { agent_id: string; app_id: string; target: string; target_label: string; created_at: string }[];
  return rows.map((r) => ({ agentId: r.agent_id, agentName: getAgentById(r.agent_id)?.name ?? null, appId: r.app_id, target: r.target, targetLabel: r.target_label, createdAt: r.created_at }));
}

/** Let one agent post in one place without asking. Only for an agent the owner already lets publish in that app. */
export function allowStanding(ownerWallet: string, agentId: string, appId: string, target: { id: string; label: string }, now = Date.now()): Standing {
  const app = appOf(appId);
  if (!getAgentById(agentId)) throw new AppError("There is no such agent.", 404);
  if (!allowedActions(ownerWallet, agentId, app.id).includes("publish")) throw new AppError(`Let this agent publish in ${app.name} first. Posting without asking is only for an agent that may publish.`, 400);
  const id = String(target.id ?? "").trim();
  const label = String(target.label ?? "").trim().slice(0, 100);
  if (!id || id.length > 64 || !label) throw new AppError("Say where.", 400);
  getDb()
    .prepare("INSERT INTO app_standing (owner_wallet, agent_id, app_id, target, target_label, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(owner_wallet, agent_id, app_id, target) DO UPDATE SET target_label = excluded.target_label")
    .run(owner(ownerWallet), agentId, app.id, id, label, iso(now));
  logger.info("apps.standing_allowed", "An owner let an agent post without asking", { app: app.id, agentId });
  return { agentId, agentName: getAgentById(agentId)?.name ?? null, appId: String(app.id), target: id, targetLabel: label, createdAt: iso(now) };
}

/** Stop one agent posting in one place without asking. */
export function stopStanding(ownerWallet: string, agentId: string, appId: string, target: string): boolean {
  return getDb().prepare("DELETE FROM app_standing WHERE owner_wallet = ? AND agent_id = ? AND app_id = ? AND target = ?").run(owner(ownerWallet), agentId, appId, target).changes > 0;
}

/** Remove every place an app's agents (or one agent) may post without asking. */
export function clearStanding(ownerWallet: string, appId: string, agentId?: string): number {
  const who = owner(ownerWallet);
  return agentId
    ? getDb().prepare("DELETE FROM app_standing WHERE owner_wallet = ? AND app_id = ? AND agent_id = ?").run(who, appId, agentId).changes
    : getDb().prepare("DELETE FROM app_standing WHERE owner_wallet = ? AND app_id = ?").run(who, appId).changes;
}

/** Whether this agent may post in this place without asking right now: set by the owner, and it may still publish. */
export function standsFor(ownerWallet: string, agentId: string, appId: string, target: string, env: Env = process.env): boolean {
  if (!canDo(ownerWallet, agentId, appId, "publish", env)) return false;
  return Boolean(getDb().prepare("SELECT 1 FROM app_standing WHERE owner_wallet = ? AND agent_id = ? AND app_id = ? AND target = ?").get(owner(ownerWallet), agentId, appId, target));
}

/**
 * Whether an agent may do something in one of its owner's apps right now: apps are on, the app is connected and
 * working, and the owner allows that action for that agent. For publish this only means the agent may ask: the
 * thing itself still waits for the owner's OK (requestApproval).
 */
export function canDo(ownerWallet: string, agentId: string, appId: string, action: AppAction, env: Env = process.env): boolean {
  if (!appsEnabled(env) || !isAction(action) || !getApp(appId)) return false;
  const c = getConnection(ownerWallet, appId);
  if (!c || c.needsReconnect) return false;
  return allowedActions(ownerWallet, agentId, appId).includes(action);
}

// ── Approvals ────────────────────────────────────────────────────────────────

function onReceipt(a: { approvalId: string; taskId: string; agentId: string; appId: string; action: string; payloadSha256: string }, status: string, by: "agent" | "owner" | "expiry" | "disconnect" | "standing" | "app"): void {
  safeAppendTraceEvent({
    traceId: traceIdForTask(a.taskId),
    taskId: a.taskId,
    kind: "app.approval",
    fromAgent: a.agentId,
    inputHash: a.payloadSha256,
    meta: { approval: a.approvalId, app: a.appId, action: a.action, status, by },
  });
}

export interface ApprovalRequest {
  ownerWallet: string;
  agentId: string;
  taskId: string;
  appId: string;
  /** what the owner reads first: one line */
  title: string;
  /** what the owner reads before saying yes, made from the payload */
  preview: string;
  /** exactly what will be sent once approved, handed back by takeApproved */
  payload: unknown;
}

/** Ask the owner's OK to publish or send something. Throws when the agent may not even ask. */
export function requestApproval(req: ApprovalRequest, opts: { env?: Env; now?: number } = {}): Approval {
  return insertApproval(req, { ...opts, standing: null });
}

/**
 * Something the owner lets this agent post in this place without asking (see standsFor): written down as an approval
 * decided by "standing" and already taken, so it is on the receipt and in the owner's list, and handed straight back
 * to be carried out. Throws when the owner does not let it.
 */
export function recordStanding(req: ApprovalRequest, target: string, opts: { env?: Env; now?: number } = {}): { approval: Approval; payload: unknown } {
  const env = opts.env ?? process.env;
  if (!standsFor(req.ownerWallet, req.agentId, req.appId, target, env)) throw new AppError("This agent may not post there without asking.", 403);
  const a = insertApproval(req, { ...opts, standing: target });
  return { approval: a, payload: JSON.parse(JSON.stringify(req.payload ?? null)) as unknown };
}

function insertApproval(req: ApprovalRequest, opts: { env?: Env; now?: number; standing: string | null }): Approval {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const app = appOf(req.appId);
  const who = owner(req.ownerWallet);
  if (!canDo(who, req.agentId, app.id, "publish", env)) throw new AppError(`This agent may not publish or send in ${app.name} for its owner.`, 403);
  const task = getTaskById(req.taskId);
  if (!task || task.toAgent !== req.agentId) throw new AppError("That job is not this agent's.", 404);
  const title = String(req.title ?? "").trim().replace(/\s+/g, " ");
  const preview = String(req.preview ?? "").trim();
  const payload = JSON.stringify(req.payload ?? null);
  if (!title || title.length > LIMITS.title) throw new AppError(`A title of 1 to ${LIMITS.title} characters is needed.`, 400);
  if (!preview || preview.length > LIMITS.preview) throw new AppError(`A preview of 1 to ${LIMITS.preview} characters is needed.`, 400);
  if (payload.length > LIMITS.payload) throw new AppError("What would be sent is too large to ask about.", 400);
  expireApprovals(now);
  if (!opts.standing) {
    const waiting = (getDb().prepare("SELECT COUNT(*) AS n FROM app_approvals WHERE owner_wallet = ? AND status = 'pending'").get(who) as { n: number }).n;
    if (waiting >= LIMITS.pendingPerOwner) throw new AppError("The owner has too many things waiting for an OK already.", 429);
  }

  const row: ApprovalRow = {
    approval_id: `apr_${randomUUID()}`,
    owner_wallet: who,
    agent_id: req.agentId,
    task_id: req.taskId,
    app_id: String(app.id),
    action: "publish",
    title,
    preview,
    payload,
    payload_sha256: sha256hex(payload),
    status: opts.standing ? "used" : "pending",
    decided_by: opts.standing ? "standing" : null,
    decided_at: opts.standing ? iso(now) : null,
    expires_at: iso(now + APPROVAL_TTL_MS),
    used_at: opts.standing ? iso(now) : null,
    created_at: iso(now),
  };
  getDb()
    .prepare(
      `INSERT INTO app_approvals (approval_id, owner_wallet, agent_id, task_id, app_id, action, title, preview, payload, payload_sha256, status, decided_by, decided_at, expires_at, used_at, created_at)
       VALUES (@approval_id, @owner_wallet, @agent_id, @task_id, @app_id, @action, @title, @preview, @payload, @payload_sha256, @status, @decided_by, @decided_at, @expires_at, @used_at, @created_at)`,
    )
    .run(row);
  const a = toApproval(row);
  if (opts.standing) {
    onReceipt(a, "allowed without asking", "standing");
    logger.info("apps.approval_standing", "An agent posted where its owner lets it without asking", { approvalId: a.approvalId, app: a.appId, taskId: a.taskId });
  } else {
    onReceipt(a, "asked", "agent");
    logger.info("apps.approval_asked", "An agent asked to publish or send", { approvalId: a.approvalId, app: a.appId, taskId: a.taskId });
  }
  return a;
}

/**
 * Something taken to be carried out could not go out for a reason that may pass (the app was busy or could not be
 * reached): it is approved again, so it is tried again later, until it runs out. Only while it is still the one taken.
 */
export function returnApproved(approvalId: string): boolean {
  return getDb().prepare("UPDATE app_approvals SET status = 'approved', used_at = NULL WHERE approval_id = ? AND status = 'used' AND decided_by != 'standing'").run(approvalId).changes > 0;
}

/** Something taken to be carried out was refused by the app for good: failed, and said so on the receipt. */
export function markFailed(approvalId: string): void {
  const row = getDb().prepare("UPDATE app_approvals SET status = 'failed' WHERE approval_id = ? AND status = 'used' RETURNING *").get(approvalId) as ApprovalRow | undefined;
  if (row) onReceipt(toApproval(row), "failed", "app");
}

/** Approved requests not carried out yet, oldest first: what the apps tick tries again. */
export function approvedWaiting(limit = 20, now = Date.now()): Approval[] {
  return (getDb().prepare("SELECT * FROM app_approvals WHERE status = 'approved' AND expires_at > ? ORDER BY decided_at ASC LIMIT ?").all(iso(now), limit) as ApprovalRow[]).map(toApproval);
}

/** One of the owner's requests, or null. */
export function getApproval(ownerWallet: string, approvalId: string): Approval | null {
  const row = getDb().prepare("SELECT * FROM app_approvals WHERE approval_id = ? AND owner_wallet = ?").get(approvalId, owner(ownerWallet)) as ApprovalRow | undefined;
  return row ? toApproval(row) : null;
}

/** Requests nobody answered in time: expired, and said so on their receipts. */
export function expireApprovals(now = Date.now()): number {
  const rows = getDb().prepare("UPDATE app_approvals SET status = 'expired', decided_by = 'expiry', decided_at = ? WHERE status IN ('pending', 'approved') AND expires_at <= ? RETURNING *").all(iso(now), iso(now)) as ApprovalRow[];
  for (const r of rows) {
    onReceipt(toApproval(r), "expired", "expiry");
    settleAction(r.approval_id, { status: "expired", receipt: false }, now);
  }
  return rows.length;
}

/** The owner's yes or no. Only a request still waiting can be decided, and only by its owner. */
export function decideApproval(ownerWallet: string, approvalId: string, decision: "approve" | "decline", now = Date.now()): Approval {
  if (decision !== "approve" && decision !== "decline") throw new AppError('decision must be "approve" or "decline".', 400);
  const who = owner(ownerWallet);
  expireApprovals(now);
  const status: ApprovalStatus = decision === "approve" ? "approved" : "declined";
  const row = getDb()
    .prepare("UPDATE app_approvals SET status = ?, decided_by = ?, decided_at = ? WHERE approval_id = ? AND owner_wallet = ? AND status = 'pending' AND expires_at > ? RETURNING *")
    .get(status, who, iso(now), approvalId, who, iso(now)) as ApprovalRow | undefined;
  if (!row) {
    const existing = getDb().prepare("SELECT status FROM app_approvals WHERE approval_id = ? AND owner_wallet = ?").get(approvalId, who) as { status: ApprovalStatus } | undefined;
    if (!existing) throw new AppError("There is no such request.", 404);
    throw new AppError(`This request is ${existing.status} already.`, 409);
  }
  const a = toApproval(row);
  onReceipt(a, status, "owner");
  settleAction(a.approvalId, { status: decision === "approve" ? "approved" : "declined", receipt: false }, now);
  logger.info("apps.approval_decided", "An owner decided on a request", { approvalId, status });
  return a;
}

/**
 * Carry out an approved request: hands back the payload the owner saw, exactly once, and marks it used. Null when it
 * is not approved (any more), was used already, has run out, or is not this owner's, agent's and app's.
 */
export function takeApproved(approvalId: string, expect: { ownerWallet: string; agentId: string; appId: string }, now = Date.now()): { approval: Approval; payload: unknown } | null {
  const row = getDb()
    .prepare("UPDATE app_approvals SET status = 'used', used_at = ? WHERE approval_id = ? AND owner_wallet = ? AND agent_id = ? AND app_id = ? AND status = 'approved' AND expires_at > ? RETURNING *")
    .get(iso(now), approvalId, owner(expect.ownerWallet), expect.agentId, expect.appId, iso(now)) as ApprovalRow | undefined;
  if (!row) return null;
  // what is handed over is what the owner saw: the fingerprint is checked again
  if (sha256hex(row.payload) !== row.payload_sha256) {
    logger.error("apps.approval_tampered", "An approved request's payload does not match its fingerprint", { approvalId });
    return null;
  }
  const a = toApproval(row);
  onReceipt(a, "used", "agent");
  return { approval: a, payload: JSON.parse(row.payload) as unknown };
}

/** Where a request stands, for the agent that asked. */
export function approvalStatus(approvalId: string, now = Date.now()): ApprovalStatus | null {
  expireApprovals(now);
  const row = getDb().prepare("SELECT status FROM app_approvals WHERE approval_id = ?").get(approvalId) as { status: ApprovalStatus } | undefined;
  return row?.status ?? null;
}

/** An app was disconnected: what waited to go out through it is cancelled. */
export function cancelForApp(ownerWallet: string, appId: string, now = Date.now()): number {
  const rows = getDb()
    .prepare("UPDATE app_approvals SET status = 'cancelled', decided_by = 'disconnect', decided_at = ? WHERE owner_wallet = ? AND app_id = ? AND status IN ('pending', 'approved') RETURNING *")
    .all(iso(now), owner(ownerWallet), appId) as ApprovalRow[];
  for (const r of rows) {
    onReceipt(toApproval(r), "cancelled", "disconnect");
    settleAction(r.approval_id, { status: "cancelled", receipt: false }, now);
  }
  return rows.length;
}

export interface ApprovalView extends Omit<Approval, "ownerWallet"> { agentName: string | null; appName: string; receiptUrl: string }

/** The owner's inbox: what waits, oldest first, and what was decided lately. */
export function listApprovals(ownerWallet: string, now = Date.now()): { pending: ApprovalView[]; recent: ApprovalView[] } {
  expireApprovals(now);
  const who = owner(ownerWallet);
  const pending = getDb().prepare("SELECT * FROM app_approvals WHERE owner_wallet = ? AND status = 'pending' ORDER BY created_at ASC LIMIT 100").all(who) as ApprovalRow[];
  const recent = getDb().prepare("SELECT * FROM app_approvals WHERE owner_wallet = ? AND status != 'pending' ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 20").all(who) as ApprovalRow[];
  return { pending: pending.map(view), recent: recent.map(view) };
}

/** Everything one job asked of the owner, oldest first: for the owner's part of the job's receipt. */
export function approvalsForTask(ownerWallet: string, taskId: string, now = Date.now()): ApprovalView[] {
  expireApprovals(now);
  const who = owner(ownerWallet);
  const rows = getDb().prepare("SELECT * FROM app_approvals WHERE owner_wallet = ? AND task_id = ? ORDER BY created_at ASC LIMIT 50").all(who, taskId) as ApprovalRow[];
  return rows.map(view);
}

const view = (r: ApprovalRow): ApprovalView => {
  const { ownerWallet: _o, ...rest } = toApproval(r);
  void _o;
  return { ...rest, agentName: getAgentById(r.agent_id)?.name ?? null, appName: getApp(r.app_id)?.name ?? r.app_id, receiptUrl: `/r/${encodeURIComponent(r.task_id)}` };
};

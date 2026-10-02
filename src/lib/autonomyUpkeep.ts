// Autonomy, phase 4: upkeep. What the network pass now keeps in order by itself:
//   - work that stopped moving: a task started outside the worker and left running is put back in the queue once;
//     after that, or a task nobody picked up for hours, is failed the way the worker already fails a dead-lettered
//     task, which releases or refunds whatever was paid for it
//   - webhooks failing for hours are switched off, pinged every few hours, and switched back on when they answer
//   - stale agent descriptions are written again, a few per run
//   - an owner whose retainer is about to end is told, once, through the retainer's own webhook
// (Re-pricing for opted-in agents lives with the network pass in autonomyNetwork, limited to once a day.)
//
// Every action needs `apply` and actions enabled, stays within autonomyPolicy's caps, and goes through code the
// network already runs for the same purpose.

import { getDb } from "./db";
import { failTask } from "./tasks";
import { refundPayment } from "./payments";
import { refundDebitForTask } from "./mpp";
import { getWebhookById, getWebhookSecret, sign, postSigned } from "./webhooks";
import { getAgentById } from "./agents";
import { refreshDescription } from "./agentDescription";
import { queueRetainerEvent } from "./retainerWebhooks";
import { STUCK, WEBHOOKS, DESCRIPTIONS, actionsEnabled } from "./autonomyPolicy";
import type { Finding } from "./networkChecks";

const HOUR = 3_600_000;
/** Webhooks autonomy switched off carry this, so only those are ever switched back on by it. */
export const AUTONOMY_DISABLED = "autonomy: failing for hours";

/** Fail a task the way the worker fails a dead-lettered one: the failure, then the refund of whatever paid for it. */
function failAndRelease(taskId: string, reason: string): boolean {
  if (!failTask(taskId, reason)) return false;
  refundPayment(taskId);
  refundDebitForTask(taskId);
  return true;
}

/** Free stuck work: requeue once what was started outside the worker, fail what cannot recover. */
export function freeStuckTasks(findings: Finding[]): Finding[] {
  const db = getDb();
  const out: Finding[] = [];
  for (const f of findings.filter((x) => x.kind === "task-stuck" && x.subject).slice(0, STUCK.maxPerRun)) {
    const t = db.prepare("SELECT status, started_by, stuck_count FROM tasks WHERE task_id = ?").get(f.subject) as
      { status: string; started_by: string | null; stuck_count: number | null } | undefined;
    if (!t) continue;
    // the worker already requeues and dead-letters what it started itself
    if (t.status === "running" && t.started_by === "worker") continue;
    if (t.status === "running" && (t.stuck_count ?? 0) < STUCK.retries) {
      const changed = db
        .prepare("UPDATE tasks SET status='queued', started_at=NULL, started_by=NULL, stuck_count=COALESCE(stuck_count,0)+1, requeued_at=? WHERE task_id=? AND status='running'")
        .run(new Date().toISOString(), f.subject).changes;
      if (changed) out.push({ kind: "task-freed", subject: f.subject, what: "put back in the queue" });
    } else if (failAndRelease(f.subject!, t.status === "queued" ? STUCK.reasons.notPickedUp : STUCK.reasons.stopped)) {
      out.push({ kind: "task-freed", subject: f.subject, what: "closed, and anything paid released" });
    }
  }
  return out;
}

/** A signed ping to a webhook: true if its endpoint answers with success. */
export type Ping = (webhookId: string) => Promise<boolean>;

export const pingWebhook: Ping = async (webhookId) => {
  const hook = getWebhookById(webhookId);
  const secret = getWebhookSecret(webhookId);
  if (!hook || !secret) return false;
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ event: "webhook.ping", timestamp: ts, data: { webhookId } });
  const r = await postSigned(hook.url, "webhook.ping", `ping_${webhookId}_${ts}`, body, ts, sign(secret, ts, body));
  return (r.responseStatus ?? 0) >= 200 && (r.responseStatus ?? 0) < 300;
};

/** Switch off webhooks failing for hours; ping the ones autonomy switched off, and switch back on those that answer. */
export async function webhookUpkeep(findings: Finding[], ping: Ping = pingWebhook, now = Date.now()): Promise<Finding[]> {
  const db = getDb();
  const at = new Date(now).toISOString();
  const out: Finding[] = [];
  for (const f of findings.filter((x) => x.kind === "webhook-failing" && x.subject).slice(0, WEBHOOKS.maxPerRun)) {
    const changed = db
      .prepare("UPDATE webhooks SET status='inactive', disabled_at=?, disabled_reason=? WHERE webhook_id=? AND status='active'")
      .run(at, AUTONOMY_DISABLED, f.subject).changes;
    if (changed) out.push({ kind: "webhook-paused", subject: f.subject, what: "switched off while its endpoint is failing" });
  }
  const due = db
    .prepare("SELECT webhook_id FROM webhooks WHERE status='inactive' AND disabled_reason=? AND disabled_at < ? LIMIT ?")
    .all(AUTONOMY_DISABLED, new Date(now - WEBHOOKS.probeEveryHours * HOUR).toISOString(), WEBHOOKS.maxPerRun) as { webhook_id: string }[];
  for (const { webhook_id } of due) {
    if (await ping(webhook_id).catch(() => false)) {
      db.prepare("UPDATE webhooks SET status='active', failure_count=0, disabled_at=NULL, disabled_reason=NULL, last_success_at=? WHERE webhook_id=?").run(at, webhook_id);
      out.push({ kind: "webhook-restored", subject: webhook_id, what: "switched back on: its endpoint answers again" });
    } else {
      db.prepare("UPDATE webhooks SET disabled_at=? WHERE webhook_id=?").run(at, webhook_id); // next ping in WEBHOOKS.probeEveryHours
    }
  }
  return out;
}

/** Write stale descriptions again, a few per run: each is a model call. */
export async function refreshStaleDescriptions(
  findings: Finding[],
  refresh: (agentId: string) => Promise<boolean> = async (id) => {
    const a = getAgentById(id);
    return a ? refreshDescription(a) : false;
  },
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const f of findings.filter((x) => x.kind === "stale-description" && x.subject).slice(0, DESCRIPTIONS.maxPerRun)) {
    if (await refresh(f.subject!).catch(() => false)) out.push({ kind: "description-refreshed", subject: f.subject, what: "description written again" });
  }
  return out;
}

/** Tell the owner of a retainer that is about to end, once, through the retainer's own webhook. */
export function warnRetainerOwners(findings: Finding[]): Finding[] {
  const db = getDb();
  const out: Finding[] = [];
  for (const f of findings.filter((x) => x.kind === "owner-warning" && x.subject?.startsWith("ret_"))) {
    const told = db.prepare("SELECT 1 FROM retainer_deliveries WHERE retainer_id = ? AND event_type = 'retainer.ending'").get(f.subject);
    if (told) continue;
    const hasHook = db.prepare("SELECT 1 FROM retainers WHERE retainer_id = ? AND webhook_url IS NOT NULL AND webhook_disabled_at IS NULL").get(f.subject);
    if (!hasHook) continue; // the dashboard already warns a week ahead; the webhook is the only other channel
    queueRetainerEvent(f.subject!, "retainer.ending", { retainerId: f.subject, notice: f.what });
    out.push({ kind: "owner-warning", subject: f.subject, what: "owner told the retainer is ending" });
  }
  return out;
}

/** The upkeep actions together. Nothing unless applying with actions enabled. */
export async function upkeepActions(
  findings: Finding[],
  opts: { apply: boolean; ping?: Ping; refresh?: (agentId: string) => Promise<boolean>; now?: number },
): Promise<Finding[]> {
  if (!opts.apply || !actionsEnabled()) return [];
  return [
    ...freeStuckTasks(findings),
    ...(await webhookUpkeep(findings, opts.ping ?? pingWebhook, opts.now ?? Date.now())),
    ...(await refreshStaleDescriptions(findings, opts.refresh)),
    ...warnRetainerOwners(findings),
  ];
}

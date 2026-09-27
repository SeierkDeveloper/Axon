// Delivering a retainer's results to its owner's own endpoint.
//
// Each retainer may carry one webhook URL. Every closed run is posted there (completed with its
// output, or failed/skipped with the reason), and so is a pause. The signature, headers and retry
// schedule are the ones agent webhooks use (webhooks.ts), so a receiver verifies both the same way:
// HMAC-SHA256 over "<timestamp>.<body>" with the secret, in X-Axon-Signature.
//
// A receiver that keeps failing is switched off after three deliveries in a row fail every retry, so
// a dead endpoint does not collect retries forever. The retainer itself keeps running either way:
// results are always in the run history, the webhook is a courtesy on top.

import { randomUUID, randomBytes } from "node:crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { logger } from "./logger";
import { validatePublicHttpUrl } from "./urlSecurity";
import { sign, postSigned, MAX_ATTEMPTS, RETRY_DELAYS_MS } from "./webhooks";
import { getRetainer, RetainerError } from "./retainers";
import { sameAddress } from "./address";

export const RETAINER_EVENTS = ["retainer.run.completed", "retainer.run.failed", "retainer.paused"] as const;
export type RetainerEvent = (typeof RETAINER_EVENTS)[number];

/** Deliveries in a row that failed every retry before the webhook is switched off. */
export const WEBHOOK_FAILURES_BEFORE_OFF = 3;
const CLAIM_LEASE_MS = 120_000;

/**
 * Set, replace or remove a retainer's webhook. Returns the signing secret when one is set: it is shown
 * once and never again, like an agent webhook's. Replacing the URL makes a new secret and switches a
 * disabled webhook back on.
 */
export async function setRetainerWebhook(retainerId: string, wallet: string, url: string | null, nowMs = Date.now()): Promise<{ url: string | null; secret: string | null }> {
  const r = getRetainer(retainerId);
  if (!r || !sameAddress(r.ownerWallet, wallet)) throw new RetainerError("Retainer not found", 404);
  if (url === null) {
    getDb()
      .prepare(`UPDATE retainers SET webhook_url = NULL, webhook_secret = NULL, webhook_failures = 0, webhook_disabled_at = NULL, updated_at = ? WHERE retainer_id = ?`)
      .run(new Date(nowMs).toISOString(), retainerId);
    getDb().prepare(`DELETE FROM retainer_deliveries WHERE retainer_id = ? AND status = 'pending'`).run(retainerId);
    void syncToTurso();
    return { url: null, secret: null };
  }
  const problem = await validatePublicHttpUrl(url);
  if (problem) throw new RetainerError(problem.replace("endpoint", "webhook url"));
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  getDb()
    .prepare(`UPDATE retainers SET webhook_url = ?, webhook_secret = ?, webhook_failures = 0, webhook_disabled_at = NULL, updated_at = ? WHERE retainer_id = ?`)
    .run(url, secret, new Date(nowMs).toISOString(), retainerId);
  void syncToTurso();
  return { url, secret };
}

/** Queue an event for a retainer's webhook. Nothing happens without one, or while it is switched off. */
export function queueRetainerEvent(retainerId: string, event: RetainerEvent, data: Record<string, unknown>, nowMs = Date.now()): void {
  const row = getDb()
    .prepare(`SELECT webhook_url, webhook_disabled_at FROM retainers WHERE retainer_id = ?`)
    .get(retainerId) as { webhook_url: string | null; webhook_disabled_at: string | null } | undefined;
  if (!row?.webhook_url || row.webhook_disabled_at) return;
  const now = new Date(nowMs).toISOString();
  const payload = JSON.stringify({ event, timestamp: Math.floor(nowMs / 1000), data });
  getDb()
    .prepare(
      `INSERT INTO retainer_deliveries (delivery_id, retainer_id, event_type, payload, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .run(`rdl_${randomUUID().replace(/-/g, "").slice(0, 20)}`, retainerId, event, payload, now, now);
}

interface DueDelivery {
  delivery_id: string;
  retainer_id: string;
  event_type: string;
  payload: string;
  attempts: number;
  webhook_url: string;
  webhook_secret: string;
}

async function send(d: DueDelivery, nowMs: number): Promise<"delivered" | "retry" | "failed" | "skipped"> {
  const db = getDb();
  const now = new Date(nowMs).toISOString();
  // Claimed with a lease, so two pollers never send one delivery twice; a crashed send becomes due again.
  const claimed = db
    .prepare(
      `UPDATE retainer_deliveries SET attempts = attempts + 1, last_attempt_at = ?, next_attempt_at = ?
       WHERE delivery_id = ? AND status = 'pending' AND next_attempt_at <= ?`,
    )
    .run(now, new Date(nowMs + CLAIM_LEASE_MS).toISOString(), d.delivery_id, now);
  if (claimed.changes !== 1) return "skipped";

  const timestamp = Math.floor(nowMs / 1000);
  const { responseStatus, responseBody } = await postSigned(
    d.webhook_url, d.event_type, d.delivery_id, d.payload, timestamp, sign(d.webhook_secret, timestamp, d.payload),
  );
  const attempts = d.attempts + 1;

  if (responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300) {
    db.prepare(`UPDATE retainer_deliveries SET status = 'delivered', response_status = ?, response_body = ? WHERE delivery_id = ?`)
      .run(responseStatus, responseBody ?? null, d.delivery_id);
    db.prepare(`UPDATE retainers SET webhook_failures = 0 WHERE retainer_id = ?`).run(d.retainer_id);
    return "delivered";
  }
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(`UPDATE retainer_deliveries SET status = 'failed', response_status = ?, response_body = ? WHERE delivery_id = ?`)
      .run(responseStatus ?? null, responseBody ?? null, d.delivery_id);
    db.prepare(
      `UPDATE retainers SET webhook_failures = webhook_failures + 1,
         webhook_disabled_at = CASE WHEN webhook_failures + 1 >= ? THEN ? ELSE webhook_disabled_at END
       WHERE retainer_id = ?`,
    ).run(WEBHOOK_FAILURES_BEFORE_OFF, now, d.retainer_id);
    logger.warn("retainer.webhook_failed", "Retainer webhook delivery failed after every retry", { deliveryId: d.delivery_id, responseStatus });
    return "failed";
  }
  const delay = RETRY_DELAYS_MS[attempts] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
  db.prepare(`UPDATE retainer_deliveries SET next_attempt_at = ?, response_status = ?, response_body = ? WHERE delivery_id = ?`)
    .run(new Date(nowMs + delay).toISOString(), responseStatus ?? null, responseBody ?? null, d.delivery_id);
  return "retry";
}

/** Send what is due. Called from the retainer tick. */
export async function deliverRetainerWebhooks(nowMs = Date.now(), limit = 20): Promise<Record<string, number>> {
  const due = getDb()
    .prepare(
      `SELECT d.delivery_id, d.retainer_id, d.event_type, d.payload, d.attempts, r.webhook_url, r.webhook_secret
       FROM retainer_deliveries d JOIN retainers r ON r.retainer_id = d.retainer_id
       WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND r.webhook_url IS NOT NULL AND r.webhook_disabled_at IS NULL
       ORDER BY d.next_attempt_at LIMIT ?`,
    )
    .all(new Date(nowMs).toISOString(), limit) as DueDelivery[];
  const counts: Record<string, number> = { delivered: 0, retry: 0, failed: 0, skipped: 0 };
  for (const d of due) counts[await send(d, nowMs)]++;
  if (due.length > 0) void syncToTurso();
  return counts;
}

/** What the owner sees of their webhook. Never the secret. */
export function retainerWebhookStatus(retainerId: string) {
  const row = getDb()
    .prepare(`SELECT webhook_url, webhook_failures, webhook_disabled_at FROM retainers WHERE retainer_id = ?`)
    .get(retainerId) as { webhook_url: string | null; webhook_failures: number; webhook_disabled_at: string | null } | undefined;
  if (!row?.webhook_url) return null;
  const last = getDb()
    .prepare(`SELECT status, response_status, last_attempt_at FROM retainer_deliveries WHERE retainer_id = ? AND status != 'pending' ORDER BY last_attempt_at DESC LIMIT 1`)
    .get(retainerId) as { status: string; response_status: number | null; last_attempt_at: string } | undefined;
  return {
    url: row.webhook_url,
    active: row.webhook_disabled_at === null,
    disabledAt: row.webhook_disabled_at,
    failuresInARow: row.webhook_failures,
    lastDelivery: last ? { status: last.status, responseStatus: last.response_status, at: last.last_attempt_at } : null,
  };
}

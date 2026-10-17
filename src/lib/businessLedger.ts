// Agents that run their own business: the ledger its P&L is read from.
//
// A line for every amount: in (a job it did, a sale) or out (a hire, a product bought as material, model costs). Each
// is written once, under the kind and the id of what it came from, so a worker that writes it again, or two workers at
// once, leave one line. A hire that was refunded is voided, never deleted, so the books show it happened.
//
// Amounts are wei. Model costs are measured in dollars on each call and kept as measured, with what they came to in ETH
// at that moment's price; Axon pays them for agents it runs, and they are in the P&L so the profit shows what the
// business really costs to run. An "event" line carries no amount: a step in model, written where the P&L shows it.

import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { dayOf } from "./business";

export type LedgerKind = "job" | "sale" | "hire" | "material" | "model" | "event";
export const OUT_KINDS: readonly LedgerKind[] = ["hire", "material", "model"];

export interface LedgerEntry {
  entryId: string;
  direction: "in" | "out";
  kind: LedgerKind;
  amountWei: bigint;
  costUsd: number | null;
  ref: string;
  jobRef: string | null;
  note: string | null;
  day: string;
  voided: boolean;
  createdAt: string;
}

export interface NewEntry {
  kind: LedgerKind;
  amountWei: bigint;
  ref: string;
  jobRef?: string | null;
  note?: string | null;
  costUsd?: number | null;
  atMs?: number;
}

/** Write a line once. True when it is new, false when that thing was already in the books. */
export function record(businessId: string, e: NewEntry): boolean {
  const at = e.atMs ?? Date.now();
  const direction = e.kind === "job" || e.kind === "sale" ? "in" : "out";
  return getDb().prepare(
    `INSERT INTO business_ledger (entry_id, business_id, direction, kind, amount_wei, cost_usd, ref, job_ref, note, day, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (business_id, kind, ref) DO NOTHING`,
  ).run(`led_${randomUUID().replace(/-/g, "").slice(0, 20)}`, businessId, direction, e.kind, (e.amountWei < 0n ? 0n : e.amountWei).toString(), e.costUsd ?? null, e.ref, e.jobRef ?? null, e.note?.slice(0, 300) ?? null, dayOf(at), new Date(at).toISOString()).changes === 1;
}

/** A line that turned out not to stand (a hire refunded): kept, and left out of every sum. */
export function voidEntry(businessId: string, kind: LedgerKind, ref: string): boolean {
  return getDb().prepare("UPDATE business_ledger SET voided_at = ? WHERE business_id = ? AND kind = ? AND ref = ? AND voided_at IS NULL").run(new Date().toISOString(), businessId, kind, ref).changes === 1;
}

export function hasEntry(businessId: string, kind: LedgerKind, ref: string): boolean {
  return Boolean(getDb().prepare("SELECT 1 FROM business_ledger WHERE business_id = ? AND kind = ? AND ref = ?").get(businessId, kind, ref));
}

const sum = (sql: string, ...args: unknown[]): bigint =>
  (getDb().prepare(sql).all(...args) as { amount_wei: string }[]).reduce((n, r) => n + BigInt(r.amount_wei), 0n);

/**
 * What the business has paid out of money that is real: hires and material, the lines its limits are kept against.
 * Model costs are left out (Axon pays them); they are in the P&L, not in the budget.
 */
export function paidOut(businessId: string, o: { day?: string; jobRef?: string } = {}): bigint {
  return sum(
    `SELECT amount_wei FROM business_ledger WHERE business_id = ? AND kind IN ('hire', 'material') AND voided_at IS NULL
     ${o.day ? "AND day = ?" : ""} ${o.jobRef ? "AND job_ref = ?" : ""}`,
    businessId, ...(o.day ? [o.day] : []), ...(o.jobRef ? [o.jobRef] : []),
  );
}

export function entriesOf(businessId: string, o: { sinceDay?: string; limit?: number } = {}): LedgerEntry[] {
  return (getDb().prepare(
    `SELECT * FROM business_ledger WHERE business_id = ? ${o.sinceDay ? "AND day >= ?" : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(businessId, ...(o.sinceDay ? [o.sinceDay] : []), o.limit ?? 500) as Record<string, unknown>[]).map((r) => ({
    entryId: String(r.entry_id), direction: r.direction === "in" ? "in" : "out", kind: String(r.kind) as LedgerKind, amountWei: BigInt(String(r.amount_wei)),
    costUsd: r.cost_usd === null || r.cost_usd === undefined ? null : Number(r.cost_usd), ref: String(r.ref), jobRef: r.job_ref ? String(r.job_ref) : null,
    note: r.note ? String(r.note) : null, day: String(r.day), voided: Boolean(r.voided_at), createdAt: String(r.created_at),
  }));
}

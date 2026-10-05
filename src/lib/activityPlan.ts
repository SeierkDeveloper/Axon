// How many network-activity tasks a run starts.
//
// The job runs every hour. Each UTC day has a total and a spread over its 24 hours, both derived from the date. A run
// starts what is due by the end of the current hour less what has already run that day, so a missed run is made up
// over the following ones, a bounded number at a time.

import { createHmac } from "node:crypto";
import { getDb } from "./db";

/** A day's total falls in this range, both ends included. */
export const DAILY_TASKS = { min: 70, max: 180 } as const;
/** The most one run starts: each task is a real inference, and the whole batch has to fit the route's time budget. */
export const MAX_PER_RUN = 14;

const seedOf = (env: Record<string, string | undefined>) => env.NETWORK_ACTIVITY_SEED?.trim() || env.SEED_SECRET?.trim() || "axon-network-activity";
const draw = (seed: string, label: string): number => createHmac("sha256", `axon-activity-plan:${seed}`).update(label).digest().readUInt32BE(0) / 0x1_0000_0000;

/** The UTC day a moment falls on, as YYYY-MM-DD. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** How many tasks a day is to see. */
export function dailyTarget(day: string, env: Record<string, string | undefined> = process.env): number {
  return DAILY_TASKS.min + Math.floor(draw(seedOf(env), `total:${day}`) * (DAILY_TASKS.max - DAILY_TASKS.min + 1));
}

/** How the day's tasks are spread over its 24 hours: a weight an hour, each between 0.4 and 1.6. */
export function hourWeights(day: string, env: Record<string, string | undefined> = process.env): number[] {
  const seed = seedOf(env);
  return Array.from({ length: 24 }, (_, h) => 0.4 + draw(seed, `hour:${day}:${h}`) * 1.2);
}

/** How many tasks should have run by the end of the hour `at` falls in. */
export function dueBy(at: Date, env: Record<string, string | undefined> = process.env): number {
  const day = dayOf(at), w = hourWeights(day, env);
  const all = w.reduce((s, x) => s + x, 0);
  const sofar = w.slice(0, at.getUTCHours() + 1).reduce((s, x) => s + x, 0);
  return Math.round((dailyTarget(day, env) * sofar) / all);
}

/** How many tasks this run starts, given how many have already run today. */
export function planBatch(at: Date, doneToday: number, env: Record<string, string | undefined> = process.env): number {
  return Math.max(0, Math.min(MAX_PER_RUN, dueBy(at, env) - doneToday));
}

/** Network-activity tasks started so far on the UTC day `at` falls on. */
export function activityToday(at: Date): number {
  const start = `${dayOf(at)}T00:00:00.000Z`;
  return (getDb().prepare(`SELECT COUNT(*) n FROM tasks WHERE created_at >= ? AND context LIKE '%"source":"axon-network-activity"%'`).get(start) as { n: number }).n;
}

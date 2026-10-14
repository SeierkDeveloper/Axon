// Autonomy 3, "reacts in minutes": what Autonomy 2 does once an hour, done within minutes of it happening.
//
// Autonomy 2's hourly pass takes failing agents out of routing and frees work that stopped moving. An agent that
// starts failing at five past the hour kept getting work for fifty-five minutes. Now, on every tick (every few
// minutes, from Autonomy 3's own timer in the worker), the same two checks run and the same actions follow, through
// the same code, within the same caps:
//   - an agent failing (its last day of work, or three failures in a row) leaves routing while it is re-tested; the
//     hourly pass re-tests it and puts it back, as before. Many at once is read as an outage and nobody is paused
//   - a job stuck running or never picked up is put back in the queue or closed and refunded, and a closed one is then
//     moved to another agent by "no job dies"
// Autonomy 2's own switch still holds: with AUTONOMY_ACTIONS=off nothing is changed here either. A tick that finds
// nothing records nothing.

import { failingAgents, unreachableAgents, stuckTasks, type Finding } from "./networkChecks";
import { pauseFailing } from "./autonomyActions";
import { freeStuckTasks } from "./autonomyUpkeep";
import { actionsEnabled } from "./autonomyPolicy";
import { partOn } from "./autonomy3Policy";
import { startJob, finishJob, onTick, type TickContext } from "./autonomy3";

type Env = Record<string, string | undefined>;

/** How often Autonomy 3's timer ticks. */
export const TICK_MINUTES = 3;

export async function react(nowMs = Date.now(), env: Env = process.env): Promise<Finding[]> {
  if (!partOn("react", env) || !actionsEnabled(env)) return [];
  const failing = [...unreachableAgents(), ...failingAgents(nowMs)];
  const done = [...pauseFailing(failing, nowMs), ...freeStuckTasks(stuckTasks(nowMs))];
  if (!done.length) return [];
  const id = startJob("react", null, nowMs);
  if (id) {
    const paused = done.filter((f) => f.kind === "agent-paused").length, freed = done.filter((f) => f.kind === "task-freed").length;
    const outage = done.find((f) => f.kind === "outage");
    const parts = [paused && `took ${paused} failing agent${paused === 1 ? "" : "s"} out of routing`, freed && `freed ${freed} stuck job${freed === 1 ? "" : "s"}`, outage && outage.what].filter(Boolean);
    finishJob(id, { outcome: outage ? "outage" : "acted", summary: parts.join("; "), detail: { done } }, nowMs);
  }
  return done;
}

onTick("react", async ({ nowMs, env }: TickContext) => { await react(nowMs, env); });

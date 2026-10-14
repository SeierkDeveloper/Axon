// Autonomy 3, "tries changes on yesterday's jobs": before a change goes in, it is run against what really happened.
//
// Nothing is run again. Yesterday's jobs are in the record: who hired whom, what failed and when, what was answered.
// This part replays that record through Autonomy's rules, which costs nothing:
//   - replayDay: what the rules would have done on a day. Which failed jobs "no job dies" would have moved (and why
//     the others not), how many minutes earlier "reacts in minutes" would have taken failing agents out of routing
//     than the hourly pass did, and how many jobs sat stuck long enough to be freed
//   - compareRules: the same day under today's rules and under proposed ones, side by side, with a verdict: a change
//     that would have taken more than ROUTING_PAUSE's share of agents out at once, or moved more jobs than the day's
//     ceiling, is not safe
//   - replaySet: an agent's recorded real jobs with the answers it gave, so a new version of an agent (the next part,
//     "makes agents better") is judged on real work against answers it already gave, without hiring it again
// Once a day, soon after midnight, yesterday is replayed under today's rules and recorded, for the admin page.

import { getDb } from "./db";
import { getAgentById } from "./agents";
import { getTaskById } from "./tasks";
import { whyNotRescue, pickRescuer, RESCUE } from "./autonomy3Rescue";
import { FAILING, ROUTING_PAUSE, STUCK } from "./autonomyPolicy";
import { TICK_MINUTES } from "./autonomy3React";
import { partOn } from "./autonomy3Policy";
import { startJob, finishJob, recentJobs, onTick, type TickContext } from "./autonomy3";

type Env = Record<string, string | undefined>;
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The rules a replay can be run under. Today's when nothing is said. */
export interface Rules {
  rescue: { perAgentPerDay: number; perDay: number; sharedSkills: number };
  failing: { minFinished: number; maxSuccessRate: number; consecutiveFailures: number };
}
export const TODAY: Rules = {
  rescue: { perAgentPerDay: RESCUE.perAgentPerDay, perDay: RESCUE.perDay, sharedSkills: RESCUE.sharedSkills },
  failing: { minFinished: FAILING.minFinished, maxSuccessRate: FAILING.maxSuccessRate, consecutiveFailures: FAILING.consecutiveFailures },
};
export const withRules = (p: { rescue?: Partial<Rules["rescue"]>; failing?: Partial<Rules["failing"]> } = {}): Rules => ({
  rescue: { ...TODAY.rescue, ...p.rescue },
  failing: { ...TODAY.failing, ...p.failing },
});

export interface ReplayReport {
  day: string;
  jobs: number;
  failed: number;
  rescue: { wouldMove: number; notMoved: Record<string, number>; to: Record<string, number> };
  react: { agents: number; minutesEarlier: number; caught: { agentId: string; at: string; hourlyAt: string }[] };
  stuck: number;
}

type Row = { task_id: string; to_agent: string; status: string; created_at: string; completed_at: string | null; started_at: string | null };

/** The next run of Autonomy 2's hourly pass after a moment: it runs at half past each hour. */
const nextHalfPast = (ms: number) => { const h = Math.floor(ms / HOUR) * HOUR + HOUR / 2; return h > ms ? h : h + HOUR; };

/** What the rules would have done on the UTC day that starts at `dayStartMs`. Reads the record; changes nothing. */
export function replayDay(dayStartMs: number, rules: Rules = TODAY): ReplayReport {
  const from = new Date(dayStartMs).toISOString(), to = new Date(dayStartMs + DAY).toISOString();
  const db = getDb();
  const rows = db.prepare("SELECT task_id, to_agent, status, created_at, completed_at, started_at FROM tasks WHERE created_at >= ? AND created_at < ? ORDER BY created_at").all(from, to) as Row[];
  const report: ReplayReport = { day: from.slice(0, 10), jobs: rows.length, failed: 0, rescue: { wouldMove: 0, notMoved: {}, to: {} }, react: { agents: 0, minutesEarlier: 0, caught: [] }, stuck: 0 };
  const not = (why: string) => { report.rescue.notMoved[why] = (report.rescue.notMoved[why] ?? 0) + 1; };

  // no job dies: every failure of the day in the order it happened, with the day's ceilings
  const movedOf = new Map<string, number>();
  for (const r of rows.filter((x) => x.status === "failed").sort((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""))) {
    report.failed++;
    const task = getTaskById(r.task_id);
    if (!task) continue;
    const ended = Date.parse(task.completedAt ?? task.createdAt);
    const why = whyNotRescue(task, ended);
    if (why) { not(why); continue; }
    if (report.rescue.wouldMove >= rules.rescue.perDay) { not("today's moves were used"); continue; }
    if ((movedOf.get(task.toAgent) ?? 0) >= rules.rescue.perAgentPerDay) { not("this agent's moves for the day were used"); continue; }
    const failed = getAgentById(task.toAgent);
    const rescuer = failed ? pickRescuer(failed, task.fromAgent, rules.rescue.sharedSkills) : null;
    if (!rescuer) { not("no agent could take it"); continue; }
    report.rescue.wouldMove++;
    movedOf.set(task.toAgent, (movedOf.get(task.toAgent) ?? 0) + 1);
    report.rescue.to[rescuer.agentId] = (report.rescue.to[rescuer.agentId] ?? 0) + 1;
  }

  // reacts in minutes: when each agent first counted as failing that day, the reaction a tick later against the hourly pass
  const byAgent = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.completed_at && (x.status === "completed" || x.status === "failed"))) (byAgent.get(r.to_agent) ?? byAgent.set(r.to_agent, []).get(r.to_agent)!).push(r);
  for (const [agentId, done] of byAgent) {
    done.sort((a, b) => a.completed_at!.localeCompare(b.completed_at!));
    let ok = 0, inARow = 0;
    for (let i = 0; i < done.length; i++) {
      if (done[i].status === "completed") { ok++; inARow = 0; } else inARow++;
      const finished = i + 1;
      const failing = inARow >= rules.failing.consecutiveFailures || (finished >= rules.failing.minFinished && ok / finished <= rules.failing.maxSuccessRate);
      if (failing) {
        const at = Date.parse(done[i].completed_at!);
        const reactAt = at + TICK_MINUTES * 60_000, hourlyAt = nextHalfPast(at);
        report.react.agents++;
        report.react.minutesEarlier += Math.max(0, Math.round((hourlyAt - reactAt) / 60_000));
        report.react.caught.push({ agentId, at: new Date(reactAt).toISOString(), hourlyAt: new Date(hourlyAt).toISOString() });
        break;
      }
    }
  }

  // work that stopped moving: long enough in the queue, or running, to be freed
  report.stuck = rows.filter((r) => {
    const end = r.completed_at ? Date.parse(r.completed_at) : dayStartMs + DAY;
    if (r.started_at) return end - Date.parse(r.started_at) > STUCK.runningMinutes * 60_000 && r.status !== "completed";
    return end - Date.parse(r.created_at) > STUCK.queuedMinutes * 60_000 && r.status !== "completed";
  }).length;
  return report;
}

export interface Comparison { day: string; today: ReplayReport; proposed: ReplayReport; safe: boolean; why: string[] }

/** A day under today's rules and under proposed ones. Not safe: more agents out at once than routing allows, or more moves than the day's ceiling. */
export function compareRules(dayStartMs: number, proposed: Rules): Comparison {
  const today = replayDay(dayStartMs, TODAY), next = replayDay(dayStartMs, proposed);
  const agents = (getDb().prepare("SELECT COUNT(*) n FROM agents WHERE agent_id NOT LIKE 'build-%'").get() as { n: number }).n;
  const why: string[] = [];
  if (next.react.agents > Math.max(1, Math.floor(agents * ROUTING_PAUSE.maxShareOfActive))) why.push(`it would have taken ${next.react.agents} of ${agents} agents out of routing in one day`);
  if (next.rescue.wouldMove > TODAY.rescue.perDay) why.push(`it would have moved ${next.rescue.wouldMove} jobs, over the ${TODAY.rescue.perDay} a day the network pays for`);
  return { day: today.day, today, proposed: next, safe: why.length === 0, why };
}

export interface RecordedJob { taskId: string; task: string; answer: string; completedAt: string }

/** An agent's recorded real jobs, newest first: hires by people, finished, with no files, and what it answered. */
export function replaySet(agentId: string, nowMs = Date.now(), hours = 72, limit = 8): RecordedJob[] {
  try {
    const rows = getDb().prepare(`
      SELECT t.task_id, t.task, t.output, t.completed_at, t.context FROM tasks t
      WHERE t.to_agent = ? AND t.status = 'completed' AND t.completed_at >= ? AND t.output IS NOT NULL AND t.workflow_id IS NULL AND t.quorum_id IS NULL
        AND t.from_agent NOT IN (SELECT agent_id FROM agents)
        AND NOT EXISTS (SELECT 1 FROM task_files f WHERE f.task_id = t.task_id AND f.direction = 'in')
      ORDER BY t.completed_at DESC LIMIT ?`).all(agentId, new Date(nowMs - hours * HOUR).toISOString(), limit * 3) as { task_id: string; task: string; output: string; completed_at: string; context: string | null }[];
    return rows
      .filter((r) => { try { const c = JSON.parse(r.context ?? "{}") as Record<string, unknown>; return !c.automated && !c.source; } catch { return true; } })
      .slice(0, limit)
      .map((r) => ({ taskId: r.task_id, task: r.task.slice(0, 4_000), answer: r.output.slice(0, 6_000), completedAt: r.completed_at }));
  } catch {
    return [];
  }
}

/** Once a day, soon after midnight UTC: yesterday under today's rules, recorded. */
export function replayYesterday(nowMs = Date.now(), env: Env = process.env): ReplayReport | null {
  if (!partOn("replay", env)) return null;
  const today = Math.floor(nowMs / DAY) * DAY;
  const last = recentJobs(1, "replay")[0];
  if (last && Date.parse(last.startedAt) >= today) return null;
  const id = startJob("replay", new Date(today - DAY).toISOString().slice(0, 10), nowMs);
  if (!id) return null;
  const r = replayDay(today - DAY);
  finishJob(id, {
    outcome: "replayed",
    summary: `${r.day}: ${r.jobs} jobs, ${r.failed} failed. ${r.rescue.wouldMove} would have been moved to another agent; ${r.react.agents} failing agent${r.react.agents === 1 ? "" : "s"} caught ${r.react.minutesEarlier} min earlier in all; ${r.stuck} stuck`,
    detail: r,
  }, Date.now());
  return r;
}

onTick("replay", async ({ nowMs, env }: TickContext) => { replayYesterday(nowMs, env); });

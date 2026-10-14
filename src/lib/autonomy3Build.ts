// Autonomy 3, "builds the agents that are missing": the network makes the agent nobody offers yet.
//
// One build every other day (JOBS_A_DAY.build, 0.5). The gap it builds for comes from the record:
//   - skills people asked for in open jobs that at most one agent offers (the demand Autonomy 2 reports as a gap)
//   - skills of agents whose failed jobs "no job dies" could move to nobody
// offered by nobody first, then the most asked for, and never one tried in the last GAPS.retryDays. The build is Agent Studio's own: a draft written
// from one sentence, test rounds with a grader, rewrites where it scored low. It is listed only if its best round reaches
// Studio's bar (MIN_PUBLISH_SCORE); otherwise it stays a draft and the record says why. A listed agent is owned by the
// network's builder wallet (AUTONOMY3_BUILDER_WALLET), which its earnings go to, and is then tested and attacked before
// any other agent (phases 4 and 5 put the newest first). Without that wallet set, nothing is built.

import { getDb } from "./db";
import { startDraft, getBuild } from "./studioDraft";
import { runBuild } from "./studioTest";
import { publishBuild } from "./studioPublish";
import { MIN_PUBLISH_SCORE } from "./studioPolicy";
import { captureModelStep } from "./modelUsage";
import { estimateCostUsd } from "./traceEvents";
import { normalizeAddress } from "./address";
import { partOn } from "./autonomy3Policy";
import { startJob, finishJob, mayStart, onTick, type TickContext } from "./autonomy3";

type Env = Record<string, string | undefined>;

export const GAPS = {
  /** a skill offered by at most this many agents is missing */
  thinSupply: 1,
  /** a gap tried once is not tried again for this long, listed or not */
  retryDays: 30,
} as const;

const NAME = /^[a-z][a-z0-9]*(?:[ _-][a-z0-9]+)*$/;

/** The wallet the network builds with, or null when none is set. */
export const builderWallet = (env: Env = process.env): string | null => normalizeAddress(env.AUTONOMY3_BUILDER_WALLET ?? "")?.toLowerCase() ?? null;

/** The missing skills: offered by nobody before offered by one, then the most asked for first. */
export function missingSkills(nowMs = Date.now()): { skill: string; asks: number; offered: number }[] {
  const db = getDb();
  const supply = new Map<string, number>();
  for (const r of db.prepare("SELECT LOWER(capability) c, COUNT(*) n FROM agent_capabilities GROUP BY LOWER(capability)").all() as { c: string; n: number }[]) supply.set(r.c, r.n);
  const demand = new Map<string, number>();
  const ask = (raw: unknown) => { const k = String(raw ?? "").trim().toLowerCase(); if (NAME.test(k) && k.length <= 40) demand.set(k, (demand.get(k) ?? 0) + 1); };
  try {
    for (const r of db.prepare("SELECT capabilities FROM open_tasks WHERE capabilities IS NOT NULL").all() as { capabilities: string }[]) {
      let caps: unknown;
      try { caps = JSON.parse(r.capabilities); } catch { caps = r.capabilities.split(","); }
      for (const c of Array.isArray(caps) ? caps : [caps]) ask(c);
    }
  } catch { /* no open jobs table */ }
  try {
    for (const r of db.prepare("SELECT json_extract(j.detail, '$.from') agent FROM autonomy3_jobs j WHERE j.part = 'rescue' AND json_extract(j.detail, '$.reason') = 'no-agent'").all() as { agent: string | null }[]) {
      const caps = r.agent ? (db.prepare("SELECT capability FROM agent_capabilities WHERE agent_id = ?").all(r.agent) as { capability: string }[]) : [];
      for (const c of caps) ask(c.capability);
    }
  } catch { /* before Autonomy 3's record */ }
  const tried = new Set((db.prepare("SELECT subject FROM autonomy3_jobs WHERE part = 'build' AND started_at >= ?").all(new Date(nowMs - GAPS.retryDays * 86_400_000).toISOString()) as { subject: string }[]).map((r) => r.subject));
  return [...demand]
    .map(([skill, asks]) => ({ skill, asks, offered: supply.get(skill) ?? 0 }))
    .filter((g) => g.offered <= GAPS.thinSupply && !tried.has(g.skill))
    .sort((a, b) => a.offered - b.offered || b.asks - a.asks || a.skill.localeCompare(b.skill));
}

export const sentenceFor = (skill: string) => `An agent for ${skill}: it takes the jobs people post on Axon that ask for ${skill} and hands back the finished work, clear and ready to use.`;

export interface BuildOutcome { skill: string; outcome: "listed" | "not-listed" | "not-started" | "error"; agentId?: string; score?: number | null; summary: string }

export interface BuildDeps { writer?: Parameters<typeof startDraft>[2]; models?: Parameters<typeof runBuild>[1] }

/** Build one agent for a missing skill, recorded as a job. */
export async function buildFor(skill: string, nowMs = Date.now(), env: Env = process.env, deps: BuildDeps = {}): Promise<BuildOutcome | null> {
  const wallet = builderWallet(env);
  if (!wallet) return null;
  const id = startJob("build", skill, nowMs);
  if (!id) return null;
  let cost = 0;
  const spent = (s: { model?: string; inputTokens: number; outputTokens: number }) => { cost += estimateCostUsd(s.model, s.inputTokens, s.outputTokens) ?? 0; };
  const close = (o: BuildOutcome, detail: Record<string, unknown>) => { finishJob(id, { outcome: o.outcome, summary: o.summary, detail, costUsd: Math.round(cost * 1e6) / 1e6 }, Date.now()); return o; };
  try {
    const d = await captureModelStep(() => startDraft(wallet, sentenceFor(skill), deps.writer));
    spent(d);
    const build = d.result;
    if (typeof build === "string") return close({ skill, outcome: "not-started", summary: `No agent for "${skill}": ${build}` }, { reason: build });
    if (build.status !== "drafted") return close({ skill, outcome: "not-started", summary: `No agent for "${skill}": the draft ${build.status}` }, { buildId: build.id, reason: build.error });
    const t = await captureModelStep(() => runBuild(build.id, deps.models));
    spent(t);
    const done = getBuild(build.id);
    const score = done?.score ?? null;
    if (!done || score === null || score < MIN_PUBLISH_SCORE) {
      return close({ skill, outcome: "not-listed", score, summary: `Built an agent for "${skill}"; it scored ${score ?? "?"}/10, under the ${MIN_PUBLISH_SCORE} needed, so it stays a draft` }, { buildId: build.id, status: t.result, score });
    }
    const listed = publishBuild(build.id, wallet);
    if (typeof listed === "string") return close({ skill, outcome: "not-listed", score, summary: `Built an agent for "${skill}" (${score}/10) but it could not be listed: ${listed}` }, { buildId: build.id, reason: listed, score });
    return close({ skill, outcome: "listed", agentId: listed.agentId, score, summary: `Built and listed ${done.draft?.name ?? listed.agentId} for "${skill}", ${score}/10 in its tests` }, { buildId: build.id, agentId: listed.agentId, score });
  } catch (err) {
    return close({ skill, outcome: "error", summary: `Building an agent for "${skill}" failed` }, { reason: err instanceof Error ? err.message : String(err) });
  }
}

/** On a tick: one build when it is the part's turn, for the most asked-for missing skill. */
export async function buildTurn(nowMs = Date.now(), env: Env = process.env, deps: BuildDeps = {}): Promise<BuildOutcome | null> {
  if (!partOn("build", env) || !builderWallet(env) || !mayStart("build", nowMs, env)) return null;
  const [gap] = missingSkills(nowMs);
  return gap ? buildFor(gap.skill, nowMs, env, deps) : null;
}

onTick("build", async ({ nowMs, env }: TickContext) => { await buildTurn(nowMs, env); });

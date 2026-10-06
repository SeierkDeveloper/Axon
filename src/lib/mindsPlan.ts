// Agent Minds 2: the plan a mind works to.
//
// A mind that only reacts to the last event has no direction. Here it writes one down: a mission in a sentence, a
// goal it can be measured against, how it means to divide its treasury between buybacks, rewards, burning $AXON and a
// reserve, and a floor of ETH it will not spend below. It writes the plan itself, in the same answer as a thought,
// and may revise it, but not on a whim: a plan stands for hours at least. Holders read it on the token's page.
//
// A plan is the mind's own intention, so most of it binds nothing. One part does: the reserve floor is enforced by
// the rule check, which refuses any proposal that would take the treasury below it. A plan can never widen what a
// mind may do or raise a limit: those were locked in its treasury's contract at launch.

import { getDb } from "./db";
import { CAN } from "./mindsLaunch";
import { validateAgentText } from "./agentContent";

export type GoalKind = "holders" | "market_cap_eth" | "burned_tokens" | "graduate";
export interface Plan {
  mission: string;
  goal: { kind: GoalKind; target: number | null } | null;
  /** percent of what it spends, adding up to 100 */
  split: { buyback: number; reward: number; burnAxon: number; reserve: number };
  /** ETH it keeps in its treasury whatever happens; the rule check enforces it */
  reserveEth: number;
  thesis: string | null;
}
export interface StoredPlan extends Plan { setAt: string; revisions: number; thoughtId: number | null }

/** A plan stands at least this long before its mind may rewrite it. */
export const PLAN_MIN_MS = 6 * 3_600_000;
export const PLAN_LIMITS = { missionChars: 160, thesisChars: 240, maxReserveEth: 1000 } as const;
const GOALS: readonly GoalKind[] = ["holders", "market_cap_eth", "burned_tokens", "graduate"];

/** A sentence a mind wrote, made safe to show: plain punctuation, a sane length, nothing a public page should not carry. */
function sentence(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  let text = v.replace(/\s+/g, " ").replace(/\s*—\s*/g, ", ").replace(/–/g, "-").trim();
  if (text.length > max) { const cut = text.slice(0, max); text = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20))}…`; }
  return text.length < 8 || validateAgentText(text) ? null : text;
}
const number = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : NaN);

/**
 * Read the plan out of a mind's answer, or null when there is none that can be used. A share for something the mind
 * was never allowed to do is moved to the reserve, and the four shares are brought to exactly 100.
 */
export function readPlan(raw: unknown, c: { allowed: number; attached?: boolean }): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const mission = sentence(r.mission, PLAN_LIMITS.missionChars);
  if (!mission) return null;

  const s = (r.split && typeof r.split === "object" ? r.split : {}) as Record<string, unknown>;
  const share = (v: unknown) => { const n = number(v); return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0; };
  let buyback = c.allowed & CAN.buyback ? share(s.buyback) : 0;
  let reward = c.allowed & CAN.reward && !c.attached ? share(s.reward) : 0;
  let burnAxon = c.allowed & CAN.burnAxon ? share(s.burn_axon ?? s.burnAxon) : 0;
  const spend = buyback + reward + burnAxon;
  // more than everything was promised to spending: scale the three down to fit, keeping their proportions
  if (spend > 100) { buyback = (buyback / spend) * 100; reward = (reward / spend) * 100; burnAxon = (burnAxon / spend) * 100; }
  buyback = Math.round(buyback); reward = Math.round(reward); burnAxon = Math.round(burnAxon);
  const reserve = Math.max(0, 100 - buyback - reward - burnAxon);
  // rounding can leave the three a point over: the largest gives it up
  const over = buyback + reward + burnAxon + reserve - 100;
  if (over > 0) { if (buyback >= reward && buyback >= burnAxon) buyback -= over; else if (reward >= burnAxon) reward -= over; else burnAxon -= over; }

  const g = (r.goal && typeof r.goal === "object" ? r.goal : null) as Record<string, unknown> | null;
  const kind = g ? (String(g.kind ?? "").toLowerCase().replace(/[\s-]+/g, "_") as GoalKind) : null;
  const target = g ? number(g.target) : NaN;
  const goal = kind && GOALS.includes(kind) ? (kind === "graduate" ? { kind, target: null } : Number.isFinite(target) && target > 0 ? { kind, target } : null) : null;

  const floor = number(r.reserve_eth ?? r.reserveEth);
  return {
    mission, goal, split: { buyback, reward, burnAxon, reserve },
    reserveEth: Number.isFinite(floor) && floor > 0 ? Math.min(PLAN_LIMITS.maxReserveEth, +floor.toFixed(9)) : 0,
    thesis: sentence(r.thesis, PLAN_LIMITS.thesisChars),
  };
}

interface Row { plan: string; reserve_eth: number; thought_id: number | null; set_at: string; revisions: number }

/** The plan a token's mind is working to, or null when it has not written one. */
export function planOf(token: string): StoredPlan | null {
  const r = getDb().prepare("SELECT plan, reserve_eth, thought_id, set_at, revisions FROM mind_plans WHERE token = ?").get(token.toLowerCase()) as Row | undefined;
  if (!r) return null;
  try { return { ...(JSON.parse(r.plan) as Plan), reserveEth: r.reserve_eth, setAt: r.set_at, revisions: r.revisions, thoughtId: r.thought_id }; } catch { return null; }
}

/** The floor a token's mind keeps, in ETH: 0 without a plan. What the rule check is given. */
export const reserveOf = (token: string): number => (getDb().prepare("SELECT reserve_eth v FROM mind_plans WHERE token = ?").get(token.toLowerCase()) as { v: number } | undefined)?.v ?? 0;


/**
 * Keep a plan a mind wrote. The first one is always taken. A later one is taken only once the standing plan has
 * stood for PLAN_MIN_MS, or at once when its goal has been reached (`reached`): a mind with nothing left to aim at
 * should not have to wait. The same plan written again changes nothing.
 */
export function savePlan(token: string, plan: Plan, thoughtId: number | null, o: { now?: number; reached?: boolean } = {}): "set" | "revised" | "same" | "too_soon" {
  const db = getDb(), t = token.toLowerCase(), now = o.now ?? Date.now(), at = new Date(now).toISOString();
  const was = planOf(t), json = JSON.stringify(plan);
  if (was) {
    const { setAt: _a, revisions: _r, thoughtId: _t, ...old } = was;
    void _a; void _r; void _t;
    if (JSON.stringify(old) === json) return "same";
    if (!o.reached && now - Date.parse(was.setAt) < PLAN_MIN_MS) return "too_soon";
  }
  db.transaction(() => {
    db.prepare("INSERT INTO mind_plans (token, plan, reserve_eth, thought_id, set_at, revisions) VALUES (?,?,?,?,?,0) ON CONFLICT(token) DO UPDATE SET plan = excluded.plan, reserve_eth = excluded.reserve_eth, thought_id = excluded.thought_id, set_at = excluded.set_at, revisions = mind_plans.revisions + 1")
      .run(t, json, plan.reserveEth, thoughtId, at);
    db.prepare("INSERT INTO mind_plan_log (token, plan, thought_id, at) VALUES (?,?,?,?)").run(t, json, thoughtId, at);
  })();
  return was ? "revised" : "set";
}

/** Every version of a token's plan, newest first. */
export function planLog(token: string, limit = 10): { plan: Plan; at: string }[] {
  return (getDb().prepare("SELECT plan, at FROM mind_plan_log WHERE token = ? ORDER BY id DESC LIMIT ?").all(token.toLowerCase(), Math.min(50, Math.max(1, limit))) as { plan: string; at: string }[])
    .map((r) => ({ plan: JSON.parse(r.plan) as Plan, at: r.at }));
}

export interface Numbers { holders: number; mcapEth: number | null; burnedTokens: number; curveBps: number; phase: number }
export interface Progress { now: number | null; target: number | null; percent: number | null; reached: boolean }

/** How far along its goal a token is, from its own numbers. Null for a plan without a goal. */
export function progressOf(plan: Pick<Plan, "goal">, n: Numbers): Progress | null {
  if (!plan.goal) return null;
  if (plan.goal.kind === "graduate") { const done = n.phase >= 2; return { now: done ? 100 : Math.floor(n.curveBps / 100), target: 100, percent: done ? 100 : Math.floor(n.curveBps / 100), reached: done }; }
  const now = plan.goal.kind === "holders" ? n.holders : plan.goal.kind === "market_cap_eth" ? n.mcapEth : n.burnedTokens;
  const target = plan.goal.target!;
  if (now === null) return { now: null, target, percent: null, reached: false };
  return { now, target, percent: Math.min(100, Math.floor((now / target) * 100)), reached: now >= target };
}

const GOAL_WORDS: Record<GoalKind, (target: number | null) => string> = {
  holders: (t) => `${t} holders`, market_cap_eth: (t) => `a market cap of ${t} ETH`, burned_tokens: (t) => `${Math.round(t ?? 0).toLocaleString("en-US")} tokens burned`, graduate: () => "graduating to its pool",
};
/** A goal in plain words, as the page and the mind's own prompt say it. */
export const goalText = (g: NonNullable<Plan["goal"]>): string => GOAL_WORDS[g.kind](g.target);

const left = (ms: number): string => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const ago = (iso: string, now: number): string => { const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.floor(m / 60)} h ${m % 60} min ago` : `${Math.floor(m / 1440)} days ago`; };

/**
 * The plan as its mind reads it before it thinks: what it wrote, how far along the goal is, how it has really spent
 * so far next to how it said it would, and whether it may rewrite the plan yet.
 */
export function planLines(plan: StoredPlan | null, n: Numbers, spent: { buybackEth: number; rewardEth: number; burnAxonEth: number }, now = Date.now()): string[] {
  if (!plan) return ["your_plan: none yet. Write your first one in this answer (see \"plan\" below)."];
  const p = progressOf(plan, n);
  const total = spent.buybackEth + spent.rewardEth + spent.burnAxonEth;
  const part = (v: number) => (total > 0 ? `${Math.round((v / total) * 100)}%` : "0%");
  const free = now >= Date.parse(plan.setAt) + PLAN_MIN_MS;
  return [
    `your_plan (written ${ago(plan.setAt, now)}${plan.revisions ? `, revised ${plan.revisions} time${plan.revisions === 1 ? "" : "s"}` : ""}):`,
    `  mission: ${plan.mission}`,
    `  goal: ${plan.goal ? `${goalText(plan.goal)}${p ? (p.reached ? " (REACHED: set your next goal in this answer)" : p.now === null ? "" : ` (now ${plan.goal.kind === "graduate" ? `${p.percent}% of the way` : `${+Number(p.now).toPrecision(4)}, ${p.percent}% of the way`})`) : ""}` : "none set"}`,
    `  split: buybacks ${plan.split.buyback}%, rewards ${plan.split.reward}%, $AXON burn ${plan.split.burnAxon}%, reserve ${plan.split.reserve}%`,
    `  reserve_floor_eth: ${plan.reserveEth} (the rule check refuses anything that would take the treasury below it)`,
    ...(plan.thesis ? [`  thesis: ${plan.thesis}`] : []),
    `  spent_so_far: ${total > 0 ? `buybacks ${+spent.buybackEth.toPrecision(3)} ETH (${part(spent.buybackEth)}), rewards ${+spent.rewardEth.toPrecision(3)} ETH (${part(spent.rewardEth)}), $AXON burn ${+spent.burnAxonEth.toPrecision(3)} ETH (${part(spent.burnAxonEth)})` : "nothing yet"}`,
    `  you_may_rewrite_it: ${p?.reached ? "yes, your goal is reached" : free ? "yes, if something has really changed" : `not for another ${left(Date.parse(plan.setAt) + PLAN_MIN_MS - now)}`}`,
  ];
}

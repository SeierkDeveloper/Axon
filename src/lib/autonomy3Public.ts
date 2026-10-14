// Autonomy 3 on the public page: counts only. Which agent, job or page a part worked on, and anything about money,
// stays on the admin page (autonomy3State). The public sees, part by part, whether it is on and how much it did in
// the last 24 hours and since it started, in the words of what the part does.

import { getDb } from "./db";
import { PARTS, PART_ORDER, autonomy3On, partOn, jobsADay, type Part } from "./autonomy3Policy";

type Env = Record<string, string | undefined>;

/** One number a part is known by, and the outcomes that count towards it. */
interface Measure { label: string; outcomes: string[] | null }

// What each part's jobs mean in plain words. `null` outcomes = every finished job of the part.
const MEASURES: Record<Part, { main: Measure; more: Measure[] }> = {
  rescue: { main: { label: "Failed jobs moved to another agent", outcomes: ["moved"] }, more: [] },
  watch: { main: { label: "Looks at pages, triggers and browsers", outcomes: null }, more: [{ label: "with something to fix", outcomes: ["found"] }] },
  react: { main: { label: "Times it stepped in within minutes", outcomes: ["acted"] }, more: [] },
  test: { main: { label: "Agents tested", outcomes: ["passed", "weak", "failed"] }, more: [{ label: "passed", outcomes: ["passed"] }, { label: "taken out of routing", outcomes: ["failed"] }] },
  attack: { main: { label: "Attacks on its own agents", outcomes: ["held", "fell"] }, more: [{ label: "held", outcomes: ["held"] }, { label: "fell and were pulled", outcomes: ["fell"] }] },
  replay: { main: { label: "Days of real jobs replayed", outcomes: ["replayed"] }, more: [] },
  improve: { main: { label: "Improvements tried", outcomes: ["kept", "not-better"] }, more: [{ label: "kept, proven better", outcomes: ["kept"] }] },
  build: { main: { label: "New agents built and listed", outcomes: ["listed"] }, more: [{ label: "built and not good enough to list", outcomes: ["not-listed"] }] },
  upkeep: { main: { label: "Chores done by Axon agents", outcomes: ["done"] }, more: [] },
  judge: { main: { label: "Jobs done by two agents and judged", outcomes: ["hired-won", "second-won"] }, more: [{ label: "the second agent's was better", outcomes: ["second-won"] }] },
  budget: { main: { label: "Chores paid from its own budget", outcomes: ["paid"] }, more: [] },
};

export interface PublicCount { label: string; day: number; all: number }
export interface PublicPart { part: Part; name: string; does: string; on: boolean; aDay: number | null; main: PublicCount; more: PublicCount[]; lastAt: string | null }
export interface Autonomy3Public { on: boolean; parts: PublicPart[]; jobsDay: number; jobsAll: number; since: string | null }

export function autonomy3Public(nowMs = Date.now(), env: Env = process.env): Autonomy3Public {
  const dayAgo = new Date(nowMs - 86_400_000).toISOString();
  const day = new Map<string, number>(), all = new Map<string, number>(), last = new Map<string, string>();
  let since: string | null = null;
  try {
    const db = getDb();
    for (const r of db.prepare("SELECT part, outcome, COUNT(*) n FROM autonomy3_jobs WHERE finished_at IS NOT NULL AND started_at >= ? GROUP BY part, outcome").all(dayAgo) as { part: string; outcome: string | null; n: number }[]) day.set(`${r.part} ${r.outcome}`, r.n);
    for (const r of db.prepare("SELECT part, outcome, COUNT(*) n FROM autonomy3_jobs WHERE finished_at IS NOT NULL GROUP BY part, outcome").all() as { part: string; outcome: string | null; n: number }[]) all.set(`${r.part} ${r.outcome}`, r.n);
    for (const r of db.prepare("SELECT part, MAX(finished_at) at FROM autonomy3_jobs WHERE finished_at IS NOT NULL GROUP BY part").all() as { part: string; at: string }[]) last.set(r.part, r.at);
    since = (db.prepare("SELECT MIN(started_at) at FROM autonomy3_jobs").get() as { at: string | null }).at;
  } catch { /* before migration 126: nothing to count */ }

  const sum = (m: Map<string, number>, part: Part, outcomes: string[] | null) => {
    let n = 0;
    for (const [k, v] of m) { const [p, o] = k.split(" "); if (p === part && (outcomes === null || outcomes.includes(o))) n += v; }
    return n;
  };
  const count = (part: Part, m: Measure): PublicCount => ({ label: m.label, day: sum(day, part, m.outcomes), all: sum(all, part, m.outcomes) });

  const parts = PART_ORDER.map((part): PublicPart => ({
    part, name: PARTS[part].name, does: PARTS[part].does, on: partOn(part, env), aDay: jobsADay(part, env),
    main: count(part, MEASURES[part].main), more: MEASURES[part].more.map((m) => count(part, m)), lastAt: last.get(part) ?? null,
  }));
  return { on: autonomy3On(env), parts, jobsDay: [...day.values()].reduce((a, b) => a + b, 0), jobsAll: [...all.values()].reduce((a, b) => a + b, 0), since };
}

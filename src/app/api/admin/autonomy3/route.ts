import { NextRequest, NextResponse } from "next/server";
import { autonomy3State } from "@/lib/autonomy3";
import { testAgent, testQueue } from "@/lib/autonomy3Test";
import { attackAgent, attackQueue, KINDS, type AttackKind } from "@/lib/autonomy3Attack";
import { compareRules, withRules, type Rules } from "@/lib/autonomy3Replay";
import { improveAgent3, setAutoImprove } from "@/lib/autonomy3Improve";
import { buildFor, missingSkills, builderWallet } from "@/lib/autonomy3Build";
import { autonomy3On } from "@/lib/autonomy3Policy";
import "@/lib/autonomy3Parts";

export const runtime = "nodejs";

// GET /api/admin/autonomy3: Autonomy 3 in full, for the admin only. Which parts are on, how many of the day's jobs
// each has started, what today cost, and the latest jobs with what they found.
//
// Admin-gated on the same secret the crons use, like the other admin routes.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(autonomy3State(), { headers: { "Cache-Control": "no-store" } });
}

// POST /api/admin/autonomy3 { "test": "<agent id>" | "next" } or { "attack": ... }: test or attack one agent now, outside the day's number. For the
// admin checking an agent, or the tests themselves, without switching the daily tests on. Needs AUTONOMY3=on. Each one
// is a real model call or three, a cent or two.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!autonomy3On()) return NextResponse.json({ error: "Autonomy 3 is off (AUTONOMY3)" }, { status: 409 });
  const body = (await req.json().catch(() => ({}))) as { build?: string; improve?: string; optIn?: boolean; test?: string; attack?: string; kind?: string; replay?: { day?: string; rescue?: Partial<Rules["rescue"]>; failing?: Partial<Rules["failing"]> } };
  // { "replay": { "day"?: "YYYY-MM-DD", "rescue"?: {...}, "failing"?: {...} } }: a recorded day under today's rules and the
  // proposed ones, side by side. Costs nothing: no job is run again. Yesterday when no day is given.
  if (body.replay) {
    const day = body.replay.day && /^\d{4}-\d{2}-\d{2}$/.test(body.replay.day) ? Date.parse(`${body.replay.day}T00:00:00Z`) : Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
    return NextResponse.json(compareRules(day, withRules({ rescue: body.replay.rescue, failing: body.replay.failing })));
  }
  // { "build": "<skill>" | "next" }: build an agent for a missing skill now (needs AUTONOMY3_BUILDER_WALLET). A Studio
  // build: a writer call and test rounds, about 10 to 30 cents. { "build": "gaps" } lists the missing skills, free.
  if (body.build) {
    if (body.build === "gaps") return NextResponse.json({ wallet: builderWallet(), gaps: missingSkills().slice(0, 20) });
    if (!builderWallet()) return NextResponse.json({ error: "AUTONOMY3_BUILDER_WALLET is not set" }, { status: 409 });
    const skill = body.build === "next" ? missingSkills()[0]?.skill : body.build.trim().toLowerCase();
    const done = skill ? await buildFor(skill) : null;
    return done ? NextResponse.json(done) : NextResponse.json({ error: "No missing skill to build for" }, { status: 404 });
  }
  // { "improve": "<agent id>", "optIn"?: true }: one improvement attempt now (for Axon's own agents the admin may switch
  // it on for the agent with optIn). A writer call and a few answers and grades: about ten cents.
  if (body.improve) {
    if (body.optIn === true) setAutoImprove(body.improve, true);
    const done = await improveAgent3(body.improve);
    return done ? NextResponse.json(done) : NextResponse.json({ error: `No agent '${body.improve}' with instructions to improve` }, { status: 404 });
  }
  // { "attack": "<agent id>" | "next", "kind"?: "hidden" | "exfil" | "authority" | "leak" }: attack one agent now
  if (body.attack) {
    const target = body.attack === "next" ? attackQueue(Date.now(), 1)[0] : body.attack;
    const kind = KINDS.includes(body.kind as AttackKind) ? (body.kind as AttackKind) : undefined;
    const done = target ? await attackAgent(target, Date.now(), process.env, undefined, kind) : null;
    return done ? NextResponse.json(done) : NextResponse.json({ error: `No agent '${target ?? ""}' to attack` }, { status: 404 });
  }
  const agentId = body.test === "next" ? testQueue(1)[0] : body.test;
  if (!agentId) return NextResponse.json({ error: 'Send { "test": "<agent id>" } or { "test": "next" }' }, { status: 400 });
  const result = await testAgent(agentId);
  return result ? NextResponse.json(result) : NextResponse.json({ error: `No agent '${agentId}', or the test could not be recorded` }, { status: 404 });
}

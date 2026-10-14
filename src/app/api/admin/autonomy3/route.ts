import { NextRequest, NextResponse } from "next/server";
import { autonomy3State } from "@/lib/autonomy3";
import { testAgent, testQueue } from "@/lib/autonomy3Test";
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

// POST /api/admin/autonomy3 { "test": "<agent id>" | "next" }: test one agent now, outside the day's number. For the
// admin checking an agent, or the tests themselves, without switching the daily tests on. Needs AUTONOMY3=on. Each one
// is a real model call or three, a cent or two.
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!autonomy3On()) return NextResponse.json({ error: "Autonomy 3 is off (AUTONOMY3)" }, { status: 409 });
  const body = (await req.json().catch(() => ({}))) as { test?: string };
  const agentId = body.test === "next" ? testQueue(1)[0] : body.test;
  if (!agentId) return NextResponse.json({ error: 'Send { "test": "<agent id>" } or { "test": "next" }' }, { status: 400 });
  const result = await testAgent(agentId);
  return result ? NextResponse.json(result) : NextResponse.json({ error: `No agent '${agentId}', or the test could not be recorded` }, { status: 404 });
}

// POST /api/cron/autonomy
//
// Tier 3: the pass over the live network, every hour. Checks the whole network, acts within the caps in
// autonomyPolicy, and re-prices only the agents whose owners opted in.
//
// Railway cron: POST https://axon-agents.com/api/cron/autonomy, hourly at :30.
// GET is public and returns counts only (publicSummary, publicDay); the full record is /api/admin/autonomy.

import { NextRequest, NextResponse } from "next/server";
import { runFullNetworkPass, getLatestNetworkRun, getNetworkRunsSince, publicSummary, publicDay } from "@/lib/autonomyNetwork";
import { noteCronRun } from "@/lib/cronRuns";

export const runtime = "nodejs";

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  noteCronRun("autonomy");
  const run = await runFullNetworkPass({ apply: true });
  return NextResponse.json({
    runId: run.runId,
    agentsSeen: run.agentsSeen,
    observations: run.observations.length,
    checksUnavailable: run.checksUnavailable,
    changed: run.changes.length,
  });
}

// The last pass and the last day, as counts. Reads the record only: a public request never starts a pass.
export async function GET() {
  const latest = getLatestNetworkRun();
  return NextResponse.json(
    { latest: latest ? publicSummary(latest) : null, day: publicDay(getNetworkRunsSince(24)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

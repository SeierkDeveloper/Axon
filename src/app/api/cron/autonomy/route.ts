// POST /api/cron/autonomy
//
// Tier 3: the pass over the live network. Observes the marketplace and applies
// price self-optimization to the agents whose owners opted in — and to no others.
//
// Railway cron: POST https://axon-agents.com/api/cron/autonomy, daily.
// GET runs the same pass without writing, so the result can be read before the
// pass is trusted to act.

import { NextRequest, NextResponse } from "next/server";
import { runNetworkPass, runFullNetworkPass, getLatestNetworkRun, publicView } from "@/lib/autonomyNetwork";
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
    changes: run.changes,
  });
}

// A dry pass, and the last recorded one. Public, so it shows only what autonomyPolicy marks public: the
// checks behind it (money, listings, agents' health) are read in full at /api/admin/autonomy.
export async function GET() {
  const preview = publicView(runNetworkPass({ apply: false }));
  const latest = getLatestNetworkRun();
  return NextResponse.json(
    { preview, latest: latest ? publicView(latest) : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

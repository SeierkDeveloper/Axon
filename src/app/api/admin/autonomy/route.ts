import { NextRequest, NextResponse } from "next/server";
import { getLatestNetworkRun, getNetworkRunsSince, runFullNetworkPass } from "@/lib/autonomyNetwork";

export const runtime = "nodejs";

// GET /api/admin/autonomy: the network pass in full, for the admin only. The latest recorded run with every
// finding and the last day of passes; ?fresh=1 adds a dry run of every check (it loads the main pages, so it is
// opt-in). Public pages show counts only.
//
// Admin-gated on the same secret the crons use, like the other admin routes.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const fresh = req.nextUrl.searchParams.get("fresh") === "1" ? await runFullNetworkPass({ apply: false }) : undefined;
  return NextResponse.json(
    { latest: getLatestNetworkRun(), day: getNetworkRunsSince(24), ...(fresh ? { fresh } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

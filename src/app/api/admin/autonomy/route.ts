import { NextRequest, NextResponse } from "next/server";
import { getLatestNetworkRun, runFullNetworkPass } from "@/lib/autonomyNetwork";

export const runtime = "nodejs";

// GET /api/admin/autonomy: the network pass in full, for the admin only. The latest recorded run with every
// finding, and a fresh dry run of every check. Public pages show only what autonomyPolicy marks public.
//
// Admin-gated on the same secret the crons use, like the other admin routes.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const fresh = await runFullNetworkPass({ apply: false });
  return NextResponse.json({ latest: getLatestNetworkRun(), fresh }, { headers: { "Cache-Control": "no-store" } });
}

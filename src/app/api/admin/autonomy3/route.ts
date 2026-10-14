import { NextRequest, NextResponse } from "next/server";
import { autonomy3State } from "@/lib/autonomy3";
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

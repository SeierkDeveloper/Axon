// POST /api/cron/autonomy3
//
// The tick of Autonomy 3, every few minutes: each part that is switched on gets its go (lib/autonomy3.ts). With
// AUTONOMY3 off, which is how it ships, a tick does nothing and says so.
//
// Nothing here is public: GET is not served. The record is /api/admin/autonomy3.

import { NextRequest, NextResponse } from "next/server";
import { tick } from "@/lib/autonomy3";
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
  const result = await tick();
  if (result.on) noteCronRun("autonomy3", result.failed.length ? `failed: ${result.failed.map((f) => f.part).join(", ")}` : undefined);
  return NextResponse.json(result);
}

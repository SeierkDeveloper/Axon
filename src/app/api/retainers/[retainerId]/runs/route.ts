// GET /api/retainers/:id/runs?limit=20&before=<scheduledFor>
// Newest first. A completed run carries the agent's output and its receipt; any other carries why.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { listRetainerRuns } from "@/lib/retainers";
import { visibleRetainer, notFound, runView } from "@/lib/retainerApi";

export async function GET(req: NextRequest, { params }: { params: Promise<{ retainerId: string }> }) {
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  const r = visibleRetainer(auth.user, (await params).retainerId);
  if (!r) return notFound();
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 20;
  const before = req.nextUrl.searchParams.get("before") ?? undefined;
  const runs = listRetainerRuns(r.retainerId, r.ownerWallet, { limit, before }).map(runView);
  return NextResponse.json({ runs, nextBefore: runs.length === Math.min(100, Math.max(1, limit)) ? runs[runs.length - 1]!.scheduledFor : null });
}

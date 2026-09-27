// POST /api/retainers/:id/pause
// Stops new runs until resumed. A run already working finishes.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { pauseRetainer } from "@/lib/retainers";
import { visibleRetainer, notFound, retainerView, retainerErrorResponse } from "@/lib/retainerApi";

export async function POST(req: NextRequest, { params }: { params: Promise<{ retainerId: string }> }) {
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  const r = visibleRetainer(auth.user, (await params).retainerId);
  if (!r) return notFound();
  try {
    return NextResponse.json({ retainer: retainerView(pauseRetainer(r.retainerId, auth.user.walletAddress)) });
  } catch (err) {
    return retainerErrorResponse(err);
  }
}

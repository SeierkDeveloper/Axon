// POST /api/retainers/:id/resume
// Carries on from the next slot; nothing that fell due while paused is made up. Clears a pause the
// retainer put itself in once the cause is fixed.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { resumeRetainer } from "@/lib/retainers";
import { visibleRetainer, notFound, retainerView, retainerErrorResponse } from "@/lib/retainerApi";

export async function POST(req: NextRequest, { params }: { params: Promise<{ retainerId: string }> }) {
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  const r = visibleRetainer(auth.user, (await params).retainerId);
  if (!r) return notFound();
  try {
    return NextResponse.json({ retainer: retainerView(resumeRetainer(r.retainerId, auth.user.walletAddress)) });
  } catch (err) {
    return retainerErrorResponse(err);
  }
}

// GET    /api/retainers/:id: the retainer, with its latest result and webhook status
// PATCH  /api/retainers/:id: change its instructions, schedule, price ceiling, end or pay-in
// DELETE /api/retainers/:id: cancel it for good (its history stays readable)

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { editRetainer, cancelRetainer } from "@/lib/retainers";
import { readEdit, visibleRetainer, notFound, retainerView, retainerErrorResponse } from "@/lib/retainerApi";

type Ctx = { params: Promise<{ retainerId: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  const r = visibleRetainer(auth.user, (await params).retainerId);
  if (!r) return notFound();
  return NextResponse.json({ retainer: retainerView(r, { withLatest: true }) });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req, { allowAllowanceScope: true });
    if (!auth.ok) return auth.response;
    const r = visibleRetainer(auth.user, (await params).retainerId);
    if (!r) return notFound();
    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    const parsed = readEdit(raw as Record<string, unknown>);
    if (!parsed.ok) return parsed.response;
    try {
      return NextResponse.json({ retainer: retainerView(await editRetainer(r.retainerId, auth.user.walletAddress, parsed.value)) });
    } catch (err) {
      return retainerErrorResponse(err);
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  const r = visibleRetainer(auth.user, (await params).retainerId);
  if (!r) return notFound();
  try {
    return NextResponse.json({ retainer: retainerView(cancelRetainer(r.retainerId, auth.user.walletAddress)) });
  } catch (err) {
    return retainerErrorResponse(err);
  }
}

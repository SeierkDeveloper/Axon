// GET  /api/retainers: this wallet's retainers (an allowance key sees only those it created) and its tier's limits
// POST /api/retainers: create one. An allowance key may, and its limits then apply to every run.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { createRetainer, listRetainers } from "@/lib/retainers";
import { readCreate, keyCreateError, retainerView, retainerErrorResponse, retainerLimits } from "@/lib/retainerApi";

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req, { allowAllowanceScope: true });
  if (!auth.ok) return auth.response;
  const all = listRetainers(auth.user.walletAddress);
  const mine = auth.user.scope === "allowance" ? all.filter((r) => r.apiKeyId === auth.user.keyId) : all;
  return NextResponse.json({ retainers: mine.map((r) => retainerView(r)), limits: await retainerLimits(auth.user.walletAddress) });
}

export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req, { allowAllowanceScope: true });
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`retainers-create:${auth.user.walletAddress}`, 10, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const raw = await req.json().catch(() => null);
    if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    const parsed = readCreate(raw as Record<string, unknown>);
    if (!parsed.ok) return parsed.response;
    const keyError = keyCreateError(auth.user, parsed.value);
    if (keyError) return apiError("FORBIDDEN", keyError, 403);

    try {
      const r = await createRetainer(auth.user.walletAddress, parsed.value, {
        apiKeyId: auth.user.scope === "allowance" ? auth.user.keyId : null,
      });
      return NextResponse.json({ retainer: retainerView(r) }, { status: 201 });
    } catch (err) {
      return retainerErrorResponse(err);
    }
  });
}

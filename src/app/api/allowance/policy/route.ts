// GET    /api/allowance/policy: the outside policy provider this wallet has linked, and its latest answers
// PUT    /api/allowance/policy: link one. { provider, apiKey, objectiveId }. The provider's key is stored encrypted.
// DELETE /api/allowance/policy: remove the link
//
// All three need a full key. An allowance key is what a policy check is there to watch, so it can neither see the
// check nor take it off.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { policyChecksEnabled, policyProviders, policyLinkOf, recentPolicyChecks, linkPolicy, unlinkPolicy, PolicyLinkError, POLICY_TIMEOUT_MS } from "@/lib/policyCheck";

export const runtime = "nodejs";

const view = (wallet: string) => ({
  enabled: true as const,
  providers: policyProviders(),
  timeoutMs: POLICY_TIMEOUT_MS,
  link: policyLinkOf(wallet),
  recent: recentPolicyChecks(wallet, 10),
});

export async function GET(req: NextRequest) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  if (!policyChecksEnabled()) return NextResponse.json({ enabled: false });
  return NextResponse.json(view(auth.user.walletAddress), { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`allowance-policy:${auth.user.walletAddress}`, 5, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);

    const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    try {
      await linkPolicy(auth.user.walletAddress, raw);
    } catch (err) {
      if (err instanceof PolicyLinkError) return apiError(err.status === 503 ? "UPSTREAM_ERROR" : "VALIDATION_ERROR", err.message, err.status);
      throw err;
    }
    return NextResponse.json(view(auth.user.walletAddress), { headers: { "Cache-Control": "no-store" } });
  });
}

export async function DELETE(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    unlinkPolicy(auth.user.walletAddress);
    if (!policyChecksEnabled()) return NextResponse.json({ enabled: false });
    return NextResponse.json(view(auth.user.walletAddress), { headers: { "Cache-Control": "no-store" } });
  });
}

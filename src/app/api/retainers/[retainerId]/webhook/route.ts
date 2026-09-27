// PUT    /api/retainers/:id/webhook { url }: send this retainer's results there. Returns the signing
//        secret once; it is never shown again.
// DELETE /api/retainers/:id/webhook: stop sending.
//
// Full key only: a leaked assistant key must not be able to send a retainer's results elsewhere.

import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/apiAuth";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { setRetainerWebhook, retainerWebhookStatus } from "@/lib/retainerWebhooks";
import { visibleRetainer, notFound, retainerErrorResponse } from "@/lib/retainerApi";

type Ctx = { params: Promise<{ retainerId: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const r = visibleRetainer(auth.user, (await params).retainerId);
    if (!r) return notFound();
    const rl = checkRateLimit(`retainer-webhook:${auth.user.walletAddress}`, 10, 60_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const raw = (await req.json().catch(() => null)) as { url?: unknown } | null;
    if (!raw || typeof raw.url !== "string" || !raw.url) return apiError("VALIDATION_ERROR", "url is required", 400);
    try {
      const { secret } = await setRetainerWebhook(r.retainerId, auth.user.walletAddress, raw.url);
      return NextResponse.json({ webhook: retainerWebhookStatus(r.retainerId), secret });
    } catch (err) {
      return retainerErrorResponse(err);
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const r = visibleRetainer(auth.user, (await params).retainerId);
  if (!r) return notFound();
  await setRetainerWebhook(r.retainerId, auth.user.walletAddress, null);
  return NextResponse.json({ webhook: null });
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { authenticateApiKey } from "@/lib/identity";
import { PRODUCT_REPORT_REASONS, getProduct, reportProduct, shopEnabled } from "@/lib/agentShop";
import { checkRateLimit, getClientIp, rateLimitHeaders, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const LIMIT = 5, WINDOW_MS = 60 * 60 * 1000;

// POST /api/shop/products/:productId/report { reason, details? }: somebody says a product should not be sold. Anybody
// may, a few times an hour; it counts against the product's page the way a report of a built page does, and enough
// different people take the page and the product down at once. Signed in, it also goes to the moderators' queue
// against the agent. "not_delivered" needs a sign-in.
export async function POST(req: NextRequest, { params }: { params: Promise<{ productId: string }> }) {
  const { productId } = await params;
  if (!shopEnabled()) return apiError("NOT_FOUND", "Not found", 404);
  const ip = getClientIp(req);
  const rl = checkRateLimit(`shop-report:${ip}`, LIMIT, WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);
  if (!getProduct(productId)) return apiError("NOT_FOUND", "There is no such product", 404);
  const body = (await req.json().catch(() => null)) as { reason?: unknown; details?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason : "";
  if (!(PRODUCT_REPORT_REASONS as readonly string[]).includes(reason)) return apiError("VALIDATION_ERROR", `reason must be one of ${PRODUCT_REPORT_REASONS.join(", ")}`, 400);
  const wallet = authenticateApiKey(req)?.walletAddress ?? null;
  const r = reportProduct(productId, { reason, details: typeof body?.details === "string" ? body.details : undefined, reporter: wallet ? `wallet:${wallet.toLowerCase()}` : `ip:${ip}`, wallet });
  if (!r.ok) return apiError("AUTH_REQUIRED", r.why ?? "That report could not be taken", 401);
  return NextResponse.json({ ok: true, hidden: r.hidden, filed: r.filed }, { headers: rateLimitHeaders(rl, LIMIT) });
}

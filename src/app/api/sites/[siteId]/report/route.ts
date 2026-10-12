import { NextRequest, NextResponse } from "next/server";
import { getSite, reportSite, REPORT_REASONS, sitesEnabled } from "@/lib/agentSites";
import { apiError } from "@/lib/apiError";
import { checkRateLimit, getClientIp, rateLimitHeaders, tooManyRequests } from "@/lib/rateLimit";

export const runtime = "nodejs";

const LIMIT = 5, WINDOW_MS = 60 * 60 * 1000;

// POST /api/sites/<site>/report { reason, details? }: somebody says a built page should not be up. Anybody may,
// without signing in, a few times an hour. One person counts once for a page; when enough different people have
// reported it, it is hidden at once (src/lib/agentSites.ts) and the answer says so.
export async function POST(req: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  if (!sitesEnabled()) return apiError("NOT_FOUND", "Not found", 404);
  const ip = getClientIp(req);
  const rl = checkRateLimit(`site-report:${ip}`, LIMIT, WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);
  if (!getSite(siteId)) return apiError("NOT_FOUND", "There is no such page", 404);
  const body = (await req.json().catch(() => null)) as { reason?: unknown; details?: unknown } | null;
  const reason = typeof body?.reason === "string" ? body.reason : "";
  if (!(REPORT_REASONS as readonly string[]).includes(reason)) return apiError("VALIDATION_ERROR", `reason must be one of ${REPORT_REASONS.join(", ")}`, 400);
  const r = reportSite(siteId, { reason, details: typeof body?.details === "string" ? body.details : undefined, reporter: `ip:${ip}` });
  return NextResponse.json({ ok: true, hidden: r.hidden }, { headers: rateLimitHeaders(rl, LIMIT) });
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { logger } from "@/lib/logger";
import { checkRateLimit, getClientIp, rateLimitHeaders, tooManyRequests } from "@/lib/rateLimit";
import { checkAnswer, formsEnabled, keepAnswer } from "@/lib/siteAnswers";

export const runtime = "nodejs";

/** One visitor sends a page a few answers, and all pages together not many more. */
const PER_PAGE = 5, PAGE_WINDOW_MS = 10 * 60 * 1000, PER_HOUR = 30, HOUR_MS = 60 * 60 * 1000;
const MAX_BODY = 40_000;

// POST /api/sites/<site>/answers { form, fields: [[name, value], ...], v? }: a visitor sends what they filled in on
// a built page's form. The page itself cannot send anything: the page that holds it (the viewer) posts this, after
// the visitor has seen what goes and said yes. Anybody may, without signing in, a few times in ten minutes. What is
// kept is read only by whoever had the page built.
export async function POST(req: NextRequest, { params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  if (!formsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
  // from the viewer page only: a page of another site may not post here in a visitor's name
  const origin = req.headers.get("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { /* not an address: refused below */ }
    if (host !== (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "")) return apiError("FORBIDDEN", "Answers are sent from the page itself", 403);
  }
  const ip = getClientIp(req);
  const hour = checkRateLimit(`site-answer:${ip}`, PER_HOUR, HOUR_MS);
  if (!hour.allowed) return tooManyRequests(hour);
  const rl = checkRateLimit(`site-answer:${siteId}:${ip}`, PER_PAGE, PAGE_WINDOW_MS);
  if (!rl.allowed) return tooManyRequests(rl);
  const text = await req.text().catch(() => "");
  if (text.length > MAX_BODY) return apiError("VALIDATION_ERROR", "That is too much for one answer. Shorten it and send again.", 400);
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* refused by the check below */ }
  const checked = checkAnswer(body);
  if (!checked.ok) return apiError("VALIDATION_ERROR", checked.why, 400);
  const v = (body as { v?: unknown } | null)?.v;
  const kept = keepAnswer(siteId, checked, { sender: `ip:${ip}`, version: typeof v === "number" ? v : undefined });
  if (!kept.ok) return apiError(kept.status === 404 ? "NOT_FOUND" : "TASK_STATE_CONFLICT", kept.why, kept.status);
  logger.info("sites.answer", "A built page's form was answered", { siteId, form: checked.form, fields: checked.fields.length, bytes: checked.bytes });
  return NextResponse.json({ ok: true }, { headers: rateLimitHeaders(rl, PER_PAGE) });
}

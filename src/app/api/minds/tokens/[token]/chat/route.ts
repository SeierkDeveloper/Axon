import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { getBearerToken } from "@/lib/identity";
import { checkRateLimit, getClientIp, refundRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { askMind, chatEnabled, cleanQuestion, listChats, mindKnown, ANON_PER_DAY_PER_MIND, CHAT_PER_MINUTE, QUESTION_CHARS } from "@/lib/mindsChat";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";

const CODE = { 400: "VALIDATION_ERROR", 404: "NOT_FOUND", 409: "CONFLICT", 502: "UPSTREAM_ERROR", 503: "UPSTREAM_ERROR" } as const;
const DAY_MS = 86_400_000;

// GET /api/minds/tokens/:token/chat: the last 50 questions asked of a token's mind on its page, and its answers. Public; an
// asker's wallet is only ever shown shortened. The token is its address.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled() || !chatEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const token = normalizeAddress((await params).token);
    if (!token) return apiError("VALIDATION_ERROR", "Not a token address", 400);
    if (!mindKnown(token)) return apiError("NOT_FOUND", "No token with a mind at that address", 404);
    return NextResponse.json({ chats: listChats(token), maxChars: QUESTION_CHARS }, { headers: { "Cache-Control": "public, max-age=5" } });
  });
}

// POST /api/minds/tokens/:token/chat: ask a token's mind a question and get its answer in its own voice. Anyone may ask; a
// signed-in wallet is named (shortened) beside its question. A question never changes what the mind does, and the
// mind's own treasury pays for the answer.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled() || !chatEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    // who asks: the wallet behind the key the site's wallet sign-in hands out, when one is sent; otherwise a visitor.
    // A key that is sent and does not work is refused rather than quietly treated as nobody.
    let wallet: string | null = null;
    if (getBearerToken(req)) {
      const auth = requireApiKey(req);
      if (!auth.ok) return auth.response;
      wallet = normalizeAddress(auth.user.walletAddress);
    }
    const token = normalizeAddress((await params).token);
    if (!token) return apiError("VALIDATION_ERROR", "Not a token address", 400);
    const body = (await req.json().catch(() => null)) as { question?: unknown } | null;
    if (!body || typeof body !== "object") return apiError("VALIDATION_ERROR", 'Send the question as JSON: {"question": "..."}', 400);
    const q = cleanQuestion(body.question);
    if (!q.ok) return apiError("VALIDATION_ERROR", q.reason, 400);
    if (!mindKnown(token)) return apiError("NOT_FOUND", "No token with a mind at that address", 404);

    // five questions a minute from any one wallet, or from any one address when nobody is signed in
    const minute = checkRateLimit(`minds-chat:${wallet ? `w:${wallet}` : `ip:${getClientIp(req)}`}`, CHAT_PER_MINUTE, 60_000);
    if (!minute.allowed) return tooManyRequests(minute);
    // and a day's share of a mind's answers for visitors who are not signed in, so nobody can spend its treasury anonymously
    const dayKey = `minds-chat:anon:${token}`;
    if (!wallet) {
      const day = checkRateLimit(dayKey, ANON_PER_DAY_PER_MIND, DAY_MS);
      if (!day.allowed) {
        return apiError("RATE_LIMITED", "This mind has answered all the questions it takes today from visitors who are not signed in. Sign in with a wallet to ask.", 429, { resetAt: day.resetAt }, { headers: { "Retry-After": String(Math.ceil((day.resetAt - Date.now()) / 1000)) } });
      }
    }

    const r = await askMind({ mindId: token, wallet, question: q.text });
    if (!r.ok) {
      // a refusal that cost the mind nothing does not use up a visitor's share of its day
      if (!wallet && !r.charged) refundRateLimit(dayKey);
      return apiError(CODE[r.status], r.reason, r.status, { refused: r.refused });
    }
    return NextResponse.json({ chat: r.chat }, { headers: { "Cache-Control": "no-store" } });
  });
}

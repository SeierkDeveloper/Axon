import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { createTrigger, fireUrl, reachedAt, listTriggers, triggerJson, triggersEnabled, TriggerError, MAX_TRIGGERS, RUNS_PER_DAY, PAGE_EVERY, pageEveryMin, freeRunsPerDay, type CreateInput } from "@/lib/triggers";
import { chainHead } from "@/lib/triggerChain";
import { browserEnabled, checkBrowserUrl } from "@/lib/agentBrowser";
import { validatePublicHttpUrl } from "@/lib/urlSecurity";

export const runtime = "nodejs";

// GET /api/triggers: the caller's triggers, and the limits.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!triggersEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const triggers = listTriggers(auth.user.walletAddress).map((t) => ({ ...triggerJson(t), ...(t.kind === "inbound" ? { url: fireUrl(t.triggerId, reachedAt(req.headers)) } : {}) }));
    return NextResponse.json({ triggers, limits: { triggers: MAX_TRIGGERS, runsPerDay: RUNS_PER_DAY, freeRunsPerDay: freeRunsPerDay(), /* a page can be watched only where agents have a browser */ ...(browserEnabled() ? { page: { everyMinutes: { min: pageEveryMin(), default: Math.max(pageEveryMin(), PAGE_EVERY.default), max: PAGE_EVERY.max } } } : {}) } }, { headers: { "Cache-Control": "no-store" } });
  });
}

// POST /api/triggers: save a job and what starts it. For one that is called, the answer carries its secret, once.
// kind "page" watches a web page: { page: { url, watch?, everyMinutes? } }.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    if (!triggersEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const rl = checkRateLimit(`triggers-create:${auth.user.walletAddress}`, 20, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await req.json().catch(() => null)) as Partial<CreateInput> & { maxPriceEth?: unknown } | null;
    if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    // a page to watch has to be somewhere on the public web: said now, not at the first look
    if (body.kind === "page") {
      const page = body.page && typeof body.page === "object" ? body.page : {};
      const checked = checkBrowserUrl(String(page.url ?? ""));
      const unreachable = checked.ok ? await validatePublicHttpUrl(checked.url) : null;
      if (unreachable) return apiError("VALIDATION_ERROR", /resolved/.test(unreachable) ? "No site answers at that address." : "That address is not on the public web, so it cannot be watched.", 400);
    }
    try {
      const { trigger, secret } = createTrigger({
        ownerWallet: auth.user.walletAddress,
        agentId: String(body.agentId ?? ""),
        name: typeof body.name === "string" ? body.name : undefined,
        kind: body.kind as CreateInput["kind"],
        instructions: String(body.instructions ?? ""),
        maxPriceEth: body.maxPriceEth === undefined || body.maxPriceEth === null ? null : String(body.maxPriceEth),
        payIn: body.payIn === "AXON" ? "AXON" : "ETH",
        maxRunsPerDay: body.maxRunsPerDay,
        reportFile: body.reportFile === true,
        chain: body.chain && typeof body.chain === "object" ? body.chain : undefined,
        page: body.page && typeof body.page === "object" ? body.page : undefined,
        ...(body.kind === "chain" ? { headBlock: (await chainHead()) ?? undefined } : {}),
      });
      return NextResponse.json(
        {
          trigger: { ...triggerJson(trigger), ...(secret ? { url: fireUrl(trigger.triggerId, reachedAt(req.headers)) } : {}) },
          ...(secret ? { secret, note: "Keep the secret: it is shown once. Send it as the X-Trigger-Key header when you call the url." } : {}),
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    } catch (err) {
      if (err instanceof TriggerError) return apiError(err.status === 404 ? "NOT_FOUND" : err.status === 409 ? "CONFLICT" : "VALIDATION_ERROR", err.message, err.status);
      throw err;
    }
  });
}

import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { agentMindsEnabled } from "@/lib/mindsPolicy";
import { liveToken } from "@/lib/mindsIndex";
import { mindStatus } from "@/lib/mindsStatus";
import { goalText, planOf, progressOf } from "@/lib/mindsPlan";
import { ordersOf, promiseRecord, whenText, thenText } from "@/lib/mindsOrders";
import { followedBy, outcomesOf, recordOf } from "@/lib/mindsRecord";
import { reportsOf } from "@/lib/mindsReport";
import { briefChangeAt, briefOf } from "@/lib/mindsBrief";
import { booksOf } from "@/lib/mindsBooks";
import { boardToken } from "@/lib/mindsStats";
import { normalizeAddress } from "@/lib/address";

export const runtime = "nodejs";

// GET /api/minds/tokens/:token: one token with what the chain says right now: its settings, its mind's treasury, what
// its fees have paid out, what its agent has earned from work since the launch, and what its mind is doing or waiting
// for, in a line, so a quiet mind never looks like a broken one.
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  return withRequestContext(req, async () => {
    if (!agentMindsEnabled()) return apiError("NOT_FOUND", "Not found", 404);
    const token = normalizeAddress((await ctx.params).token);
    if (!token) return apiError("VALIDATION_ERROR", "That is not a token address", 400);
    const t = await liveToken(token);
    if (!t) return apiError("NOT_FOUND", "No token with a mind at that address", 404);
    const status = await mindStatus(token, { treasury: t.treasury }).catch(() => null);
    const mind = status ? { state: status.state, text: status.text, actionsToday: status.day?.actionsToday ?? null, actionsAllowed: t.treasury?.limits.maxActionsPerDay ?? null } : null;
    // the plan its mind works to, and how far along its goal the token is
    const standing = planOf(token), b = boardToken(token);
    const plan = standing ? { ...standing, goalText: standing.goal ? goalText(standing.goal) : null, progress: b ? progressOf(standing, { holders: b.holders, mcapEth: b.mcapEth, burnedTokens: b.burnedTokens, curveBps: b.curveBps, phase: b.phase }) : null } : null;
    // its standing orders: the ones armed, then the most recent that fired, lapsed or were cancelled
    const orders = ordersOf(token).map((o) => ({ id: o.id, status: o.status, when: whenText(o.when), then: thenText(o.then), said: o.said, promise: o.promise, createdAt: o.createdAt, expiresAt: o.expiresAt, firedAt: o.firedAt, note: o.note }));
    // its track record: every move carried out, what it was followed by an hour later, and the lesson it wrote
    const record = { summary: recordOf(token), moves: outcomesOf(token, 20).map((o) => ({ ...o, followedBy: followedBy(o) })) };
    // its books: what came in, what it holds, what it spent and on what, what it keeps back, and its runway
    const books = t.treasury && b ? booksOf(token, t.treasury, b.toMindEth) : null;
    const changeAt = briefChangeAt(token);
    return NextResponse.json({ ...t, mind, plan, orders, promises: promiseRecord(token), record, reports: reportsOf(token, 7), brief: briefOf(token), briefCanChangeAt: changeAt ? new Date(changeAt).toISOString() : null, books }, { headers: { "Cache-Control": "public, max-age=10" } });
  });
}

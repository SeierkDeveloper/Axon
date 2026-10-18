import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { withRequestContext } from "@/lib/withRequestContext";
import { checkRateLimit, tooManyRequests } from "@/lib/rateLimit";
import { getDb } from "@/lib/db";
import { getAgentById } from "@/lib/agents";
import { isOwnerVerified } from "@/lib/ownerVerification";
import { getAvailableBalanceWei } from "@/lib/payments";
import { formatEth, PAYMENT_RECEIVER_WALLET_ADDRESS } from "@/lib/money";
import { FAIRNESS, HOLD_STEPS, PEOPLE, PROOF_KINDS, PROOF_WORDS, REPORT_REASONS, RULES, holdLimit, peopleCaps } from "@/lib/peoplePolicy";
import { boardTasks, holding, ownerView, postPeopleTask, publicView, recentlyDone, recordOf, reportedTasks, takerView, tasksOfOwner, tasksOfTaker, topPeople, type PeopleRecord } from "@/lib/people";
import { realRulesJudge } from "@/lib/peopleCheck";
import { callerOf, noStore, signInFirst, walletOf } from "@/lib/peopleHttp";

export const runtime = "nodejs";

const recordView = (r: PeopleRecord) => ({ wallet: r.short, done: r.done, rejected: r.rejected, gaveUp: r.gaveUp, earned: r.earned, since: r.since, last: r.last });

// GET /api/people: the board for people. Open tasks (anyone may read them), what people did lately, the public record
// of the people with the most accepted tasks, and the rules. Signed in, also what you hold or did, your own record and
// how many tasks you may hold; and, for an agent's owner, the tasks their agents posted with every proof and the agents
// they can post for.
export async function GET(req: NextRequest) {
  return withRequestContext(req, async () => {
    const c = callerOf(req);
    if ("response" in c) return c.response;
    const caps = peopleCaps();
    const base = {
      tasks: boardTasks().map(publicView),
      done: recentlyDone().map(publicView),
      record: topPeople().map(recordView),
      rules: RULES, fairness: FAIRNESS,
      limits: {
        minPay: formatEth(caps.minPriceWei), maxPay: formatEth(caps.maxPriceWei), triesPerTaker: PEOPLE.triesPerTaker, reviewHours: caps.reviewHours, holdSteps: HOLD_STEPS,
        takesPerDay: caps.takesPerDay, maxDays: caps.maxDays, checksMax: PEOPLE.checksMax, proofKinds: PROOF_KINDS.map((k) => ({ kind: k, words: PROOF_WORDS[k] })), reportReasons: REPORT_REASONS,
      },
    };
    // a moderator also gets what people reported, with every report, to take down or put back (PATCH /api/people/:taskId)
    if (c.caller.kind === "moderator") return NextResponse.json({ ...base, reported: reportedTasks().map((r) => ({ task: ownerView(r.task), reports: r.reports })) }, { headers: noStore });
    const wallet = walletOf(c.caller);
    if (!wallet) return NextResponse.json(base, { headers: noStore });
    const mine = recordOf(wallet);
    const agents = (getDb().prepare("SELECT agent_id FROM agents WHERE LOWER(wallet_address) = ? ORDER BY created_at DESC LIMIT 50").all(wallet) as { agent_id: string }[])
      .map(({ agent_id }) => getAgentById(agent_id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a))
      .map((a) => ({ agentId: a.agentId, name: a.name, verified: isOwnerVerified(a.agentId), earnings: formatEth(getAvailableBalanceWei(a.agentId) > 0n ? getAvailableBalanceWei(a.agentId) : 0n) }));
    return NextResponse.json({
      ...base,
      me: { record: recordView(mine), holding: holding(wallet), mayHold: holdLimit(mine.done), tasks: tasksOfTaker(wallet).map((t) => takerView(t, wallet)) },
      posted: tasksOfOwner(wallet).map(ownerView),
      agents,
      payTo: PAYMENT_RECEIVER_WALLET_ADDRESS || null,
    }, { headers: noStore });
  });
}

// POST /api/people { agentId, title, details, place?, proof: "photo" | "file" | "answer", checks: [..], priceEth, takeHours?, days?,
// minDone?, funding?: "earnings" | "wallet", paymentTx? }: one of your agents posts a task for people. Checked against the
// rules first; the pay is locked from the agent's earnings, or from a payment you sent to Axon's receiving wallet first.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const c = callerOf(req);
    if ("response" in c) return c.response;
    const wallet = walletOf(c.caller);
    if (!wallet) return signInFirst();
    const rl = checkRateLimit(`people-post:${wallet}`, 30, 3_600_000);
    if (!rl.allowed) return tooManyRequests(rl);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return apiError("INVALID_JSON", "Request body must be valid JSON", 400);
    const r = await postPeopleTask(body, { wallet, postedBy: "owner" }, realRulesJudge());
    if (!r.ok) {
      const map = { off: ["NOT_FOUND", 404], forbidden: ["FORBIDDEN", 403], invalid: ["VALIDATION_ERROR", 400], rules: ["VALIDATION_ERROR", 422], limit: ["RATE_LIMITED", 429], payment: ["PAYMENT_REQUIRED", 402], unavailable: ["UPSTREAM_ERROR", 503] } as const;
      const [code, status] = map[r.code];
      return apiError(code, r.why, status, { refused: r.code });
    }
    return NextResponse.json({ task: ownerView(r.task) }, { status: 201, headers: noStore });
  });
}

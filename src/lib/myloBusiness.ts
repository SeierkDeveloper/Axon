// Agents that run their own business, through Mylo.
//
// A person can ask Mylo to start a business for one of their agents, to see how their businesses are doing, and to
// pause, resume or stop one. Starting one lets an agent spend within limits, so Mylo only writes it down: the card in
// the conversation shows the goal and every limit, and nothing starts until the person taps Start (./myloActions
// proposeBusiness). Mylo never picks a budget or a limit for them. Checking spends nothing; pausing and stopping spend
// nothing and only hold the agent back, so Mylo does them when asked.
//
// Nothing here is offered while AGENT_BUSINESS is off.

import { businessEnabled, openSpendKinds } from "./businessPolicy";
import { businessesOf, getBusiness, pauseBusiness, resumeBusiness, stopBusiness } from "./business";
import { ownerView } from "./businessBooks";
import { controlHooks } from "./businessRun";
import { proposeBusiness, type BusinessLimitsInput } from "./myloActions";

type Input = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

export function myloBusinessTools(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  if (!businessEnabled()) return [];
  return [
    {
      name: "start_business",
      description:
        "Write down one of the person's own agents starting its own business, for them to confirm on a card: it finds work on Axon by itself, bids on what fits the goal, does it, can hire other agents for parts of a job, sell in its shop and reinvest, all inside their limits. " +
        `Needs the agent, the goal in their words, and every limit from them in ETH: the budget in total, the most a day, the most on one job, the amount above which it asks them first, its lowest and highest price a job, and what it may spend on (${openSpendKinds().join(", ")}). Never pick an amount for them: ask for each. Nothing starts until they tap Start.`,
      input_schema: {
        type: "object",
        properties: {
          agent_id: { type: "string" }, goal: { type: "string" },
          budget_eth: { type: "string" }, max_per_day_eth: { type: "string" }, max_per_job_eth: { type: "string" }, ask_above_eth: { type: "string" },
          price_min_eth: { type: "string" }, price_max_eth: { type: "string" },
          spend_on: { type: "array", items: { type: "string", enum: openSpendKinds() } },
          sell_price_eth: { type: "string", description: "Only if they want it to make and sell products in its shop: the price of each" },
        },
        required: ["agent_id", "goal", "budget_eth", "max_per_day_eth", "max_per_job_eth", "ask_above_eth", "price_min_eth", "price_max_eth"],
      },
    },
    { name: "my_businesses", description: "How the person's agents' businesses are doing: running or paused, earned, spent and profit in total and today, jobs done, products sold, what waits for their OK, the latest daily report and the latest decisions with their reasons.", input_schema: { type: "object", properties: {} } },
    { name: "manage_business", description: "Pause, resume or stop one of the person's businesses when they ask. Stopping is for good: what it earned stays the agent's, to withdraw in Studio.", input_schema: { type: "object", properties: { business_id: { type: "string" }, action: { type: "string", enum: ["pause", "resume", "stop"] } }, required: ["business_id", "action"] } },
  ];
}

export const MYLO_BUSINESS_LABELS: Record<string, string> = { start_business: "Preparing the business", my_businesses: "Looking at your businesses", manage_business: "Updating the business" };

export function myloBusinessNote(): string {
  if (!businessEnabled()) return "";
  return `\n\nAgents that run their own business:
- An owner can give one of their agents a goal, a budget and limits. The agent then looks for work on Axon by itself,
  bids on what fits, does it, can hire other agents for parts of a job, sell in its shop and adjust its price and model
  inside the limits. Every decision is logged with its reason, its P&L is on the Dashboard with a daily report.
- start_business only writes it down for them to confirm on a card. Ask for every amount; never choose one. my_businesses
  says how they are doing, using only the numbers it returns. manage_business pauses, resumes or stops one.
- Never present a business as a way to make money or promise what it will earn.`;
}

export function runMyloBusinessTool(name: string, input: Input, ctx: { wallet: string | null; owner: string; conversationId: string }): { result: unknown; actionId?: string } | undefined {
  if (!businessEnabled() || !(name in MYLO_BUSINESS_LABELS)) return undefined;
  if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." } };
  if (name === "start_business") {
    const sell = text(input.sell_price_eth);
    const limits: BusinessLimitsInput = {
      budgetEth: text(input.budget_eth), maxPerDayEth: text(input.max_per_day_eth), maxPerJobEth: text(input.max_per_job_eth), approveAboveEth: text(input.ask_above_eth),
      priceMinEth: text(input.price_min_eth), priceMaxEth: text(input.price_max_eth), spendOn: Array.isArray(input.spend_on) ? input.spend_on.map(String) : [],
      ...(sell ? { sell: { on: true, priceEth: sell } } : {}),
    };
    const p = proposeBusiness(ctx, text(input.agent_id), text(input.goal), limits);
    if (typeof p === "string") return { result: { error: p } };
    return { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. Nothing starts until the person taps Start on the card. Say what you wrote down in a sentence; never say it is running." }, actionId: p.id };
  }
  if (name === "my_businesses") {
    const list = businessesOf(ctx.wallet, 10).map((b) => ownerView(b));
    const today = new Date().toISOString().slice(0, 10);
    return {
      result: {
        businesses: list.map((v) => ({
          business_id: v.businessId, agent: v.agent.name, goal: v.goal, status: v.status, paused_because: v.pausedReason,
          total: { earned: v.pnl.total.earned, spent: v.pnl.total.spent, profit: v.pnl.total.profit },
          today: v.pnl.days.find((d) => d.day === today) ? { earned: v.pnl.days.find((d) => d.day === today)!.earned, spent: v.pnl.days.find((d) => d.day === today)!.spent } : null,
          jobs_done: v.counts.jobsDone, products_sold: v.counts.productsSold, waiting_for_your_ok: v.waiting.map((w) => w.title),
          latest_report: v.reports[0] ? { day: v.reports[0].day, text: v.reports[0].text } : null,
          latest_decisions: v.decisions.slice(0, 5).map((d) => d.reason), budget_left: v.limits.left.budget,
        })),
        dashboard: "/dashboard#business",
        note: list.length ? "Use only these numbers." : "None of their agents runs a business yet.",
      },
    };
  }
  const id = text(input.business_id), act = text(input.action), hooks = controlHooks();
  if (!getBusiness(id)) return { result: { error: "There is no such business of theirs." } };
  const r = act === "pause" ? pauseBusiness(id, ctx.wallet, hooks) : act === "resume" ? resumeBusiness(id, ctx.wallet, hooks) : act === "stop" ? stopBusiness(id, ctx.wallet, hooks) : null;
  if (!r) return { result: { error: "Say pause, resume or stop." } };
  if (!r.ok) return { result: { error: r.why } };
  return { result: { done: act, status: r.business.status } };
}

// Agents that run their own business, inside an assistant (Claude, Cursor, ChatGPT, Grok).
//
// With the owner's Axon key on the connection, an assistant can read how their businesses are doing and pause, resume or
// stop one. Starting one lets an agent spend, so the assistant cannot start it: start_business checks the goal and the
// limits and gives back a link to the owner's dashboard with the form filled in, where the owner starts it themselves.
// Every call goes through the business routes, so the checks are the same ones the site makes.
//
// Nothing is added while AGENT_BUSINESS is off.

import { NextRequest } from "next/server";
import { businessEnabled, openSpendKinds } from "./businessPolicy";
import { mayRun, readLimits } from "./business";
import { authenticateApiKey } from "./identity";
import { siteUrl } from "./myloMcp";
import type { McpTool } from "./mcpServer";

type Args = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

export function businessMcpTools(): McpTool[] {
  if (!businessEnabled()) return [];
  return [
    {
      name: "list_businesses",
      description: "For an agent's owner, with an Axon key on this connection: their agents' businesses. Each one's goal, whether it runs, its P&L in total and by day (earned, spent on hires, material and model costs, profit), jobs done, products sold, what waits for the owner's OK, its daily reports, its limits and what is left of them, and every decision it made with the reason.",
      inputSchema: { type: "object", properties: { businessId: { type: "string", description: "Only this one" } } },
    },
    {
      name: "start_business",
      description:
        "For an agent's owner: prepare one of their agents to run its own business (it finds work on Axon by itself, bids on what fits the goal, does it, can hire other agents, sell in its shop and reinvest inside the limits). " +
        "Checks the goal and every limit and returns a link where the owner starts it on their dashboard; it does not start here. Every amount comes from the owner, in ETH.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" }, goal: { type: "string" }, budgetEth: { type: "string" }, maxPerDayEth: { type: "string" }, maxPerJobEth: { type: "string" },
          approveAboveEth: { type: "string" }, priceMinEth: { type: "string" }, priceMaxEth: { type: "string" }, spendOn: { type: "array", items: { type: "string", enum: openSpendKinds() } },
        },
        required: ["agentId", "goal", "budgetEth", "maxPerDayEth", "maxPerJobEth", "approveAboveEth", "priceMinEth", "priceMaxEth"],
      },
    },
    {
      name: "manage_business",
      description: "For an agent's owner, with an Axon key on this connection: pause, resume or stop one of their businesses. Stopping is for good; what it earned stays the agent's.",
      inputSchema: { type: "object", properties: { businessId: { type: "string" }, action: { type: "string", enum: ["pause", "resume", "stop"] } }, required: ["businessId", "action"] },
    },
  ];
}

async function route(baseUrl: string, load: () => Promise<Record<string, unknown>>, method: string, path: string, params: Record<string, string>, apiKey: string, body?: unknown) {
  const mod = (await load()) as Record<string, (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const req = new NextRequest(`${baseUrl}${path}`, { method, headers: { "content-type": "application/json", "x-api-key": apiKey }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await mod[method](req, { params: Promise.resolve(params) });
  const json = (await res.json()) as Record<string, unknown>;
  return res.ok ? json : { error: typeof json.error === "string" ? json.error : `request failed (${res.status})` };
}

export async function callBusinessTool(name: string, args: Args, apiKey: string | null, baseUrl: string): Promise<unknown | undefined> {
  if (!businessEnabled() || !["list_businesses", "start_business", "manage_business"].includes(name)) return undefined;
  if (!apiKey) return { error: `${name} needs an Axon key in this MCP connection's Authorization header` };
  const all = () => import("@/app/api/business/route") as Promise<Record<string, unknown>>;
  const one = () => import("@/app/api/business/[businessId]/route") as Promise<Record<string, unknown>>;
  if (name === "list_businesses") {
    const id = text(args.businessId);
    return id ? route(baseUrl, one, "GET", `/api/business/${encodeURIComponent(id)}`, { businessId: id }, apiKey) : route(baseUrl, all, "GET", "/api/business", {}, apiKey);
  }
  if (name === "manage_business") {
    const id = text(args.businessId);
    if (!id) return { error: "businessId is required" };
    return route(baseUrl, one, "PATCH", `/api/business/${encodeURIComponent(id)}`, { businessId: id }, apiKey, { action: text(args.action) });
  }
  // start_business: checked here, started by the owner on the page
  const user = authenticateApiKey(new NextRequest(`${baseUrl}/api/business`, { headers: { "x-api-key": apiKey } }));
  if (!user) return { error: "That Axon key is not valid here" };
  const agentId = text(args.agentId), goal = text(args.goal);
  const refused = mayRun(agentId, user.walletAddress);
  if (refused) return { error: refused };
  const read = readLimits({ budgetEth: args.budgetEth, maxPerDayEth: args.maxPerDayEth, maxPerJobEth: args.maxPerJobEth, approveAboveEth: args.approveAboveEth, priceMinEth: args.priceMinEth, priceMaxEth: args.priceMaxEth, spendOn: Array.isArray(args.spendOn) ? args.spendOn : [] });
  if (!read.ok) return { error: read.why };
  if (goal.length < 10) return { error: "Say the goal in a sentence." };
  const q = new URLSearchParams({ business: agentId, goal, budget: text(args.budgetEth), day: text(args.maxPerDayEth), job: text(args.maxPerJobEth), ask: text(args.approveAboveEth), pmin: text(args.priceMinEth), pmax: text(args.priceMaxEth), spend: read.value.limits.kinds.join(",") });
  return {
    confirm: `${siteUrl()}/dashboard?${q}#business`,
    note: "Nothing has started. The owner opens this link, where the form is filled in with this goal and these limits, checks it and taps Start.",
    limits: { budgetEth: text(args.budgetEth), maxPerDayEth: text(args.maxPerDayEth), maxPerJobEth: text(args.maxPerJobEth), approveAboveEth: text(args.approveAboveEth), priceMinEth: text(args.priceMinEth), priceMaxEth: text(args.priceMaxEth), spendOn: read.value.limits.kinds },
  };
}

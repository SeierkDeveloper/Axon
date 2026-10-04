// Mylo, phase 2: the tools it works the network with. Lookups run at once and return what the model reads plus a
// card for the page. Anything that spends (a hire, a second opinion) never runs here: it becomes a proposal the person
// confirms in the page, with the exact agent, task and price, and only their confirmation sets it going
// (myloActions). Every lookup reads public information only.

import { getAgentById, searchAgents } from "./agents";
import { semanticSearchAgents } from "./embeddings";
import { computeProofScore } from "./proofScore";
import { studioInfo } from "./studioPublish";
import { parsePriceToEth } from "./payments";
import { getNetworkStats } from "./analytics";
import { getLatestNetworkRun, publicSummary } from "./autonomyNetwork";
import { getBurnLive } from "./burnLive";
import { toolGate, TURN_BUDGET } from "./myloPolicy";
import { feed } from "./myloStore";
import { proposeHire } from "./myloActions";
import type { Agent } from "@/sdk/types";

/** The tools as the model sees them (Anthropic tool schema). Only what this phase can do. */
export const MYLO_TOOL_DEFS = [
  {
    name: "search_agents",
    description: "Search the live Axon network for agents that can do a job. Use it whenever someone wants something done or asks which agents exist. Returns agents with their tested scores and prices.",
    input_schema: { type: "object", properties: {
      query: { type: "string", description: "What the person needs done, in their words" },
      max_price_eth: { type: "number", description: "Only agents at or under this price per task, in ETH" },
      limit: { type: "integer", description: "How many to return, 1 to 8 (default 5)" },
    }, required: ["query"] },
  },
  {
    name: "agent_details",
    description: "Everything public about one agent: what it does, its price, its Proof Score and track record, its Studio test score if it was built in Studio, and its page.",
    input_schema: { type: "object", properties: { agent_id: { type: "string" } }, required: ["agent_id"] },
  },
  {
    name: "compare_agents",
    description: "Compare two to four agents side by side on score, track record and price, to help pick one.",
    input_schema: { type: "object", properties: { agent_ids: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 4 } }, required: ["agent_ids"] },
  },
  {
    name: "network_pulse",
    description: "How the Axon network is doing right now: agents, tasks done today, success rate, the $AXON burn, and what Axon's hourly self-check last did.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "public_feed",
    description: "The latest things that happened on Axon that are public: hires, builds, burns, repairs.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } } },
  },
  {
    name: "hire_agent",
    description: "Propose hiring one agent for a task. This does NOT hire: it shows the person the agent, the task and the exact price, and nothing happens until they confirm and pay in the page. Use the agent's id from search_agents. Write the task fully and clearly, as the agent should receive it.",
    input_schema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string", description: "The full task for the agent" } }, required: ["agent_id", "task"] },
  },
  {
    name: "second_opinion",
    description: "Propose hiring two or three different agents for the same task, so the person can compare their answers. Like hire_agent, nothing happens until they confirm and pay for each in the page.",
    input_schema: { type: "object", properties: { agent_ids: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 3 }, task: { type: "string" } }, required: ["agent_ids", "task"] },
  },
] as const;

/** One agent as Mylo shows it: public facts only. */
export interface AgentCard { agentId: string; name: string; description: string | null; category: string | null; price: string | null; priceEth: number | null; proofScore: number | null; studioScore: number | null; tasksCompleted: number | null; tools: string[] | null }

export type Card =
  | { kind: "agents"; title: string; agents: AgentCard[] }
  | { kind: "compare"; agents: AgentCard[] }
  | { kind: "pulse"; agents: number; activeAgents: number; tasksToday: number; successRate: number; burned: number | null; burns: number | null; lastCheck: { at: string; checks: number | null } | null };

export interface ToolContext { wallet: string | null; owner: string; conversationId: string }
export interface ToolOutcome { result: unknown; card?: Card; actionId?: string; label: string }

const short = (s: string | undefined | null, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1)}…` : s) : null);

export function agentCard(a: Agent): AgentCard {
  const proof = computeProofScore(a.agentId);
  return {
    agentId: a.agentId, name: a.name, description: short(a.description, 160), category: a.category ?? null,
    // an agent with no price is free to hire, and the model is told so in words
    price: a.price ?? "Free", priceEth: parsePriceToEth(a.price ?? undefined), proofScore: proof?.score ?? a.proofScore ?? null,
    studioScore: studioInfo(a.agentId)?.score ?? null, tasksCompleted: proof?.inputs.tasksCompleted ?? null, tools: a.tools?.length ? a.tools : null,
  };
}

/** What a tool call is shown as while it runs. */
export const TOOL_LABELS: Record<string, string> = {
  search_agents: "Searching the network", agent_details: "Reading the agent's record", compare_agents: "Comparing agents",
  network_pulse: "Checking the network", public_feed: "Reading the latest on Axon", hire_agent: "Preparing the hire", second_opinion: "Preparing a second opinion",
};

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
  const label = TOOL_LABELS[name] ?? name;
  const gate = toolGate(name, Boolean(ctx.wallet));
  if (!gate.ok) return { result: { error: gate.reason }, label };
  try {
    switch (name) {
      case "search_agents": return { ...(await searchTool(input)), label };
      case "agent_details": return { ...detailsTool(input), label };
      case "compare_agents": return { ...compareTool(input), label };
      case "network_pulse": return { ...(await pulseTool()), label };
      case "public_feed": {
        const items = feed(Math.min(Math.max(Number(input.limit) || 10, 1), 20));
        return { result: { items: items.map((t) => ({ kind: t.kind, text: t.text, at: t.createdAt })), note: items.length ? undefined : "Nothing in the public feed yet." }, label };
      }
      case "hire_agent": {
        const p = proposeHire(ctx, [String(input.agent_id ?? "")], String(input.task ?? ""));
        return typeof p === "string" ? { result: { error: p }, label } : { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. The person must confirm and pay in the page; say what you proposed and that it waits for their OK. Never say it is done or paid." }, actionId: p.id, label };
      }
      case "second_opinion": {
        const ids = Array.isArray(input.agent_ids) ? input.agent_ids.map(String) : [];
        if (ids.length < 2) return { result: { error: "A second opinion needs two or three different agents." }, label };
        const p = proposeHire(ctx, ids, String(input.task ?? ""));
        return typeof p === "string" ? { result: { error: p }, label } : { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. Each hire is confirmed and paid by the person in the page. Never say it is done or paid." }, actionId: p.id, label };
      }
      default: return { result: { error: `Mylo can't use ${name} yet.` }, label };
    }
  } catch (err) {
    return { result: { error: `That didn't work just now: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : "unknown error"}` }, label };
  }
}

/** A tool's result as the model reads it: JSON, cut to the policy's length. */
export function forModel(result: unknown): string {
  const s = JSON.stringify(result);
  return s.length > TURN_BUDGET.toolResultChars ? `${s.slice(0, TURN_BUDGET.toolResultChars)}…(cut)` : s;
}

async function searchTool(input: Record<string, unknown>): Promise<Omit<ToolOutcome, "label">> {
  const query = String(input.query ?? "").trim().slice(0, 300);
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 8);
  const maxPrice = Number(input.max_price_eth);
  let agents: Agent[] | null = query ? await semanticSearchAgents(query, { q: query, limit: 20 }).catch(() => null) : null;
  if (!agents?.length) {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const pool = searchAgents({ sort: "reputation", limit: 200 });
    agents = terms.length ? pool.filter((a) => terms.some((t) => `${a.name} ${a.capabilities.join(" ")} ${a.category ?? ""} ${a.description ?? ""}`.toLowerCase().includes(t))) : pool;
  }
  const cards = agents
    .map(agentCard)
    .filter((c) => !(Number.isFinite(maxPrice) && maxPrice > 0 && c.priceEth !== null && c.priceEth > maxPrice))
    .slice(0, limit);
  return { result: { agents: cards, note: cards.length ? undefined : "No agent on Axon matches that yet." }, card: cards.length ? { kind: "agents", title: query, agents: cards } : undefined };
}

function detailsTool(input: Record<string, unknown>): Omit<ToolOutcome, "label"> {
  const a = getAgentById(String(input.agent_id ?? ""));
  if (!a) return { result: { error: "No agent with that id on Axon." } };
  const c = agentCard(a);
  return { result: { ...c, capabilities: a.capabilities, page: `/agents/${a.agentId}`, builtInStudio: c.studioScore !== null }, card: { kind: "agents", title: a.name, agents: [c] } };
}

function compareTool(input: Record<string, unknown>): Omit<ToolOutcome, "label"> {
  const ids = Array.isArray(input.agent_ids) ? [...new Set(input.agent_ids.map(String))].slice(0, 4) : [];
  const found = ids.map((id) => getAgentById(id)).filter((a): a is Agent => Boolean(a)).map(agentCard);
  if (found.length < 2) return { result: { error: "Give at least two agent ids that exist on Axon." } };
  return { result: { agents: found }, card: { kind: "compare", agents: found } };
}

async function pulseTool(): Promise<Omit<ToolOutcome, "label">> {
  const s = getNetworkStats();
  const run = getLatestNetworkRun();
  const sum = run ? publicSummary(run) : null;
  const burn = await getBurnLive().catch(() => null);
  const card: Card = {
    kind: "pulse", agents: s.agents.total, activeAgents: s.agents.active, tasksToday: s.tasks.completedToday, successRate: s.tasks.successRate,
    burned: burn?.totalTokensBurned ?? null, burns: burn?.burnCount ?? null, lastCheck: sum ? { at: sum.finishedAt, checks: sum.checksRun } : null,
  };
  // named for what they are, so the model doesn't read an all-time total as today's
  const { burned, burns, ...rest } = card;
  return { result: { ...rest, axonBurnedAllTime: burned, burnEventsAllTime: burns, lastCheckUpkeep: sum?.upkeep ?? null }, card };
}

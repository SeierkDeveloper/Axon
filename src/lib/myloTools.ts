// Mylo, phases 2 and 3: the tools it works the network and Agent Studio with. Lookups run at once and return what the model reads plus a
// card for the page. Anything that spends (a hire, a second opinion) never runs here: it becomes a proposal the person
// confirms in the page, with the exact agent, task and price, and only their confirmation sets it going
// (myloActions). Every lookup of the network reads public information only; a build report reads the person's own
// Studio builds and nobody else's.

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
import { getDb } from "./db";
import { changeBuild, proposeBuild, proposeHire, proposePublish } from "./myloActions";
import { buildsOf, getBuild } from "./studioDraft";
import { roundsOf, settleStale } from "./studioTest";
import { MAX_TWEAKS_PER_BUILD, MIN_PUBLISH_SCORE, PRICE_ETH } from "./studioPolicy";
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
  {
    name: "build_agent",
    description: "Propose building a new agent in Agent Studio from one sentence: what it does and for whom. This does NOT build yet: the page shows the person a Build it button, and when they tap it Studio writes the agent and tests it (a few minutes). Ask what the agent is for first if it is unclear, then write the sentence well.",
    input_schema: { type: "object", properties: { sentence: { type: "string", description: "The agent in one clear sentence, up to 400 characters" } }, required: ["sentence"] },
  },
  {
    name: "change_build",
    description: "Change one of the person's own Studio builds the way they asked (shorter answers, a new section, a different focus), then test it again. Only for builds that aren't live yet. The new score arrives in the conversation when the test finishes.",
    input_schema: { type: "object", properties: { build_id: { type: "string" }, change: { type: "string", description: "The change, in plain words" } }, required: ["build_id", "change"] },
  },
  {
    name: "build_report",
    description: "The person's own Studio builds. Without build_id: their recent builds with status and score. With build_id: that build's score per round and its weakest test answers with the grader's feedback, which is what to coach from.",
    input_schema: { type: "object", properties: { build_id: { type: "string" } } },
  },
  {
    name: "pricing_advice",
    description: "What similar agents on Axon charge per task, with their scores and track records, to help price an agent. Give a build_id, an agent_id, or a description.",
    input_schema: { type: "object", properties: { build_id: { type: "string" }, agent_id: { type: "string" }, description: { type: "string" } } },
  },
  {
    name: "publish_build",
    description: "Propose putting one of the person's tested builds live on Axon at a price per task (Studio's suggested price if none is given). It must have scored at least 6. The page shows a Publish button; nothing is listed until they tap it.",
    input_schema: { type: "object", properties: { build_id: { type: "string" }, price_eth: { type: "number" } }, required: ["build_id"] },
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
  build_agent: "Preparing the build", change_build: "Making the change", build_report: "Reading your build", pricing_advice: "Looking at what similar agents charge", publish_build: "Preparing to publish",
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
      case "build_agent": {
        const p = await proposeBuild(ctx, String(input.sentence ?? ""));
        return typeof p === "string" ? { result: { error: p }, label } : { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. The person taps Build it in the page; then Studio writes and tests it, which takes a few minutes, and the result arrives here. Never say it is built." }, actionId: p.id, label };
      }
      case "change_build": {
        const p = await changeBuild(ctx, String(input.build_id ?? ""), String(input.change ?? ""));
        return typeof p === "string" ? { result: { error: p }, label } : { result: { changed: true, actionId: p.id, summary: p.summary, note: "The change is being made now and then the agent is tested again; the card shows its progress and the new score arrives here when it finishes. Say that in a sentence. Don't guess the score." }, actionId: p.id, label };
      }
      case "build_report": return { ...buildReport(ctx, input.build_id ? String(input.build_id) : null), label };
      case "pricing_advice": return { ...(await pricingTool(ctx, input)), label };
      case "publish_build": {
        const price = input.price_eth === undefined || input.price_eth === null ? undefined : Number(input.price_eth);
        const p = proposePublish(ctx, String(input.build_id ?? ""), price);
        return typeof p === "string" ? { result: { error: p }, label } : { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. Nothing is listed until the person taps Publish in the page." }, actionId: p.id, label };
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

const STOP = new Set(["and", "the", "for", "with", "that", "this", "from", "who", "what", "into", "your", "you", "are", "can", "agent", "agents", "turns", "writes", "makes"]);

/** Agents like this description: by meaning when the embeddings answer, by words when they don't. */
async function similarAgents(query: string, limit: number): Promise<Agent[]> {
  const agents = query ? await semanticSearchAgents(query, { q: query, limit }).catch(() => null) : null;
  if (agents?.length) return agents;
  const terms = query.toLowerCase().split(/[^a-z0-9$]+/).filter((t) => t.length > 2 && !STOP.has(t));
  const pool = searchAgents({ sort: "reputation", limit: 200 });
  return (terms.length ? pool.filter((a) => terms.some((t) => `${a.name} ${a.capabilities.join(" ")} ${a.category ?? ""} ${a.description ?? ""}`.toLowerCase().includes(t))) : pool).slice(0, limit);
}

async function searchTool(input: Record<string, unknown>): Promise<Omit<ToolOutcome, "label">> {
  const query = String(input.query ?? "").trim().slice(0, 300);
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 8);
  const maxPrice = Number(input.max_price_eth);
  const cards = (await similarAgents(query, 20))
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

/** The person's own builds, or one of them in detail: what Mylo coaches from. Someone else's build reads as missing. */
function buildReport(ctx: ToolContext, buildId: string | null): Omit<ToolOutcome, "label"> {
  if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." } };
  const me = ctx.wallet.toLowerCase();
  if (!buildId) {
    const list = buildsOf(me, 10).map((b) => ({ build_id: b.id, name: b.draft?.name ?? null, sentence: short(b.sentence, 120), status: b.status, score: b.score, live_as: b.agentId }));
    return { result: { builds: list, note: list.length ? undefined : "No Studio builds yet." } };
  }
  settleStale(buildId);
  const b = getBuild(buildId);
  if (!b || b.wallet !== me) return { result: { error: "That isn't one of your builds." } };
  const rounds = roundsOf(b.id);
  const best = rounds.filter((r) => r.score !== null).sort((x, y) => y.score! - x.score!)[0];
  const weakest = (best?.results ?? []).filter((r) => r.score !== null).sort((x, y) => x.score! - y.score!).slice(0, 3)
    .map((r) => ({ task: short(r.task, 300), looked_for: short(r.lookFor, 200), score: r.score, grader_feedback: short(r.feedback, 400) }));
  const tweaks = (getDb().prepare("SELECT tweaks FROM studio_builds WHERE id = ?").get(b.id) as { tweaks: string | null }).tweaks;
  const changesUsed = tweaks ? (JSON.parse(tweaks) as { ok: boolean }[]).filter((t) => t.ok).length : 0;
  return { result: {
    build_id: b.id, name: b.draft?.name ?? null, sentence: b.sentence, status: b.status, score: b.score, error: b.error,
    description: b.draft?.description ?? null, model: b.draft?.model ?? null, tools: b.draft?.tools ?? [], suggested_price_eth: b.draft?.priceEth ?? null,
    rounds: rounds.map((r) => ({ round: r.round, score: r.score })), weakest_tests: weakest,
    can_publish: (b.status === "ready" || b.status === "stopped") && b.score !== null && b.score >= MIN_PUBLISH_SCORE, publish_needs_score: MIN_PUBLISH_SCORE,
    changes_left: Math.max(0, MAX_TWEAKS_PER_BUILD - changesUsed), live_as: b.agentId, studio_page: `/studio?build=${b.id}`,
  } };
}

/** What agents like this one charge, from the live network. Prices in ETH only; free agents are counted apart. */
async function pricingTool(ctx: ToolContext, input: Record<string, unknown>): Promise<Omit<ToolOutcome, "label">> {
  let about = String(input.description ?? "").trim(), self: string | null = null, suggested: number | null = null;
  if (input.build_id) {
    const b = getBuild(String(input.build_id));
    if (!b || !ctx.wallet || b.wallet !== ctx.wallet.toLowerCase()) return { result: { error: "That isn't one of your builds." } };
    about = `${b.sentence} ${b.draft?.description ?? ""}`; suggested = b.draft?.priceEth ?? null; self = b.agentId;
  } else if (input.agent_id) {
    const a = getAgentById(String(input.agent_id));
    if (!a) return { result: { error: "No agent with that id on Axon." } };
    about = `${a.name} ${a.description ?? ""} ${a.capabilities.join(" ")}`; self = a.agentId;
  }
  if (about.length < 3) return { result: { error: "Say what the agent does, or give a build or agent id." } };
  const found = (await similarAgents(about.slice(0, 400), 16)).filter((a) => a.agentId !== self).map(agentCard);
  const priced = found.filter((c) => c.priceEth !== null && c.priceEth > 0).map((c) => c.priceEth!).sort((x, y) => x - y);
  const at = (q: number) => priced[Math.min(priced.length - 1, Math.floor(q * (priced.length - 1)))];
  const shown = found.slice(0, 6);
  return {
    result: {
      similar: shown.map((c) => ({ name: c.name, agent_id: c.agentId, price_eth: c.priceEth, proof_score: c.proofScore, tested_score: c.studioScore, jobs_done: c.tasksCompleted })),
      priced_count: priced.length, free_count: found.length - priced.length,
      price_eth: priced.length ? { lowest: priced[0], quarter: at(0.25), middle: at(0.5), three_quarters: at(0.75), highest: priced[priced.length - 1] } : null,
      studio_suggested_eth: suggested, allowed_range_eth: [PRICE_ETH.min, PRICE_ETH.max],
      note: "A new agent with no jobs yet usually wins its first hires at or below the middle price; one with a higher tested score than its neighbours can ask more.",
    },
    card: shown.length ? { kind: "agents", title: "What similar agents charge", agents: shown } : undefined,
  };
}
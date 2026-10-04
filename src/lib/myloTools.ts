// Mylo, phases 2 to 8: the tools it works the network, Agent Studio, the person's own agents, crews, autopilot,
// token launches and $AXON perks with. Lookups run at once and return what the model reads plus a
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
import { MEMORY, secretLike, toolGate, TURN_BUDGET } from "./myloPolicy";
import { feed, forget, inboxOf, markRead, memoryOf, remember } from "./myloStore";
import { getDb } from "./db";
import { changeBuild, proposeBuild, proposeCrew, proposeHire, proposeImprovement, proposePublish, proposeSchedule, proposeWithdraw, type ScheduleInput } from "./myloActions";
import { crewsOf, deleteCrew, getCrew, saveCrew } from "./myloStore";
import { listRetainers, pauseRetainer, resumeRetainer, cancelRetainer, RetainerError } from "./retainers";
import { retainerView, retainerLimits } from "./retainerApi";
import { getTier, tiers, type TierName } from "./holderTier";
import { BUILDS_PER_DAY } from "./studioPolicy";
import { RETAINERS_BY_TIER } from "./retainerPolicy";
import { CREWS_BY_TIER, CREW_SIZE, HOLDS_AXON, MESSAGES_PER_DAY, myloModels } from "./myloPolicy";
import { earningsOf, withdrawalsOf } from "./studioWithdraw";
import { proposalsOf } from "./studioImprove";
import { checkEligibility } from "./agentLaunch";
import { WITHDRAW, withdrawalsEnabled } from "./studioPolicy";
import { explorerTxUrl } from "./chain";
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
  {
    name: "save_crew",
    description: "Save a crew: two to four agents under a name, in the order they work, each with a short role (researcher, writer, editor). The first gets the task; each next one gets the task and the answer before it. The same name replaces a crew. Use agent ids from search. remove: true deletes the crew.",
    input_schema: { type: "object", properties: { name: { type: "string" }, members: { type: "array", items: { type: "object", properties: { agent_id: { type: "string" }, role: { type: "string" } }, required: ["agent_id"] } }, remove: { type: "boolean" } }, required: ["name"] },
  },
  {
    name: "my_crews",
    description: "The person's saved crews, with their agents, roles and what a run costs.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "run_crew",
    description: "Propose running a saved crew on a task. Nothing runs until the person confirms and pays every paid step from their wallet in the page; then the steps run in order and the final result arrives in the conversation.",
    input_schema: { type: "object", properties: { crew: { type: "string", description: "The crew's name" }, task: { type: "string" } }, required: ["crew", "task"] },
  },
  {
    name: "schedule_job",
    description: "Propose putting a paid agent on autopilot: the same job on a schedule, each run paid from the person's own on-chain allowance within its limits. schedule.kind is interval (every_hours), daily (time HH:MM, time_zone) or weekly (day 0 Sunday to 6 Saturday, time, time_zone). Nothing starts until they confirm in the page.",
    input_schema: { type: "object", properties: { agent_id: { type: "string" }, task: { type: "string", description: "What the agent does on every run" }, schedule: { type: "object", properties: { kind: { type: "string", enum: ["interval", "daily", "weekly"] }, every_hours: { type: "number" }, time: { type: "string" }, time_zone: { type: "string" }, day: { type: "integer" } }, required: ["kind"] }, max_runs: { type: "integer" } }, required: ["agent_id", "task", "schedule"] },
  },
  {
    name: "my_schedules",
    description: "The person's jobs on autopilot: what each does, when it runs next, what it costs, and whether it is paused.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "manage_schedule",
    description: "Pause, resume or stop one of the person's jobs on autopilot, by its retainer_id from my_schedules.",
    input_schema: { type: "object", properties: { retainer_id: { type: "string" }, action: { type: "string", enum: ["pause", "resume", "stop"] } }, required: ["retainer_id", "action"] },
  },
  {
    name: "launch_token",
    description: "Prepare launching a token for one of the person's agents: checks it can launch and gives the launch page with a name, ticker and description filled in. The person adds an image and launches from their own wallet there; Mylo never launches it.",
    input_schema: { type: "object", properties: { agent_id: { type: "string" }, name: { type: "string" }, ticker: { type: "string" }, description: { type: "string" } }, required: ["agent_id"] },
  },
  {
    name: "my_tier",
    description: "What holding $AXON gives this person: their tier and balance, what it unlocks on Axon and in Mylo, and what the next tier adds.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remember",
    description: "Remember one thing the person told you about themselves for next time: a short key (like budget, building, answer_style) and the value in their words. The same key replaces the old value. Never secrets.",
    input_schema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
  },
  {
    name: "forget",
    description: "Forget one remembered thing by its key, or everything when everything is true.",
    input_schema: { type: "object", properties: { key: { type: "string" }, everything: { type: "boolean" } } },
  },
  {
    name: "my_inbox",
    description: "What Mylo noticed for the person since they last looked: their agents earning, paid jobs that failed, better versions ready, agents taken out of rotation or back, remixes, withdrawals sent. Use it when they ask what they missed or what's new. Reading marks them read.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "my_agents",
    description: "The person's own agents on Axon: price, scores, jobs done, remixes others made of them, better versions Axon has tested and is waiting to apply, and whether each can launch a token (with the page to do it).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "my_earnings",
    description: "What each of the person's Studio agents has earned in ETH, what they can take out now, their recent withdrawals, and the withdrawal limits.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "withdraw_earnings",
    description: "Propose taking out what one of the person's Studio agents earned. It can only go to the wallet that owns the agent. Everything it can take out unless they name an amount. Nothing is sent until they tap Withdraw in the page.",
    input_schema: { type: "object", properties: { agent_id: { type: "string" }, amount_eth: { type: "number" } }, required: ["agent_id"] },
  },
  {
    name: "apply_improvement",
    description: "Propose applying a better version Axon tested for one of the person's live agents (an improvement id from my_agents). Nothing changes until they tap Apply in the page.",
    input_schema: { type: "object", properties: { improvement_id: { type: "string" } }, required: ["improvement_id"] },
  },
] as const;

/** One agent as Mylo shows it: public facts only. */
export interface AgentCard { agentId: string; name: string; description: string | null; category: string | null; price: string | null; priceEth: number | null; proofScore: number | null; studioScore: number | null; tasksCompleted: number | null; tools: string[] | null }

export type Card =
  | { kind: "agents"; title: string; agents: AgentCard[] }
  | { kind: "compare"; agents: AgentCard[] }
  | { kind: "earnings"; agents: { agentId: string; name: string; earnedEth: number; availableEth: number }[]; availableEth: number }
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
  save_crew: "Saving the crew", my_crews: "Looking at your crews", run_crew: "Preparing the crew", schedule_job: "Preparing the autopilot", my_schedules: "Looking at your autopilot", manage_schedule: "Updating your autopilot", launch_token: "Preparing the launch", my_tier: "Checking your $AXON tier",
  remember: "Remembering that", forget: "Forgetting that", my_inbox: "Reading what's new for you", my_agents: "Looking at your agents", my_earnings: "Checking your earnings", withdraw_earnings: "Preparing the withdrawal", apply_improvement: "Preparing the update",
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
      case "save_crew": return { ...(await saveCrewTool(ctx, input)), label };
      case "my_crews": {
        if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." }, label };
        return { result: { crews: crewsOf(ctx.wallet).map((c) => crewView(c.name, c.members)), note: crewsOf(ctx.wallet).length ? undefined : "No crews yet. Save one from agents they like." }, label };
      }
      case "run_crew": {
        const p = proposeCrew(ctx, String(input.crew ?? ""), String(input.task ?? ""));
        return typeof p === "string" ? { result: { error: p }, label } : { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. Nothing runs until the person confirms and pays each paid step in the page." }, actionId: p.id, label };
      }
      case "schedule_job": {
        const p = await proposeSchedule(ctx, String(input.agent_id ?? ""), String(input.task ?? ""), (input.schedule ?? {}) as ScheduleInput, input.max_runs ? Number(input.max_runs) : null);
        if (typeof p === "string") return { result: { error: p }, label };
        const limits = await retainerLimits(ctx.wallet!);
        return { result: { proposed: true, actionId: p.id, summary: p.summary, autopilot_slots: { in_use: limits.inUse, allowed: limits.active }, note: "Proposed only. Nothing starts until the person confirms in the page. Each run pays from their allowance (set on the Dashboard); if it can't pay, the job waits." }, actionId: p.id, label };
      }
      case "my_schedules": {
        if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." }, label };
        const list = listRetainers(ctx.wallet).map((r) => retainerView(r));
        return { result: { jobs: list.map((r) => ({ retainer_id: r.retainerId, agent: getAgentById(r.agentId)?.name ?? r.agentId, does: r.instructions.slice(0, 160), when: r.scheduleText, status: r.status, paused_because: r.pauseText, next_run: r.nextRunAt, price_per_run: r.pricePerRun, at_most_per_day: r.maxPerDay, runs_done: r.runsDone })), limits: await retainerLimits(ctx.wallet), note: list.length ? undefined : "Nothing on autopilot yet." }, label };
      }
      case "manage_schedule": {
        if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." }, label };
        const id = String(input.retainer_id ?? ""), act = String(input.action ?? "");
        try {
          const r = act === "pause" ? pauseRetainer(id, ctx.wallet) : act === "resume" ? resumeRetainer(id, ctx.wallet) : act === "stop" ? cancelRetainer(id, ctx.wallet) : null;
          if (!r) return { result: { error: "Say pause, resume or stop." }, label };
          return { result: { done: act, job: { retainer_id: r.retainerId, status: r.status, next_run: r.nextRunAt } }, label };
        } catch (err) {
          return { result: { error: err instanceof RetainerError || err instanceof Error ? err.message : "That didn't work." }, label };
        }
      }
      case "launch_token": return { ...launchTool(ctx, input), label };
      case "my_tier": return { ...(await tierTool(ctx)), label };
      case "remember": {
        if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." }, label };
        const key = String(input.key ?? "").trim().toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/\s+/g, "_").slice(0, 40);
        const value = String(input.value ?? "").replace(/\s+/g, " ").trim();
        if (!key || value.length < 2) return { result: { error: "Give a short key and what to remember." }, label };
        if (value.length > MEMORY.factChars) return { result: { error: `Keep it under ${MEMORY.factChars} characters.` }, label };
        if (secretLike(value) || secretLike(`${key} ${value}`)) return { result: { error: "That looks like a secret (a key, seed phrase or password). Mylo never keeps those. Tell them to keep it to themselves." }, label };
        const f = remember(ctx.wallet, key, value);
        return { result: { remembered: { key: f.key, value: f.value }, note: "Say in a few words that you'll remember it, and that they can see or clear it under Memory." }, label };
      }
      case "forget": {
        if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." }, label };
        if (input.everything === true) return { result: { forgot: forget(ctx.wallet), everything: true }, label };
        const key = String(input.key ?? "").trim().toLowerCase().replace(/\s+/g, "_");
        if (!key) return { result: { error: "Say which one, or forget everything.", remembered_keys: memoryOf(ctx.wallet).map((f) => f.key) }, label };
        const n = forget(ctx.wallet, key);
        return { result: n ? { forgot: key } : { error: "Nothing was remembered under that.", remembered_keys: memoryOf(ctx.wallet).map((f) => f.key) }, label };
      }
      case "my_inbox": {
        if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." }, label };
        const items = inboxOf(ctx.wallet, false, 15);
        const unread = items.filter((n) => !n.readAt);
        markRead(ctx.wallet, unread.map((n) => n.id));
        return { result: { new: unread.map((n) => ({ what: n.title, detail: n.body, link: n.link, at: n.createdAt })), earlier: items.filter((n) => n.readAt).slice(0, 5).map((n) => ({ what: n.title, at: n.createdAt })), note: items.length ? undefined : "Nothing yet. Mylo tells them here when their agents earn, need attention or get better." }, label };
      }
      case "my_agents": return { ...myAgents(ctx), label };
      case "my_earnings": return { ...myEarnings(ctx), label };
      case "withdraw_earnings": {
        const amount = input.amount_eth === undefined || input.amount_eth === null ? undefined : Number(input.amount_eth);
        const p = proposeWithdraw(ctx, String(input.agent_id ?? ""), amount);
        return typeof p === "string" ? { result: { error: p }, label } : { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. Nothing is sent until the person taps Withdraw in the page; it goes to their own wallet." }, actionId: p.id, label };
      }
      case "apply_improvement": {
        const p = proposeImprovement(ctx, String(input.improvement_id ?? ""));
        return typeof p === "string" ? { result: { error: p }, label } : { result: { proposed: true, actionId: p.id, summary: p.summary, note: "Proposed only. Nothing changes until the person taps Apply in the page." }, actionId: p.id, label };
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

/** The person's own agents and what is going on with each. Theirs alone: found by the wallet that owns them. */
function myAgents(ctx: ToolContext): Omit<ToolOutcome, "label"> {
  if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." } };
  const me = ctx.wallet.toLowerCase();
  const ids = (getDb().prepare("SELECT agent_id FROM agents WHERE LOWER(wallet_address) = ? ORDER BY created_at DESC LIMIT 20").all(me) as { agent_id: string }[]).map((r) => r.agent_id);
  const earned = new Map(earningsOf(me).map((e) => [e.agentId, e]));
  const proposals = proposalsOf(me);
  const agents = ids.map((id) => getAgentById(id)).filter((a): a is Agent => Boolean(a));
  const rows = agents.map((a) => {
    const c = agentCard(a), e = earned.get(a.agentId), launch = checkEligibility(a.agentId, me);
    const remixes = getDb().prepare("SELECT agent_id, name FROM agents WHERE remix_of = ?").all(a.agentId) as { agent_id: string; name: string }[];
    return {
      agent_id: a.agentId, name: a.name, page: `/agents/${a.agentId}`, price_eth: c.priceEth, tested_score: c.studioScore, proof_score: c.proofScore, jobs_done: c.tasksCompleted,
      built_in_studio: c.studioScore !== null, earned_eth: e?.earnedEth ?? null, can_withdraw_eth: e?.availableEth ?? null,
      remixes: remixes.map((r) => ({ agent_id: r.agent_id, name: r.name })),
      better_version_waiting: proposals.filter((p) => p.agentId === a.agentId).map((p) => ({ improvement_id: p.id, tested_before: p.fromScore, tested_now: p.toScore, from_weak_jobs: p.weakJobs })),
      token_launch: launch.eligible ? { can_launch: true, page: `/launch/${a.agentId}` } : { can_launch: false, why_not: launch.reason },
    };
  });
  return {
    result: { agents: rows, note: rows.length ? undefined : "No agents on this wallet yet. Mylo can build one with them in Studio." },
    card: agents.length ? { kind: "agents", title: "Your agents", agents: agents.slice(0, 8).map(agentCard) } : undefined,
  };
}

/** What the person's Studio agents earned and can take out, and the rules for taking it out. */
function myEarnings(ctx: ToolContext): Omit<ToolOutcome, "label"> {
  if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." } };
  const me = ctx.wallet.toLowerCase();
  const list = earningsOf(me);
  const available = +list.reduce((s, e) => s + e.availableEth, 0).toFixed(8);
  return {
    result: {
      agents: list.map((e) => ({ agent_id: e.agentId, name: e.name, earned_eth: e.earnedEth, withdrawn_eth: e.withdrawnEth, can_withdraw_eth: e.availableEth })),
      total_can_withdraw_eth: available,
      recent_withdrawals: withdrawalsOf(me, 5).map((w) => ({ agent_id: w.agentId, amount_eth: w.amountEth, status: w.status, tx: w.txHash ? explorerTxUrl(w.txHash) : null, at: w.createdAt })),
      rules: { least_eth: WITHDRAW.minEth, most_per_day_eth: WITHDRAW.maxPerDayEth, to: "only the wallet that owns the agent", open: withdrawalsEnabled() },
      note: list.length ? undefined : "Only agents built in Agent Studio earn into a balance that can be withdrawn here.",
    },
    card: list.length ? { kind: "earnings", agents: list.map((e) => ({ agentId: e.agentId, name: e.name, earnedEth: e.earnedEth, availableEth: e.availableEth })), availableEth: available } : undefined,
  };
}

const crewView = (name: string, members: { agentId: string; role: string }[]) => {
  const agents = members.map((m) => ({ agent_id: m.agentId, name: getAgentById(m.agentId)?.name ?? m.agentId, role: m.role, price_eth: parsePriceToEth(getAgentById(m.agentId)?.price ?? undefined) }));
  return { name, steps: agents, cost_eth: +agents.reduce((s, a) => s + (a.price_eth ?? 0), 0).toFixed(8) };
};

/** Save (or remove) a crew: two to four agents of the network, in order, within the wallet's tier's number of crews. */
async function saveCrewTool(ctx: ToolContext, input: Record<string, unknown>): Promise<Omit<ToolOutcome, "label">> {
  if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." } };
  const name = String(input.name ?? "").replace(/\s+/g, " ").trim();
  if (name.length < 2) return { result: { error: "Give the crew a short name." } };
  if (input.remove === true) return { result: deleteCrew(ctx.wallet, name) ? { removed: name } : { error: `There's no crew called "${name}".` } };
  const raw = Array.isArray(input.members) ? input.members as { agent_id?: unknown; role?: unknown }[] : [];
  const members = raw.map((m) => ({ agentId: String(m.agent_id ?? "").trim(), role: String(m.role ?? "").replace(/\s+/g, " ").trim().slice(0, 60) })).filter((m) => m.agentId);
  if (members.length < CREW_SIZE.min || members.length > CREW_SIZE.max) return { result: { error: `A crew is ${CREW_SIZE.min} to ${CREW_SIZE.max} agents.` } };
  if (new Set(members.map((m) => m.agentId)).size !== members.length) return { result: { error: "Each agent can be in a crew once." } };
  for (const m of members) if (!getAgentById(m.agentId)) return { result: { error: `There is no agent called ${m.agentId} on Axon.` } };
  const { tier } = await getTier(ctx.wallet);
  const cap = CREWS_BY_TIER[tier.name];
  if (!getCrew(ctx.wallet, name) && crewsOf(ctx.wallet).length >= cap) return { result: { error: `This wallet can keep ${cap} crews. Remove one, or hold more $AXON for more.` } };
  const c = saveCrew(ctx.wallet, name, members);
  return { result: { saved: crewView(c.name, c.members), note: "Saved. Running it is proposed separately and paid on their OK." } };
}

/** Get a launch ready: the agent can launch, and the page opens with what Mylo suggests filled in. */
function launchTool(ctx: ToolContext, input: Record<string, unknown>): Omit<ToolOutcome, "label"> {
  if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." } };
  const agentId = String(input.agent_id ?? "");
  const e = checkEligibility(agentId, ctx.wallet.toLowerCase());
  if (!e.eligible) return { result: { can_launch: false, why_not: e.reason } };
  const q = new URLSearchParams();
  const name = String(input.name ?? "").trim().slice(0, 40), ticker = String(input.ticker ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10), about = String(input.description ?? "").trim().slice(0, 200);
  if (name) q.set("name", name);
  if (ticker) q.set("symbol", ticker);
  if (about) q.set("description", about);
  return { result: { can_launch: true, page: `/launch/${agentId}${q.size ? `?${q}` : ""}`, filled_in: { name: name || null, ticker: ticker || null, description: about || null }, still_needed: "an image, then they launch from their own wallet on that page", record: e.record } };
}

/** What each tier gives, from the rules the rest of Axon actually enforces. */
function perksOf(t: TierName) {
  return { mylo_messages_a_day: MESSAGES_PER_DAY[t], mylo_model: HOLDS_AXON(t) ? `${myloModels().chat} (the smarter one)` : myloModels().base, studio_builds_a_day: BUILDS_PER_DAY[t], autopilot_jobs: RETAINERS_BY_TIER[t].active, autopilot_fastest_every_hours: RETAINERS_BY_TIER[t].fastestHours, saved_crews: CREWS_BY_TIER[t] };
}

async function tierTool(ctx: ToolContext): Promise<Omit<ToolOutcome, "label">> {
  if (!ctx.wallet) return { result: { error: "Sign in with your wallet first." } };
  const r = await getTier(ctx.wallet);
  const next = tiers().find((t) => t.rank === r.tier.rank + 1) ?? null;
  return { result: {
    tier: r.tier.name, axon_held: r.balance, perks: perksOf(r.tier.name),
    next: next ? { tier: next.name, hold_at_least: next.minimum, more_axon_needed: r.balance === null ? null : Math.max(0, next.minimum - r.balance), perks: perksOf(next.name) } : null,
    note: r.balance === null ? "The balance couldn't be read just now; this is the base tier until it can." : undefined,
  } };
}
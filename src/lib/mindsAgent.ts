// Agent Minds: the agent behind a token.
//
// Every token launched with a mind stands behind an agent that does real work on Axon. A launch is prepared with
// either an agent its creator already owns, or one line about what a new agent should do. The new one, a starter
// agent, is written from that line by a fixed template: no model is asked, so a launch costs nobody a model call.
//
// A starter agent is made only once the chain shows the launch. Preparing one writes a row and nothing else.

import { getDb } from "./db";
import { createAgent, getAgentById, categoryFromCapabilities } from "./agents";
import { describedFrom } from "./agentDescription";
import { setInstructions } from "./agentKnowledge";
import { validateAgentContent, validateAgentText } from "./agentContent";
import { consumeHandle } from "./reservedHandles";
import { freeHandle } from "./studioDraft";
import { PRICE_ETH } from "./studioPolicy";
import { normalizeAddress, sameAddress } from "./address";
import { prepareLaunch, preparedToday, tokenOfAgent, type PreparedLaunch } from "./mindsStore";

export const LAUNCH_LIMITS = {
  nameChars: 32,
  symbolChars: 10,
  /** the one line about what the agent does */
  lineMin: 12,
  lineChars: 180,
  logoChars: 500,
  descriptionChars: 500,
  /** prepared launches a wallet may write in a day; a launch nobody signs is only a row */
  preparesPerDay: 20,
} as const;

/** What a starter agent runs on when it is hired. Its owner can change it, like any agent's. */
export const STARTER_MODEL = "claude-sonnet-5";

const SMALL_WORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "any", "all", "its", "are", "can", "will", "what", "when", "them", "their", "about", "every", "each", "agent", "does", "anything"]);

/** What the agent can do, as a few words taken from its one line: what people search agents by. */
export function skillsFrom(line: string): string[] {
  const words = line.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !SMALL_WORDS.has(w));
  const skills = [...new Set(words)].slice(0, 5);
  return skills.length ? skills : ["general"];
}

/** A starter agent's instructions: its name, the line its creator wrote, and how to answer. */
export function starterInstructions(name: string, line: string): string {
  const what = /[.!?]$/.test(line) ? line : `${line}.`;
  return `You are ${name}, an agent people hire on Axon. This is what you do: ${what}

Do the task you are given, fully, and give the finished work as your answer. Stay inside what you do: when a task is outside it, say so in one sentence and offer the closest thing you can do well. Be exact, say what you are unsure of, and never invent facts, numbers or sources.`;
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

export interface LaunchRequest { name?: unknown; symbol?: unknown; line?: unknown; agentId?: unknown; logo?: unknown; description?: unknown }

/**
 * Prepare a launch for a wallet: check what it asks for and write it down with the reference its transaction will
 * carry. Returns the prepared launch, or why not in words the form can show.
 */
export function prepare(wallet: string, req: LaunchRequest): PreparedLaunch | string {
  const me = wallet.toLowerCase();
  const name = text(req.name, LAUNCH_LIMITS.nameChars);
  const symbol = text(req.symbol, LAUNCH_LIMITS.symbolChars).toUpperCase();
  if (name.length < 2) return "Give the token a name.";
  if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return "A ticker is 2 to 10 letters or numbers.";
  const logo = text(req.logo, LAUNCH_LIMITS.logoChars) || null;
  if (logo && !/^(https:\/\/|ipfs:\/\/)/.test(logo)) return "The picture has to be an https or ipfs link.";
  const description = text(req.description, LAUNCH_LIMITS.descriptionChars) || null;
  if (preparedToday(me) >= LAUNCH_LIMITS.preparesPerDay) return "That is a lot of launches prepared today. Try again tomorrow.";

  const agentId = text(req.agentId, 80);
  if (agentId) {
    // an agent that already exists: it has to be this wallet's, and an agent stands behind one token
    const agent = getAgentById(agentId);
    if (!agent || !sameAddress(agent.walletAddress, me)) return "That is not an agent of yours.";
    if (tokenOfAgent(agent.agentId)) return "That agent already has a token.";
    const bad = validateAgentContent(name, agent.agentId, []) ?? (description ? validateAgentText(description) : null);
    if (bad) return bad;
    return prepareLaunch({ wallet: me, agentId: agent.agentId, name, symbol, line: null, logo, description });
  }

  const line = text(req.line, LAUNCH_LIMITS.lineChars);
  if (line.length < LAUNCH_LIMITS.lineMin) return "Say in one line what the agent does.";
  const bad = validateAgentContent(name, freeHandle(name, me), skillsFrom(line)) ?? validateAgentText(`${line}\n${description ?? ""}`);
  if (bad) return bad;
  return prepareLaunch({ wallet: me, agentId: null, name, symbol, line, logo, description });
}

/**
 * The agent a launched token stands behind: the one its creator picked (if it is still theirs and still free), or a
 * starter agent made now from the prepared line. Returns its id, or null when there is no agent to give it.
 */
export function agentFor(p: PreparedLaunch): string | null {
  if (p.agentId) {
    const agent = getAgentById(p.agentId);
    return agent && sameAddress(agent.walletAddress, p.wallet) && !tokenOfAgent(agent.agentId) ? agent.agentId : null;
  }
  if (!p.line) return null;
  // made once: a launch read a second time finds the agent it made the first time
  const made = getDb().prepare("SELECT agent_id FROM agents WHERE public_key = ?").get(`minds:${p.ref}`) as { agent_id: string } | undefined;
  if (made) return made.agent_id;

  const skills = skillsFrom(p.line);
  const now = new Date().toISOString();
  const agent = createAgent({
    agentId: freeHandle(p.name, p.wallet),
    name: p.name,
    capabilities: skills,
    publicKey: `minds:${p.ref}`,
    price: `${PRICE_ETH.fallback} ETH`,
    category: categoryFromCapabilities(skills),
    walletAddress: normalizeAddress(p.wallet) ?? p.wallet,
    provider: "anthropic",
    providerModel: STARTER_MODEL,
    tools: [],
    reputation: 0,
    createdAt: now,
  }, { describe: false });
  setInstructions(agent.agentId, starterInstructions(p.name, p.line));
  // the creator's own line is its description; nothing is asked of a model
  getDb().prepare("UPDATE agents SET description = ?, described_from = ?, described_at = ? WHERE agent_id = ?").run(p.line, describedFrom(agent), now, agent.agentId);
  consumeHandle(agent.agentId, p.wallet);
  return agent.agentId;
}

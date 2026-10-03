// Agent Studio, phase 5: a tested build goes live, and a live Studio agent can be remixed.
//
// Publishing turns the build's best version into a real agent on Axon: its instructions, model, tools and category, at
// the price its owner sets, owned by the wallet that built it. Only a build whose best round scored MIN_PUBLISH_SCORE
// or more can be published; the score goes on the agent's page.
//
// A remix is a copy of a published Studio agent that someone else can change and publish as their own. It is a new
// build, tested before it can be listed, and once live it pays the agent it came from REMIX_SHARE_BPS of every hire,
// through the same escrow split every multi-agent payment uses (payments.releasePayment).

import { randomUUID } from "crypto";
import { getDb } from "./db";
import { createAgent, getAgentById } from "./agents";
import { consumeHandle } from "./reservedHandles";
import { setInstructions, getInstructions } from "./agentKnowledge";
import { getBuild, updateBuild, freeHandle, mayStart, type Draft, type Build } from "./studioDraft";
import { studioEnabled, MIN_PUBLISH_SCORE, REMIX_SHARE_BPS, clampPrice, PRICE_ETH } from "./studioPolicy";
import { normalizeAddress } from "./address";
import { logger } from "./logger";

export interface StudioInfo { score: number; buildId: string; remixOf: string | null }

/** What a published agent carries from Studio, or null for an agent registered by hand. */
export function studioInfo(agentId: string): StudioInfo | null {
  const r = getDb().prepare("SELECT studio_score, studio_build, remix_of FROM agents WHERE agent_id = ?").get(agentId) as { studio_score: number | null; studio_build: string | null; remix_of: string | null } | undefined;
  return r?.studio_build && r.studio_score !== null ? { score: r.studio_score, buildId: r.studio_build, remixOf: r.remix_of } : null;
}

/** The agent a remix pays a share of every hire to, when it is one. */
function remixParent(agentId: string): string | null {
  const r = getDb().prepare("SELECT remix_of FROM agents WHERE agent_id = ?").get(agentId) as { remix_of: string | null } | undefined;
  return r?.remix_of ?? null;
}

/**
 * Publish a build as a live agent at the owner's price (ETH per task). Returns the new agent's id, or why not.
 */
export function publishBuild(buildId: string, wallet: string, priceEth?: number): { agentId: string } | string {
  if (!studioEnabled()) return "Agent Studio is paused just now.";
  const b = getBuild(buildId);
  const me = wallet.toLowerCase();
  if (!b || b.wallet !== me) return "No such build.";
  if (b.status === "published") return "This build is already live.";
  if (b.status !== "ready" && b.status !== "stopped") return "Test the agent before publishing it.";
  if (!b.draft) return "This build has no agent to publish.";
  if (b.score === null || b.score < MIN_PUBLISH_SCORE) return `It needs a test score of ${MIN_PUBLISH_SCORE} to be listed. Ask for a change and test it again.`;
  const price = priceEth === undefined ? b.draft.priceEth : priceEth;
  if (!Number.isFinite(price) || price < PRICE_ETH.min || price > PRICE_ETH.max) return `Set a price between ${PRICE_ETH.min} and ${PRICE_ETH.max} ETH a task.`;

  const d: Draft = b.draft;
  // the handle was free when drafted; someone may have taken it since
  const handle = freeHandle(d.handle, me);
  const remixOf = (getDb().prepare("SELECT remix_of FROM studio_builds WHERE id = ?").get(buildId) as { remix_of: string | null }).remix_of;
  const agent = createAgent({
    agentId: handle,
    name: d.name,
    capabilities: d.capabilities,
    publicKey: `studio:${buildId}`,
    price: `${clampPrice(price)} ETH`,
    category: d.category,
    walletAddress: normalizeAddress(me) ?? me,
    provider: "anthropic",
    providerModel: d.model,
    tools: d.tools,
    reputation: 0,
    createdAt: new Date().toISOString(),
  });
  setInstructions(agent.agentId, d.instructions);
  getDb().prepare("UPDATE agents SET description = ?, described_from = 'studio', described_at = ?, studio_score = ?, studio_build = ?, remix_of = ? WHERE agent_id = ?")
    .run(d.description, new Date().toISOString(), b.score, buildId, remixOf, agent.agentId);
  consumeHandle(agent.agentId, me);
  updateBuild(buildId, { status: "published", agentId: agent.agentId, draft: { ...d, handle: agent.agentId, priceEth: clampPrice(price) } });
  logger.info("studio.published", "A Studio agent went live", { buildId, agentId: agent.agentId, score: b.score, remixOf });
  return { agentId: agent.agentId };
}

/**
 * Start a remix: a new build for this wallet, a copy of a live Studio agent, drafted and waiting to be changed and
 * tested on the same tasks the original was. Returns the build, or why not.
 */
export async function remixAgent(agentId: string, wallet: string): Promise<Build | string> {
  if (!studioEnabled()) return "Agent Studio is paused just now.";
  const me = wallet.toLowerCase();
  const original = getAgentById(agentId);
  const info = studioInfo(agentId);
  if (!original || !info) return "Only agents built in Agent Studio can be remixed.";
  if (original.walletAddress?.toLowerCase() === me) return "This is your own agent. Change it in Studio instead.";
  const instructions = getInstructions(agentId);
  const source = getBuild(info.buildId);
  if (!instructions || !source?.draft) return "This agent cannot be remixed just now.";
  // a remix is a build: it counts toward the wallet's day and running limits like one
  const allowed = await mayStart(me);
  if (!allowed.ok) return allowed.reason;

  const id = randomUUID();
  const now = new Date().toISOString();
  const name = `${original.name} Remix`.slice(0, 48);
  const draft: Draft = { ...source.draft, name, handle: freeHandle(name, me), instructions };
  const tasks = (getDb().prepare("SELECT tasks FROM studio_builds WHERE id = ?").get(info.buildId) as { tasks: string | null } | undefined)?.tasks ?? null;
  getDb().prepare("INSERT INTO studio_builds (id, wallet, sentence, status, draft, tasks, remix_of, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, me, `A remix of ${original.name}`, "drafted", JSON.stringify(draft), tasks, agentId, now, now);
  return getBuild(id)!;
}

/**
 * A split the payer set, with the remix share kept: a recipient that is a remix passes 10% of its own share on to the
 * agent it came from, so splitting a hire never routes around the original's cut. Shares still sum to the same total.
 */
export function withRemixShares<T extends { splitId: string; agentId: string; shareBps: number }>(splits: T[]): T[] {
  return splits.flatMap((s) => {
    const parent = remixParent(s.agentId);
    if (!parent || parent === s.agentId || !getAgentById(parent)) return [s];
    const toParent = Math.floor((s.shareBps * REMIX_SHARE_BPS) / 10_000);
    if (toParent <= 0) return [s];
    return [{ ...s, shareBps: s.shareBps - toParent }, { ...s, splitId: `${s.splitId}:remix`, agentId: parent, shareBps: toParent }];
  });
}

/** The split a remix's hire is paid out by, when there is no split the payer set: the remix, and the agent it came from. */
export function remixSplit(agentId: string, taskId: string): { splitId: string; taskId: string; agentId: string; shareBps: number; createdAt: string }[] | null {
  const parent = remixParent(agentId);
  if (!parent || parent === agentId || !getAgentById(parent)) return null;
  const at = new Date().toISOString();
  return [
    { splitId: `remix:${taskId}:a`, taskId, agentId, shareBps: 10_000 - REMIX_SHARE_BPS, createdAt: at },
    { splitId: `remix:${taskId}:b`, taskId, agentId: parent, shareBps: REMIX_SHARE_BPS, createdAt: at },
  ];
}

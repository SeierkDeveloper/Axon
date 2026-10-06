// Mylo, phase 7: Mylo inside other assistants. The ask_mylo tool on Axon's MCP server (and so on /api/tools for
// function calling) is one turn of the same conversation the person has on the site: their wallet's Mylo, with its
// memory, daily limits and budget. It answers in words and lists what it showed. Anything that spends, builds or
// publishes is a proposal there as on the site, and comes back with a link to confirm it on the site, where the person
// pays from their own wallet. Nothing here signs or confirms anything.

import { authenticateApiKey } from "./identity";
import { NextRequest } from "next/server";
import { getTier } from "./holderTier";
import { runTurn, type MyloEvent, type Streamer } from "./myloChat";
import { addressKeyOf } from "./myloStore";
import type { Card } from "./myloTools";

/** Where people confirm what Mylo proposed: the site this server is, set with MYLO_SITE_URL off the main domain. */
export const siteUrl = () => (process.env.MYLO_SITE_URL?.trim().replace(/\/$/, "") || "https://axon-agents.com");

export const ASK_MYLO_TOOL = {
  name: "ask_mylo",
  description:
    "Talk to Mylo, Axon's own AI, from here: ask it to find and compare agents for a job, propose a hire or a second opinion, build an agent in Agent Studio and coach it, check your agents and earnings, or what you missed. It is your wallet's Mylo (its memory and daily limits), so it needs your Axon key on this connection (an allowance key from the Dashboard works). Anything that spends, builds or publishes is only proposed: Mylo returns a confirm link to approve it on axon-agents.com. Pass conversation_id from the last answer to continue the same conversation.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "What to say to Mylo, in plain words" },
      conversation_id: { type: "string", description: "To continue a conversation: the conversation_id Mylo returned last time" },
    },
    required: ["message"],
  },
} as const;

/** What Mylo showed, as plain data an assistant can use. */
function shown(cards: Card[]) {
  return cards.map((c) => {
    if (c.kind === "agents" || c.kind === "compare") return { kind: c.kind === "compare" ? "comparison" : "agents", agents: c.agents.map((a) => ({ agent_id: a.agentId, name: a.name, price: a.price, tested_score: a.studioScore, proof_score: a.proofScore, jobs_done: a.tasksCompleted })) };
    if (c.kind === "my_tokens") return { kind: "your_tokens", launched: c.launched.map((r) => ({ token: r.token.token, name: r.token.name, ticker: r.token.symbol, mind: r.line, page: `${siteUrl()}${r.token.page}` })), holding: c.holding.map((r) => ({ token: r.token.token, name: r.token.name, ticker: r.token.symbol, holding: r.line, page: `${siteUrl()}${r.token.page}` })), rewards_to_claim: c.rewards.map((r) => ({ token: r.token, ticker: r.symbol, amount_eth: r.amountEth, claim_page: `${siteUrl()}${r.page}` })), rewards_to_claim_total_eth: c.claimEth };
    if (c.kind === "token") return { kind: "token", token: c.token.token, name: c.token.name, ticker: c.token.symbol, market_cap_eth: c.token.mcapEth, holders: c.token.holders, mind: { runs_on: c.mind.runsOn, status: c.mind.status, latest_thought: c.mind.lastThought?.text ?? null }, page: `${siteUrl()}${c.token.page}` };
    if (c.kind === "tokens") return { kind: "tokens", title: c.title, tokens: c.tokens.map((t) => ({ token: t.token, name: t.name, ticker: t.symbol, market_cap_eth: t.mcapEth, holders: t.holders, page: `${siteUrl()}${t.page}` })) };
    if (c.kind === "launch") return { kind: "launch", agent: c.agentName, name: c.name, ticker: c.ticker, description: c.description, launch_page: `${siteUrl()}${c.page}` };
    if (c.kind === "earnings") return { kind: "earnings", can_withdraw_eth: c.availableEth, agents: c.agents.map((a) => ({ agent_id: a.agentId, name: a.name, earned_eth: a.earnedEth, can_withdraw_eth: a.availableEth })) };
    return { kind: "network", agents: c.agents, tasks_today: c.tasksToday, success_rate: c.successRate, axon_burned: c.burned };
  });
}

/** One message to Mylo from an assistant. Returns Mylo's answer, or why there is none. */
export async function askMylo(args: Record<string, unknown>, clientIp: string, apiKey: string | null, streamer?: Streamer) {
  const message = typeof args.message === "string" ? args.message : "";
  if (!message.trim()) return { error: "Say something to Mylo: message is required." };
  if (!apiKey) return { error: `Mylo is your wallet's own AI, so it needs your Axon key on this connection. Sign in at ${siteUrl()}/mylo, create a key on the Dashboard, and add it to this connection's Authorization header.` };
  const wallet = authenticateApiKey(new NextRequest(`${siteUrl()}/mcp`, { headers: { "x-api-key": apiKey } }), { allowAllowanceScope: true })?.walletAddress?.toLowerCase() ?? null;
  if (!wallet) return { error: "That Axon key isn't valid. Create a new one on the Dashboard." };
  const { tier } = await getTier(wallet);
  const conversationId = typeof args.conversation_id === "string" && args.conversation_id.trim() ? args.conversation_id.trim() : null;

  const events: MyloEvent[] = [];
  await runTurn({ owner: wallet, limitKey: wallet, addressKey: addressKeyOf(clientIp), wallet, speaker: tier.name, text: message, conversationId }, (e) => events.push(e), streamer);

  const conv = events.find((e): e is Extract<MyloEvent, { type: "conversation" }> => e.type === "conversation")?.id ?? conversationId;
  const error = events.find((e): e is Extract<MyloEvent, { type: "error" }> => e.type === "error");
  const answer = events.filter((e): e is Extract<MyloEvent, { type: "text" }> => e.type === "text").map((e) => e.delta).join("").trim();
  if (error && !answer) return { error: error.message, ...(conv ? { conversation_id: conv } : {}) };
  const link = conv ? `${siteUrl()}/mylo?c=${conv}` : `${siteUrl()}/mylo`;
  const proposals = events.filter((e): e is Extract<MyloEvent, { type: "action" }> => e.type === "action").map((e) => e.action);
  return {
    conversation_id: conv,
    answer,
    ...(error ? { cut_short: error.message } : {}),
    shown: shown(events.filter((e): e is Extract<MyloEvent, { type: "card" }> => e.type === "card").map((e) => e.card)),
    waiting_for_your_ok: proposals.map((p) => ({ what: p.summary, confirm_at: link })),
    open_on_the_site: link,
    ...(proposals.length ? { note: "Nothing has been spent, built or published. The person confirms each of these on the site, at confirm_at." } : {}),
  };
}

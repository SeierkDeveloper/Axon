// Agent Minds: a mind for a token launched before minds.
//
// A token launched through its own burn pot, before minds existed, can be given one by the wallet that launched it and
// by nobody else. Nothing about the token changes: its fees keep going where they always went, because that split was
// fixed when it launched. Its mind gets a treasury of its own, filled by whoever tops it up, and can spend it on
// buybacks through the token's own burn pot and on burning $AXON, inside limits its creator sets once.
//
// Rewards to holders are not open to these minds: a reward is divided by what each wallet holds, and Axon only counts
// a token's holders from the block its mind was given.

import { parseAbi } from "viem";
import { getDb } from "./db";
import { getAgentById } from "./agents";
import { mindsChain, mindLauncherAddress, type EarlierToken, type MindsChain } from "./mindsChain";
import { launchFactoryAddress } from "./agentLaunch";
import { DEFAULT_MIND_MODEL, OWN_MIND, isMindModel } from "./mindsModels";
import { checkOwnUrl, ownMindsOpen } from "./mindsOwn";
import { tokenOfAgent } from "./mindsStore";
import { normalizeAddress, sameAddress } from "./address";

/** What the creator's wallet signs. Must match MindLauncher.attachMind and its event. */
export const ATTACH_ABI = parseAbi([
  "function attachMind(address pot, (uint8 allowed,uint96 maxPerDay,uint96 maxPerAction,uint16 maxActionsPerDay,uint96 maxCostPerDay) limits) returns (address vault)",
  "event MindAttached(address indexed token, address indexed creator, address pot, address vault)",
]);

export interface AttachCheck { ok: boolean; reason: string | null; token: EarlierToken }

/** May this wallet give this token a mind? Read from the chain each time; nothing here is remembered. */
export async function checkAttach(wallet: string | null, token: string, chain: MindsChain = mindsChain, env: Record<string, string | undefined> = process.env): Promise<AttachCheck> {
  const launcher = mindLauncherAddress(env);
  const address = normalizeAddress(token);
  const none: EarlierToken = { token: (address ?? token).toLowerCase(), pot: null, dev: null, name: null, symbol: null, vault: null };
  if (!address) return { ok: false, reason: "That is not a token address.", token: none };
  if (!launcher) return { ok: false, reason: "Giving a token a mind is not open yet.", token: none };
  const t = await chain.earlierToken(address, launcher);
  const no = (reason: string): AttachCheck => ({ ok: false, reason, token: t });
  if (t.vault) return no("This token already has a mind.");
  if (!t.pot || !t.dev) return no("This token was not launched through a burn pot, so it cannot be given a mind.");
  if (!wallet) return no("Connect the wallet that launched this token.");
  if (!sameAddress(t.dev, wallet)) return no("Only the wallet that launched this token can give it a mind.");
  return { ok: true, reason: null, token: t };
}

/** The token a wallet launched through the earlier agent-token flow, checked the same way; or null when it has none. */
export async function suggestAttach(wallet: string, chain: MindsChain = mindsChain, env: Record<string, string | undefined> = process.env): Promise<AttachCheck | null> {
  const factory = launchFactoryAddress();
  if (!factory) return null;
  const token = await chain.earlierTokenOf(wallet, factory).catch(() => null);
  return token ? checkAttach(wallet, token, chain, env) : null;
}

export interface AttachRequest { token?: unknown; model?: unknown; mindUrl?: unknown; agentId?: unknown }

/**
 * Write down what a creator chose for the mind they are about to give their token. Returns the pot their transaction
 * names and the launcher it goes to, or why not.
 */
export async function prepareAttach(wallet: string, req: AttachRequest, chain: MindsChain = mindsChain, env: Record<string, string | undefined> = process.env): Promise<{ pot: string; token: string; launcher: string } | string> {
  const me = wallet.toLowerCase();
  const check = await checkAttach(me, String(req.token ?? ""), chain, env);
  if (!check.ok) return check.reason ?? "This token cannot be given a mind.";
  const own = req.model === OWN_MIND;
  if (!own && req.model !== undefined && req.model !== null && req.model !== "" && !isMindModel(req.model)) return "Pick one of the models on the list for its mind.";
  const model = own ? OWN_MIND : isMindModel(req.model) ? req.model : DEFAULT_MIND_MODEL;
  const badUrl = own ? (ownMindsOpen(env) ? checkOwnUrl(req.mindUrl) : "Running a mind on your own server is not open yet.") : null;
  if (badUrl) return badUrl;
  const agentId = typeof req.agentId === "string" && req.agentId.trim() ? req.agentId.trim() : null;
  if (agentId) {
    const agent = getAgentById(agentId);
    if (!agent || !sameAddress(agent.walletAddress, me)) return "That is not an agent of yours.";
    if (tokenOfAgent(agent.agentId)) return "That agent already has a token.";
  }
  getDb().prepare(
    "INSERT INTO mind_attaches (pot, wallet, token, agent_id, model, mind_url, created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(pot) DO UPDATE SET wallet = excluded.wallet, token = excluded.token, agent_id = excluded.agent_id, model = excluded.model, mind_url = excluded.mind_url, created_at = excluded.created_at",
  ).run(check.token.pot, me, check.token.token, agentId, model, own ? String(req.mindUrl).trim() : null, new Date().toISOString());
  return { pot: check.token.pot!, token: check.token.token, launcher: mindLauncherAddress(env)! };
}

export interface PreparedAttach { pot: string; wallet: string; token: string; agentId: string | null; model: string; mindUrl: string | null }

export function getAttach(pot: string): PreparedAttach | null {
  const r = getDb().prepare("SELECT pot, wallet, token, agent_id agentId, model, mind_url mindUrl FROM mind_attaches WHERE pot = ?").get(pot.toLowerCase()) as PreparedAttach | undefined;
  return r ?? null;
}

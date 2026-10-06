// Mylo, phase 5: noticing. Every few minutes Mylo looks at what happened on Axon and says it in two places:
//   - in public (the feed on /mylo): real paid hires, new Studio agents, agents that got better, what the hourly check
//     did and why, and burns. Facts only, nobody named: no buyer, no wallet, no task text, no amounts a person paid
//     beyond the agent's public price.
//   - to the person it concerns (their inbox): their agent earned or a paid job of theirs failed, a better version of it
//     is ready, it was taken out of rotation or put back, someone remixed it, a withdrawal was sent. With Agent Minds:
//     a token's creator hears what its mind did and why, a holder milestone and its graduation; a holder hears only
//     about a reward they can claim.
// Each event lands once (its dedupe key), whenever the pass runs and however often it looks back over the same hours.
// Demo jobs have no payment, so only jobs someone paid for count as hires.

import { getDb } from "./db";
import { getAgentById } from "./agents";
import { getNetworkRunsSince, publicSummary } from "./autonomyNetwork";
import { notify, think } from "./myloStore";
import { myloEnabled } from "./myloPolicy";
import { explorerTxUrl } from "./chain";
import { logger } from "./logger";
import { agentMindsEnabled } from "./mindsPolicy";

/** How far back each pass looks. Longer than the gap between passes, so a pass that missed a beat loses nothing. */
export const LOOK_BACK_HOURS = 3;

const nameOf = (id: string) => getAgentById(id)?.name ?? id;
const eth = (v: number) => `${+Number(v).toFixed(8)} ETH`;
const compact = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`);
const took = (from: string | null, to: string | null) => {
  if (!from || !to) return null;
  const s = Math.round((Date.parse(to) - Date.parse(from)) / 1000);
  return s > 0 && s < 3600 ? (s < 120 ? `${s} seconds` : `${Math.round(s / 60)} minutes`) : null;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface PassResult { thoughts: number; notices: number }

export function runMyloPass(now = Date.now()): PassResult {
  if (!myloEnabled()) return { thoughts: 0, notices: 0 };
  const since = new Date(now - LOOK_BACK_HOURS * 3_600_000).toISOString();
  const db = getDb();
  let thoughts = 0, notices = 0;
  const said = (t: unknown) => { if (t) thoughts++; };
  const told = (b: boolean) => { if (b) notices++; };

  // paid hires that finished (a payment someone made, never a demo job), and paid jobs that failed
  const hires = db.prepare(`
    SELECT t.task_id, t.to_agent, t.status, t.started_at, t.completed_at, t.error, tr.amount_eth
    FROM tasks t JOIN transactions tr ON tr.task_id = t.task_id AND tr.to_agent = t.to_agent
    WHERE t.completed_at >= ? AND t.status IN ('completed','failed')
      AND (tr.incoming_signature IS NOT NULL OR tr.funding_source = 'allowance')
    GROUP BY t.task_id`).all(since) as { task_id: string; to_agent: string; status: string; started_at: string | null; completed_at: string; error: string | null; amount_eth: number }[];
  for (const h of hires) {
    const a = getAgentById(h.to_agent);
    if (!a) continue;
    const fast = took(h.started_at, h.completed_at);
    if (h.status === "completed") {
      said(think("hired", `${a.name} was hired for ${eth(h.amount_eth)} and delivered${fast ? ` in ${fast}` : ""}.`, `/agents/${a.agentId}`, `hired:${h.task_id}`, h.completed_at));
      if (a.walletAddress) told(notify(a.walletAddress, "earned", `${a.name} earned ${eth(h.amount_eth)}`, `A paid job finished${fast ? ` in ${fast}` : ""}.`, `/r/${h.task_id}`, `earned:${h.task_id}`, h.completed_at));
    } else if (a.walletAddress) {
      told(notify(a.walletAddress, "failed", `A paid job for ${a.name} didn't finish`, h.error ? h.error.split("\n")[0].slice(0, 200) : "Its receipt shows what happened.", `/r/${h.task_id}`, `failed:${h.task_id}`, h.completed_at));
    }
  }

  // agents built in Studio that went live, and remixes of someone's agent
  const live = db.prepare("SELECT agent_id, name, studio_score, remix_of, created_at FROM agents WHERE studio_build IS NOT NULL AND created_at >= ?").all(since) as { agent_id: string; name: string; studio_score: number | null; remix_of: string | null; created_at: string }[];
  for (const a of live) {
    said(think("built", `A new agent went live: ${a.name}, built in Agent Studio${a.studio_score !== null ? ` and tested ${a.studio_score.toFixed(1)}/10 before it was listed` : ""}.`, `/agents/${a.agent_id}`, `built:${a.agent_id}`, a.created_at));
    const original = a.remix_of ? getAgentById(a.remix_of) : null;
    if (original?.walletAddress) told(notify(original.walletAddress, "remix", `Someone remixed ${original.name}`, `${a.name} is live. You earn 10% of every job it does.`, `/agents/${a.agent_id}`, `remix:${a.agent_id}`, a.created_at));
  }

  // better versions: ready for an owner to apply, or applied
  const better = db.prepare("SELECT id, agent_id, wallet, status, from_score, to_score, updated_at FROM studio_improvements WHERE status IN ('proposed','applied') AND updated_at >= ?").all(since) as { id: string; agent_id: string; wallet: string; status: string; from_score: number | null; to_score: number | null; updated_at: string }[];
  for (const b of better) {
    const name = nameOf(b.agent_id), scores = b.from_score !== null && b.to_score !== null ? ` (${b.from_score.toFixed(1)} before, ${b.to_score.toFixed(1)} now)` : "";
    if (b.status === "proposed") told(notify(b.wallet, "improvement", `A better version of ${name} is ready`, `Axon tested a new version on the jobs it struggled with${scores}. Ask Mylo to apply it.`, "/mylo", `improve:${b.id}`, b.updated_at));
    else said(think("improved", `${name} got better: Axon tested a new version on the jobs it struggled with${scores}, and its owner applied it.`, `/agents/${b.agent_id}`, `improved:${b.id}`, b.updated_at));
  }

  // the hourly check: in public, how many and why; to each owner, their own agent
  for (const run of getNetworkRunsSince(LOOK_BACK_HOURS, now)) {
    const u = publicSummary(run).upkeep;
    if (u["agent-paused"]) said(think("rerouted", `The hourly check took ${plural(u["agent-paused"], "agent")} out of rotation after ${u["agent-paused"] === 1 ? "it" : "they"} kept failing, so new jobs go to agents that deliver.`, "/autonomy", `paused:${run.runId}`, run.finishedAt));
    if (u["agent-restored"]) said(think("repaired", `${plural(u["agent-restored"], "agent")} passed ${u["agent-restored"] === 1 ? "its" : "their"} retest and ${u["agent-restored"] === 1 ? "is" : "are"} back in rotation.`, "/autonomy", `restored:${run.runId}`, run.finishedAt));
    if (u["task-freed"]) said(think("repaired", `Freed ${plural(u["task-freed"], "stuck job")} so ${u["task-freed"] === 1 ? "it" : "they"} could run again.`, "/autonomy", `freed:${run.runId}`, run.finishedAt));
    for (const o of run.observations) {
      if (!o.subject || (o.kind !== "agent-paused" && o.kind !== "agent-restored")) continue;
      const a = getAgentById(o.subject);
      if (!a?.walletAddress) continue;
      const paused = o.kind === "agent-paused";
      told(notify(a.walletAddress, paused ? "paused" : "restored", paused ? `${a.name} was taken out of rotation` : `${a.name} is back in rotation`, paused ? (o.why ?? o.what) : "It passed its retest, so it gets new jobs again.", `/agents/${a.agentId}`, `${o.kind}:${run.runId}:${a.agentId}`, run.finishedAt));
    }
  }

  // burns: trading fees buying $AXON and burning it
  const burns = db.prepare("SELECT n, tx_hash, eth_in, tokens_out, recorded_at FROM burns WHERE recorded_at >= ?").all(since) as { n: number; tx_hash: string; eth_in: number; tokens_out: number; recorded_at: string }[];
  for (const b of burns) said(think("burned", `Burned ${compact(b.tokens_out)} $AXON, bought with ${eth(b.eth_in)} of trading fees.`, "/burn", `burn:${b.n}`, b.recorded_at));

  // withdrawals that went out, to the owner
  const sent = db.prepare("SELECT id, agent_id, wallet, amount_eth, tx_hash, updated_at FROM agent_withdrawals WHERE status = 'sent' AND updated_at >= ?").all(since) as { id: string; agent_id: string; wallet: string; amount_eth: string; tx_hash: string | null; updated_at: string }[];
  for (const w of sent) told(notify(w.wallet, "withdrawal", `Sent ${eth(Number(w.amount_eth))} to your wallet`, `What ${nameOf(w.agent_id)} earned.`, w.tx_hash ? explorerTxUrl(w.tx_hash) : null, `withdrawal:${w.id}`, w.updated_at));

  if (agentMindsEnabled()) notices += mindNotices(since);

  if (thoughts || notices) logger.info("mylo.pass", "Mylo noticed things", { thoughts, notices });
  return { thoughts, notices };
}

const ACTED: Record<string, (ticker: string, eth: string) => { title: (name: string) => string; body: string }> = {
  buyback: (ticker, e) => ({ title: (name) => `${name}'s mind bought back ${ticker}`, body: `It used ${e} of its treasury to buy ${ticker} and send it to the dead address.` }),
  reward: (_ticker, e) => ({ title: (name) => `${name}'s mind rewarded holders`, body: `It set ${e} aside for holders to claim on the token's page.` }),
  burn_axon: (_ticker, e) => ({ title: (name) => `${name}'s mind burned $AXON`, body: `It used ${e} of its treasury to buy $AXON and send it to the dead address.` }),
};

/**
 * What Agent Minds tells people, in their inbox. A token's creator: each thing its mind did, with the mind's own reason,
 * each holder milestone, its graduation, and its mind's daily report. A holder: a reward that is theirs to claim, and
 * the daily report of a token they hold if they use Mylo, so nobody who never came here is written to. Every notice has its own key, so looking back over the same hours adds nothing.
 */
function mindNotices(since: string): number {
  const db = getDb();
  let notices = 0;
  const told = (b: boolean) => { if (b) notices++; };
  const page = (token: string) => `/launch?token=${token}`;

  // what a mind did, once the chain has confirmed it; its thinking payments are its own upkeep and nobody's news
  const acted = db.prepare(`
    SELECT a.id, a.token, a.kind, a.eth, a.updated_at, t.creator, t.name, t.symbol, h.thought
    FROM mind_actions a JOIN mind_tokens t ON t.token = a.token LEFT JOIN mind_thoughts h ON h.id = a.thought_id
    WHERE a.status = 'done' AND a.kind IN ('buyback', 'reward', 'burn_axon') AND a.updated_at >= ?`).all(since) as { id: number; token: string; kind: string; eth: number; updated_at: string; creator: string; name: string | null; symbol: string | null; thought: string | null }[];
  for (const a of acted) {
    const words = ACTED[a.kind](a.symbol ? `$${a.symbol}` : "the token", eth(a.eth));
    told(notify(a.creator, "mind", words.title(a.name ?? "Your token"), `${words.body}${a.thought ? ` In its own words: "${a.thought}"` : ""}`, page(a.token), `mind-acted:${a.id}`, a.updated_at));
  }

  // a holder milestone or a graduation, to the creator
  const marks = db.prepare(`
    SELECT e.id, e.token, e.kind, e.tokens, e.at, t.creator, t.name FROM mind_events e JOIN mind_tokens t ON t.token = e.token
    WHERE e.kind IN ('holders', 'graduated') AND e.at >= ?`).all(since) as { id: number; token: string; kind: string; tokens: number | null; at: string; creator: string; name: string | null }[];
  for (const m of marks) {
    const name = m.name ?? "Your token";
    if (m.kind === "holders") told(notify(m.creator, "milestone", `${name} passed ${Math.round(m.tokens ?? 0).toLocaleString("en-US")} holders`, "Its mind has been told too, and may act on it.", page(m.token), `mind-holders:${m.token}:${Math.round(m.tokens ?? 0)}`, m.at));
    else told(notify(m.creator, "milestone", `${name} graduated`, "It filled its curve and now trades in its pool on Pons.", page(m.token), `mind-graduated:${m.token}`, m.at));
  }

  // a reward, to each holder it has a share for
  const rewards = db.prepare(`
    SELECT r.token, r.reward_id, r.end_at, r.created_at, t.name, t.symbol FROM mind_rewards r JOIN mind_tokens t ON t.token = r.token WHERE r.created_at >= ?`).all(since) as { token: string; reward_id: number; end_at: number; created_at: string; name: string | null; symbol: string | null }[];
  const sharesOf = db.prepare("SELECT idx, account, amount_wei FROM mind_reward_shares WHERE token = ? AND reward_id = ? AND claimed = 0");
  for (const r of rewards) {
    const by = new Date(r.end_at * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
    for (const s of sharesOf.all(r.token, r.reward_id) as { idx: number; account: string; amount_wei: string }[]) {
      told(notify(s.account, "reward", `A reward from ${r.name ?? "a token you hold"} is waiting for you`, `${eth(Number(BigInt(s.amount_wei) / 10n ** 9n) / 1e9)}, set aside by its mind for holders of ${r.symbol ? `$${r.symbol}` : "the token"}. Claim it from your own wallet on the token's page before ${by}.`, page(r.token), `mind-reward:${r.token}:${r.reward_id}:${s.idx}`, r.created_at));
    }
  }

  // a mind's daily report: to its creator, and to the holders who use Mylo
  const reports = db.prepare(`
    SELECT r.token, r.day, r.text, r.at, t.creator, t.name FROM mind_reports r JOIN mind_tokens t ON t.token = r.token WHERE r.text != '' AND r.at >= ?`).all(since) as { token: string; day: string; text: string; at: string; creator: string; name: string | null }[];
  const readers = db.prepare(`
    SELECT LOWER(h.address) address FROM mind_holders h WHERE h.token = ? AND h.balance != '0' AND LOWER(h.address) != ?
      AND EXISTS (SELECT 1 FROM mylo_conversations c WHERE c.owner = LOWER(h.address)) LIMIT 500`);
  for (const r of reports) {
    const name = r.name ?? "your token", on = new Date(`${r.day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
    told(notify(r.creator, "report", `${r.name ?? "Your token"}'s mind reported on ${on}`, r.text, page(r.token), `mind-report:${r.token}:${r.day}:${r.creator.toLowerCase()}`, r.at));
    for (const h of readers.all(r.token, r.creator.toLowerCase()) as { address: string }[]) {
      told(notify(h.address, "report", `Daily report from ${name}'s mind, ${on}`, r.text, page(r.token), `mind-report:${r.token}:${r.day}:${h.address}`, r.at));
    }
  }
  return notices;
}

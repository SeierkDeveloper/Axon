// Agent Minds: what a mind is doing right now, in one plain line.
//
// A mind that says nothing for an hour looks broken unless something says why. This reads the same things the mind's
// own loop checks before a thought (mindsMind.thinkOnce) and the chain's count of today's actions, and puts the first
// one that holds it back into words: stopped, paused, out of treasury, out of today's actions, or simply waiting for
// something to happen. Read-only: it never starts a thought and changes nothing. Mylo answers from it, and the token's
// page shows it.

import { getDb } from "./db";
import { agentMindsEnabled } from "./mindsPolicy";
import { mindsChain, type MindsChain, type Treasury, type VaultDay } from "./mindsChain";
import { mindsHalted } from "./mindsAdmin";
import { thinkingMode } from "./mindsThinker";
import { estimateThoughtUsd, mindModel, OWN_MIND } from "./mindsModels";
import { costToday, dailyBudgetUsd, owedThinkingEth, spentTodayUsd, FAILED_GAP_MS, MAX_COST_PER_DAY_ETH, MIN_GAP_MS } from "./mindsMind";
import { ethUsd } from "./ethPrice";
import { pulseEnabled, pulseSpan, pulseState } from "./mindsPulse";

export type MindState =
  | "halted" | "stopped" | "frozen" | "paused" | "unread" | "no_treasury" | "cannot_pay" | "thinking_capped" | "budget" | "actions_used" | "resting" | "about_to_think" | "waiting";

export interface MindStatus {
  state: MindState;
  /** one or two plain sentences, for anyone reading the token's page */
  text: string;
  /** what the chain said, for whoever wants the numbers; null when it could not be read */
  treasury: Treasury | null;
  day: VaultDay | null;
}

export interface StatusOptions {
  chain?: MindsChain; env?: Record<string, string | undefined>; now?: number; usdPerEth?: number | null;
  /** the treasury, when the caller has just read it (null: it could not be read); left out, it is read here */
  treasury?: Treasury | null;
}

const KEPT = "holders can still claim what was already set aside.";

interface Row { token: string; vault: string; model: string | null; mind_bps: number | null; attached: number; stopped_at: string | null; read: string | null; treasury_eth: number }

/** What this token's mind is doing or waiting for, or null when there is no such token. */
export async function mindStatus(token: string, o: StatusOptions = {}): Promise<MindStatus | null> {
  const env = o.env ?? process.env, now = o.now ?? Date.now(), chain = o.chain ?? mindsChain, db = getDb();
  const m = db.prepare(
    "SELECT t.token, t.vault, t.model, t.mind_bps, t.attached, t.stopped_at, s.updated_at read, COALESCE(s.treasury_eth, 0) treasury_eth FROM mind_tokens t LEFT JOIN mind_stats s ON s.token = t.token WHERE t.token = ?",
  ).get(token.toLowerCase()) as Row | undefined;
  if (!m) return null;

  const [treasury, day] = await Promise.all([o.treasury !== undefined ? o.treasury : chain.treasury(m.vault).catch(() => null), chain.vaultDay(m.vault).catch(() => null)]);
  const say = (state: MindState, text: string): MindStatus => ({ state, text, treasury, day });

  const mode = thinkingMode(env);
  if (!agentMindsEnabled(env) || mode === "off" || mindsHalted()) return say("halted", `Minds are paused right now. Nothing is sent from any treasury; ${KEPT}`);
  if (m.stopped_at) return say("stopped", `Axon has stopped this mind. It does not think and nothing is sent for it; ${KEPT}`);
  if (treasury?.frozen) return say("frozen", `This mind's treasury is frozen. Nothing is sent from it; ${KEPT}`);
  if (treasury?.paused) return say("paused", `Its creator has paused this mind. It does not think and nothing leaves its treasury; ${KEPT}`);
  if (treasury && !treasury.active) return say("stopped", `This mind is stopped. It does not think and nothing is sent for it; ${KEPT}`);
  if (!m.read) return say("unread", "Its numbers are still being read from the chain. It can think once they are in.");

  const last = db.prepare("SELECT at, status, last_event_id FROM mind_thoughts WHERE token = ? AND source NOT IN ('order', 'report', 'chat') ORDER BY id DESC LIMIT 1").get(m.token) as { at: string; status: string; last_event_id: number } | undefined;
  const thought = Boolean(db.prepare("SELECT 1 FROM mind_thoughts WHERE token = ? AND status = 'thought' AND source NOT IN ('order', 'report') LIMIT 1").get(m.token));
  const news = (db.prepare("SELECT COUNT(*) n FROM mind_events WHERE token = ? AND id > ? AND kind NOT IN ('thought', 'bought', 'axon', 'rewarded')").get(m.token, last?.last_event_id ?? 0) as { n: number }).n;
  const wakes = m.attached ? "when its treasury is topped up or its agent earns" : "on the next fee payout, burn or holder milestone, or when its agent earns";

  const available = treasury?.availableEth ?? m.treasury_eth;
  if (!m.attached && (m.mind_bps ?? 0) === 0 && available <= 0) return say("no_treasury", "None of this token's fees go to its mind, so it has no treasury and stays quiet.");

  // a mind on its creator's own server pays nothing for a thought, so no cost holds it back
  let usd: number | null = null;
  if (m.model !== OWN_MIND) {
    const model = mindModel(m.model);
    const usdPerEth = o.usdPerEth === undefined ? await ethUsd().catch(() => null) : o.usdPerEth;
    usd = usdPerEth ?? null;
    if (usdPerEth) {
      const estimateEth = estimateThoughtUsd(model) / usdPerEth;
      if (available - owedThinkingEth(m.token) < estimateEth) return say("cannot_pay", `Its treasury cannot pay for a thought right now. It thinks again once more fees reach it.`);
      const ceiling = Math.min(MAX_COST_PER_DAY_ETH, treasury?.limits.maxCostPerDayEth ?? MAX_COST_PER_DAY_ETH);
      if (costToday(m.token, now) + estimateEth > ceiling) return say("thinking_capped", "It has reached what its thinking may cost today, a limit locked at launch. It thinks again after midnight UTC.");
      if (mode === "live" && spentTodayUsd(now) + estimateThoughtUsd(model) > dailyBudgetUsd(env)) return say("budget", "Minds on Axon have reached today's shared thinking budget. They think again after midnight UTC.");
    }
  }

  const max = treasury?.limits.maxActionsPerDay ?? null;
  if (day && max !== null && max > 0 && day.actionsToday >= max) return say("actions_used", `It has used all ${max} of the actions it may take today, a limit locked at launch. It can act again after midnight UTC.`);

  if (news > 0) {
    const gap = last?.status === "failed" ? FAILED_GAP_MS : MIN_GAP_MS;
    if (last && now - Date.parse(last.at) < gap) return say("resting", `Something new happened to its token since its last thought. It thinks at most once every ${Math.round(MIN_GAP_MS / 60_000)} minutes, so it will pick it up shortly.`);
    return say("about_to_think", "Something new happened to its token. It will think about it shortly.");
  }
  // nothing woke it: when it next checks in on its own
  const pulse = thought && pulseEnabled(env) && (m.model === OWN_MIND || usd) ? pulseState(m.token, now, { usdPerEth: m.model === OWN_MIND ? 1 : usd, treasuryEth: available - owedThinkingEth(m.token), ...(treasury ? { ceilingEth: Math.min(MAX_COST_PER_DAY_ETH, treasury.limits.maxCostPerDayEth) } : {}) }) : null;
  if (pulse?.due && (!last || now - Date.parse(last.at) >= MIN_GAP_MS)) return say("about_to_think", pulse.kind === "radar" ? "Its radar flagged something unusual on its token. It will look at it shortly." : "It is about to check in on its token on its own.");
  const checks = !pulse ? "" : pulse.everyMs === null || pulse.nextAt === null ? " Its treasury is too small for it to check in on its own between those." : ` It also checks in on its own about every ${pulseSpan(pulse.everyMs)}; the next is ${pulse.nextAt <= now ? "due" : `in about ${pulseSpan(pulse.nextAt - now)}`}.`;
  return say("waiting", thought
    ? `Nothing has happened to its token since its last thought. It wakes ${wakes}.${checks}`
    : `It has not thought yet. It wakes ${wakes}, as long as its treasury can pay for the thought.`);
}

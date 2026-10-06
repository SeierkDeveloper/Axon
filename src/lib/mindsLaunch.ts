// Agent Minds: what the launch screen signs.
//
// One transaction to the launcher makes the token, its burn pot, its fee splitter and its mind's treasury. Everything
// the creator chooses rides in that one call and nothing in it can be changed afterwards, so the screen shows exactly
// what this file builds before anybody signs. No Node imports: the browser builds the call from the same code the
// tests check against the contract's own source.

import { isAddress, parseAbi, parseEther } from "viem";
import { isMindModel } from "./mindsModels";

/** Must match MindLauncher.LaunchInput field for field and in order: once encoded the struct is positional. */
export const MIND_LAUNCH_ABI = parseAbi([
  "function launch((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,bytes32 salt,bytes32 agentRef,uint16 taxBps,address payout,uint16 creatorBps,uint16 burnBps,uint16 axonBps,uint16 mindBps,(uint8 allowed,uint96 maxPerDay,uint96 maxPerAction,uint16 maxActionsPerDay,uint96 maxCostPerDay) limits) in_) payable returns (address token)",
  "event Launched(address indexed token, address indexed creator, bytes32 indexed agentRef, address pot, address splitter, address vault, address payout, uint16 taxBps, uint16 creatorBps, uint16 burnBps, uint16 axonBps, uint16 mindBps)",
]);

/** The ceilings the contracts enforce. A launch past any of them reverts, so the form never offers one. */
export const CEILINGS = { taxBps: 1000, actionsPerDay: 24, costPerDayEth: 0.01 } as const;

/** What a mind may do with its treasury, as the treasury's own bit flags. */
export const CAN = { buyback: 1, reward: 2, burnAxon: 4 } as const;

export interface LaunchSettings {
  /** the tax on every trade, in hundredths of a percent */
  taxBps: number;
  /** where the fees go; the creator's own share is whatever these three leave */
  burnBps: number;
  axonBps: number;
  mindBps: number;
  /** the wallet the creator's share is paid to */
  payout: string;
  canBuyback: boolean;
  canReward: boolean;
  canBurnAxon: boolean;
  /** the most the mind may spend in a day, and in one action, in ETH */
  maxPerDayEth: string;
  maxPerActionEth: string;
  maxActionsPerDay: number;
  /** the most its thinking may cost in a day, in ETH */
  maxCostPerDayEth: string;
  /** the creator's own first buy in the launch transaction, in ETH; any size, or nothing */
  openingBuyEth: string;
  twitter: string;
  website: string;
}

/**
 * What the form opens with: no tax, and nothing taken out of the fees for anything. The creator chooses every number
 * themselves; nothing is decided for them.
 */
export const DEFAULT_SETTINGS: Omit<LaunchSettings, "payout"> = {
  taxBps: 0,
  burnBps: 0,
  axonBps: 0,
  mindBps: 0,
  canBuyback: true,
  canReward: true,
  canBurnAxon: true,
  maxPerDayEth: "0.05",
  maxPerActionEth: "0.01",
  maxActionsPerDay: 24,
  maxCostPerDayEth: "0.01",
  openingBuyEth: "",
  twitter: "",
  website: "",
};

export const creatorBps = (s: Pick<LaunchSettings, "burnBps" | "axonBps" | "mindBps">): number => 10_000 - s.burnBps - s.axonBps - s.mindBps;

const eth = (v: string): bigint | null => {
  const t = v.trim();
  if (!t) return 0n;
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  try { return parseEther(t); } catch { return null; }
};
const whole = (n: number) => Number.isInteger(n) && n >= 0;
const link = (v: string) => !v.trim() || /^https:\/\/\S+$/.test(v.trim());

/** Why these settings cannot launch, in words the form shows, or null when they can. */
export function checkSettings(s: LaunchSettings): string | null {
  if (!whole(s.taxBps) || s.taxBps > CEILINGS.taxBps) return "The tax is between 0 and 10%.";
  if (![s.burnBps, s.axonBps, s.mindBps].every(whole) || creatorBps(s) < 0) return "The shares have to add up to 100%.";
  if (!isAddress(s.payout.trim())) return "The payout wallet is not a wallet address.";
  if (/^0x0{40}$/i.test(s.payout.trim())) return "The payout wallet cannot be the zero address.";
  const perDay = eth(s.maxPerDayEth), perAction = eth(s.maxPerActionEth), cost = eth(s.maxCostPerDayEth), buy = eth(s.openingBuyEth);
  if (perDay === null || perAction === null) return "The mind's limits are amounts of ETH.";
  if (perAction > perDay) return "One action cannot be more than the whole day's limit.";
  if (!whole(s.maxActionsPerDay) || s.maxActionsPerDay > CEILINGS.actionsPerDay) return `A mind acts at most ${CEILINGS.actionsPerDay} times a day.`;
  if (cost === null || cost > parseEther(String(CEILINGS.costPerDayEth))) return `Thinking costs at most ${CEILINGS.costPerDayEth} ETH a day.`;
  if (buy === null) return "Your first buy is an amount of ETH.";
  if (!link(s.twitter) || !link(s.website)) return "Links start with https://";
  return null;
}

export interface LaunchMeta { name: string; symbol: string; logo: string; description: string }

/** The struct the launcher takes. `ref` is the reference Axon handed out for this launch; it is the salt too. */
export function launchInput(meta: LaunchMeta, ref: `0x${string}`, s: LaunchSettings) {
  return {
    name: meta.name,
    symbol: meta.symbol,
    logo: meta.logo,
    description: meta.description,
    socials: { twitter: s.twitter.trim(), telegram: "", discord: "", website: s.website.trim(), farcaster: "" },
    salt: ref,
    agentRef: ref,
    taxBps: s.taxBps,
    payout: s.payout.trim() as `0x${string}`,
    creatorBps: creatorBps(s),
    burnBps: s.burnBps,
    axonBps: s.axonBps,
    mindBps: s.mindBps,
    limits: {
      allowed: (s.canBuyback ? CAN.buyback : 0) | (s.canReward ? CAN.reward : 0) | (s.canBurnAxon ? CAN.burnAxon : 0),
      maxPerDay: eth(s.maxPerDayEth) ?? 0n,
      maxPerAction: eth(s.maxPerActionEth) ?? 0n,
      maxActionsPerDay: s.maxActionsPerDay,
      maxCostPerDay: eth(s.maxCostPerDayEth) ?? 0n,
    },
  } as const;
}

export type MindLimits = Pick<LaunchSettings, "canBuyback" | "canReward" | "canBurnAxon" | "maxPerDayEth" | "maxPerActionEth" | "maxActionsPerDay" | "maxCostPerDayEth">;

/** Why these limits cannot be set, in words, or null when they can: the same ceilings the treasury enforces. */
export function checkLimits(s: MindLimits): string | null {
  const perDay = eth(s.maxPerDayEth), perAction = eth(s.maxPerActionEth), cost = eth(s.maxCostPerDayEth);
  if (perDay === null || perAction === null) return "The mind's limits are amounts of ETH.";
  if (perAction > perDay) return "One action cannot be more than the whole day's limit.";
  if (!whole(s.maxActionsPerDay) || s.maxActionsPerDay > CEILINGS.actionsPerDay) return `A mind acts at most ${CEILINGS.actionsPerDay} times a day.`;
  if (cost === null || cost > parseEther(String(CEILINGS.costPerDayEth))) return `Thinking costs at most ${CEILINGS.costPerDayEth} ETH a day.`;
  return null;
}

/** A treasury's limits as its contract takes them. */
export function mindLimits(s: MindLimits) {
  return {
    allowed: (s.canBuyback ? CAN.buyback : 0) | (s.canReward ? CAN.reward : 0) | (s.canBurnAxon ? CAN.burnAxon : 0),
    maxPerDay: eth(s.maxPerDayEth) ?? 0n,
    maxPerAction: eth(s.maxPerActionEth) ?? 0n,
    maxActionsPerDay: s.maxActionsPerDay,
    maxCostPerDay: eth(s.maxCostPerDayEth) ?? 0n,
  } as const;
}

// ── Settings carried in a link ────────────────────────────────────────────────

/**
 * Settings a link to the launch screen can carry, so the screen opens with them filled in: what Mylo worked out with
 * the creator in conversation. Only what was chosen is carried; the rest keeps the screen's own defaults. Nothing here
 * launches anything: the creator still reads every number on the screen and signs it themselves.
 */
export interface LinkedSettings {
  settings: Partial<Omit<LaunchSettings, "payout">>;
  /** the payout wallet, when another than the launching one was chosen */
  payout?: string;
  /** the model the mind runs on */
  model?: string;
}

/** The steps the screen's own sliders move in: a number from a link lands on one, as if it had been dragged there. */
export const STEPS = { taxBps: 50, shareBps: 100 } as const;

const AMOUNT = /^\d{1,6}(\.\d{1,18})?$/;
const snap = (v: number, step: number) => Math.round(v / step) * step;

/** The link's query for these settings, as key and value pairs. */
export function settingsQuery(l: LinkedSettings): [string, string][] {
  const s = l.settings, q: [string, string][] = [];
  const put = (k: string, v: string | number | boolean | undefined) => { if (v !== undefined && v !== "") q.push([k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)]); };
  // "tomind", not "mind": the launch page already reads ?mind= as "give an earlier token a mind"
  put("tax", s.taxBps); put("burn", s.burnBps); put("axon", s.axonBps); put("tomind", s.mindBps);
  put("buyback", s.canBuyback); put("reward", s.canReward); put("burnaxon", s.canBurnAxon);
  put("day", s.maxPerDayEth); put("action", s.maxPerActionEth); put("actions", s.maxActionsPerDay); put("think", s.maxCostPerDayEth);
  put("buy", s.openingBuyEth); put("x", s.twitter); put("web", s.website);
  put("payout", l.payout); put("ai", l.model);
  return q;
}

/**
 * Read settings back out of a link. A link is something anybody can write, so every value is checked on its own and
 * one that is not a plain, in-range number, switch, amount, link or address is left out, as if it had not been there.
 */
export function readSettingsQuery(get: (key: string) => string | undefined): LinkedSettings {
  const settings: LinkedSettings["settings"] = {};
  const int = (k: string, max: number, step = 1) => { const v = get(k); if (v === undefined || !/^\d{1,5}$/.test(v)) return undefined; const n = snap(Number(v), step); return n <= max ? n : undefined; };
  const flag = (k: string) => { const v = get(k); return v === "1" ? true : v === "0" ? false : undefined; };
  // as long as the screen's own boxes take, and no longer
  const amount = (k: string) => { const v = get(k)?.trim(); return v !== undefined && v.length <= 12 && AMOUNT.test(v) ? v : undefined; };
  const url = (k: string) => { const v = get(k)?.trim(); return v && v.length <= 200 && /^https:\/\/[^\s<>"']+$/.test(v) ? v : undefined; };

  const tax = int("tax", CEILINGS.taxBps, STEPS.taxBps);
  if (tax !== undefined) settings.taxBps = tax;
  // the three shares only make sense together: if they would leave the creator less than nothing, none of them is kept
  const shares = { burnBps: int("burn", 10_000, STEPS.shareBps), axonBps: int("axon", 10_000, STEPS.shareBps), mindBps: int("tomind", 10_000, STEPS.shareBps) };
  if ((shares.burnBps ?? 0) + (shares.axonBps ?? 0) + (shares.mindBps ?? 0) <= 10_000) {
    for (const [k, v] of Object.entries(shares) as [keyof typeof shares, number | undefined][]) if (v !== undefined) settings[k] = v;
  }
  const can = { canBuyback: flag("buyback"), canReward: flag("reward"), canBurnAxon: flag("burnaxon") };
  for (const [k, v] of Object.entries(can) as [keyof typeof can, boolean | undefined][]) if (v !== undefined) settings[k] = v;
  const eths = { maxPerDayEth: amount("day"), maxPerActionEth: amount("action"), maxCostPerDayEth: amount("think"), openingBuyEth: amount("buy") };
  for (const [k, v] of Object.entries(eths) as [keyof typeof eths, string | undefined][]) if (v !== undefined) settings[k] = v;
  const actions = int("actions", CEILINGS.actionsPerDay);
  if (actions !== undefined) settings.maxActionsPerDay = actions;
  const twitter = url("x"), website = url("web");
  if (twitter) settings.twitter = twitter;
  if (website) settings.website = website;

  const payout = get("payout")?.trim(), model = get("ai")?.trim();
  return {
    settings,
    ...(payout && isAddress(payout) && !/^0x0{40}$/i.test(payout) ? { payout } : {}),
    ...(isMindModel(model) ? { model } : {}),
  };
}

/** Whether a link carried any settings at all. */
export const hasLinkedSettings = (l: LinkedSettings): boolean => Object.keys(l.settings).length > 0 || Boolean(l.payout) || Boolean(l.model);

/** What every token launched here says about where it came from, at the end of its description. */
export const LAUNCHED_ON = "Launched on Axon.";

/**
 * The description a token carries on chain: the creator's own line about its agent, then where it was launched. A
 * token launched for an agent that already exists has no line, so its name stands in for one.
 */
export function tokenDescription(line: string, name: string): string {
  const said = line.replace(/\s+/g, " ").trim() || name.trim();
  return `${said}${/[.!?]$/.test(said) ? "" : "."} ${LAUNCHED_ON}`;
}

/** What the launch transaction carries: the launch factory's own fee, plus the creator's first buy. */
export function launchValue(feeWei: bigint, s: Pick<LaunchSettings, "openingBuyEth">): bigint {
  return feeWei + (eth(s.openingBuyEth) ?? 0n);
}

const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** What is locked at launch, line by line, as the screen states it before the signature. */
export function lockedSummary(symbol: string, s: LaunchSettings): { label: string; value: string }[] {
  const ticker = `$${symbol || "TOKEN"}`;
  const does = [s.canBuyback && `buy back and burn ${ticker}`, s.canReward && "reward holders", s.canBurnAxon && "burn $AXON"].filter(Boolean) as string[];
  return [
    { label: "Tax on every trade", value: pct(s.taxBps) },
    { label: `To you (${isAddress(s.payout.trim()) ? short(s.payout.trim()) : "your wallet"})`, value: pct(creatorBps(s)) },
    { label: `Burns ${ticker}`, value: pct(s.burnBps) },
    { label: "Burns $AXON", value: pct(s.axonBps) },
    { label: "To the mind", value: pct(s.mindBps) },
    { label: "The mind may", value: does.length ? does.join(", ") : "only think" },
    { label: "Its limits", value: `${s.maxPerDayEth || "0"} ETH a day, ${s.maxPerActionEth || "0"} ETH an action, ${s.maxActionsPerDay} actions a day` },
    { label: "Its thinking", value: `at most ${s.maxCostPerDayEth || "0"} ETH a day, paid from its own treasury` },
    { label: "To Axon", value: "0%" },
  ];
}

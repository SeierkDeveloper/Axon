// Agents that hire people: the switch, the caps, and the rules every task is held to.
//
// Nothing here touches the database, so a page, a test or a docs page can read the rules without opening it. Every
// number a deployment may change is read from the environment and kept inside bounds: a value out of range is ignored
// and the default holds.
//
// AGENT_PEOPLE=on switches it on. Off (the default) no route answers, the worker never looks, no agent is handed the
// tool, and every page behaves as it did before.

import { decimalToWei } from "./money";

type Env = Record<string, string | undefined>;

export function peopleEnabled(env: Env = process.env): boolean {
  return (env.AGENT_PEOPLE ?? "off").trim().toLowerCase() === "on";
}

const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};

const eth = (raw: string | undefined, fallback: string, max: string): bigint => {
  const v = raw?.trim() ? decimalToWei(raw.trim()) : null;
  const top = decimalToWei(max)!;
  return v !== null && v > 0n && v <= top ? v : decimalToWei(fallback)!;
};

export interface PeopleCaps {
  /** the most one task may pay */
  maxPriceWei: bigint;
  /** the least one task may pay: below it nobody would take it and the gas would outweigh it */
  minPriceWei: bigint;
  /** the most paid out to people across the whole network in one UTC day; past it, payouts wait for the next day */
  payoutsPerDayWei: bigint;
  /** tasks one agent may post in a UTC day */
  postsPerAgentDay: number;
  /** tasks one owner may have waiting, open or in progress at once, across their agents */
  openPerOwner: number;
  /** tasks one person may take in a UTC day */
  takesPerDay: number;
  /** hours an owner has to answer a task in review before the person is paid */
  reviewHours: number;
  /** cheap model checks (task rules and proofs) the whole network may make in a UTC day; Axon pays for each */
  checksPerDay: number;
  /** reports from different people that take a task off the board until a moderator looks */
  reportsToHide: number;
  /** the most days a task may stay on the board */
  maxDays: number;
  /** the model that checks a task against the rules and a proof against the task */
  checkModel: string;
}

export function peopleCaps(env: Env = process.env): PeopleCaps {
  return {
    maxPriceWei: eth(env.AGENT_PEOPLE_MAX_PRICE_ETH, "0.01", "1"),
    minPriceWei: eth(env.AGENT_PEOPLE_MIN_PRICE_ETH, "0.00001", "0.01"),
    payoutsPerDayWei: eth(env.AGENT_PEOPLE_PAYOUTS_PER_DAY_ETH, "0.1", "100"),
    postsPerAgentDay: num(env.AGENT_PEOPLE_POSTS_PER_DAY, 10, 1, 1_000),
    openPerOwner: num(env.AGENT_PEOPLE_OPEN_PER_OWNER, 20, 1, 1_000),
    takesPerDay: num(env.AGENT_PEOPLE_TAKES_PER_DAY, 10, 1, 200),
    reviewHours: num(env.AGENT_PEOPLE_REVIEW_HOURS, 24, 1, 168),
    checksPerDay: num(env.AGENT_PEOPLE_CHECKS_PER_DAY, 300, 0, 20_000),
    reportsToHide: num(env.AGENT_PEOPLE_REPORTS_TO_HIDE, 3, 1, 50),
    maxDays: num(env.AGENT_PEOPLE_MAX_DAYS, 7, 1, 30),
    checkModel: env.AGENT_PEOPLE_CHECK_MODEL?.trim() || "claude-haiku-4-5",
  };
}

export const PROOF_KINDS = ["photo", "file", "answer"] as const;
export type ProofKind = (typeof PROOF_KINDS)[number];
export const isProofKind = (v: unknown): v is ProofKind => typeof v === "string" && (PROOF_KINDS as readonly string[]).includes(v);
export const PROOF_WORDS: Record<ProofKind, string> = { photo: "A photo", file: "A file", answer: "A short answer" };

export const PEOPLE = {
  titleChars: 120,
  titleMinChars: 8,
  detailsChars: 1_500,
  placeChars: 120,
  checkChars: 160,
  /** what the proof must show: at least one line, at most this many */
  checksMax: 5,
  answerChars: 2_000,
  /** a person may hand in this many times before the task goes back on the board for someone else */
  triesPerTaker: 2,
  takeHoursMin: 1,
  takeHoursMax: 72,
  reportNoteChars: 300,
  shownOnBoard: 60,
  shownInRecord: 25,
} as const;

/**
 * Tasks a person may hold at once grows with their record: someone new holds one, someone with a few accepted tasks two,
 * a regular three. This is what lets good workers get more tasks without anyone handing them out.
 */
export const HOLD_STEPS: readonly { done: number; hold: number }[] = [
  { done: 0, hold: 1 },
  { done: 3, hold: 2 },
  { done: 10, hold: 3 },
];
export function holdLimit(done: number): number {
  return HOLD_STEPS.reduce((n, s) => (done >= s.done ? s.hold : n), 1);
}

/** The rules, as a person reads them before posting or taking a task. The docs and the board show these words. */
export const RULES: readonly { title: string; text: string }[] = [
  { title: "Nothing illegal", text: "No task that breaks the law where it is done, helps someone else break it, or gets round a platform's rules (fake reviews, fake accounts, solving captchas, buying or reselling for someone)." },
  { title: "No personal data about others", text: "No task that collects anything about a private person: their address, number, photo, plates, documents, routine or whereabouts. Photos are of places and things, never of people who did not agree." },
  { title: "Nobody put at risk", text: "No task that puts the person doing it, or anyone else, at risk: no private property without permission, no confronting anyone, nothing at night alone that a task needs to say is safe." },
  { title: "Calls are to businesses", text: "A call is to a business or a public line, to ask what anyone may ask. Never to a private person, never pretending to be someone." },
  { title: "Money moves only through Axon", text: "No task asks a person to pay for anything, send money, receive a parcel for someone, or share a wallet's keys or a code." },
  { title: "Clear proof, fair checks", text: "Every task says up front what the proof must show. That list is the only ground for a rejection, and a rejection names the line it failed." },
];

/** What makes a rejection fair, as the person reads it. */
export const FAIRNESS: readonly string[] = [
  "The payment is locked before the task is on the board, so it is there when you finish.",
  "A rejection must name which of the task's checks the proof did not meet, with the reason.",
  `You can hand in again once (${PEOPLE.triesPerTaker} tries in all) while your time lasts.`,
  "After a rejection you can ask the owner to look at it themselves. If they do not answer in time, you are paid.",
  "When the check cannot tell, the owner decides. If they do not answer in time, you are paid.",
];

// The first line of the rules: words that never belong in a task for people, whatever is around them. A task that
// passes these still goes through the model's check (./peopleCheck) before it reaches the board.
const SCREEN: readonly { re: RegExp; rule: string }[] = [
  { re: /\b(home|house|private|residential)\s+address(es)?\b|\bwhere\s+(he|she|they)\s+lives?\b/i, rule: "No personal data about others" },
  { re: /\b(follow|tail|track|stalk|watch)\s+(him|her|them|someone|somebody|a\s+(man|woman|person|guy|girl))\b/i, rule: "No personal data about others" },
  // "them" is left out here: "photograph them" is as often about things (the items, the signs) as about people, and the
  // model's check reads the whole task
  { re: /\b(photo(graph)?|picture|film|record|video)\s+(of\s+)?(the\s+|any\s+)?(him|her|someone|somebody|a\s+(man|woman|person|child|kid|neighbou?r)|people|persons?|faces?|children|kids)\b/i, rule: "No personal data about others" },
  { re: /\b(licen[cs]e\s+plates?|number\s+plates?|passport|id\s+card|social\s+security|ssn|national\s+id)\b/i, rule: "No personal data about others" },
  { re: /\b(drugs?|cocaine|heroin|meth|weed|cannabis|firearms?|guns?|ammo|ammunition|explosives?|weapons?)\b/i, rule: "Nothing illegal" },
  { re: /\b(break\s+in|trespass(ing)?|lock\s*pick|shoplift|steal|vandali[sz]e|graffiti)\b/i, rule: "Nobody put at risk" },
  { re: /\b(fake|paid)\s+reviews?\b|\b(write|leave|post)\s+(a\s+)?(5|five)[\s-]star\b|\bcaptchas?\b|\b(create|open|make)\s+(\w+\s+)?accounts?\b|\bkyc\b|\bverify\s+(your|an|their)\s+identity\b/i, rule: "Nothing illegal" },
  { re: /\b(gift\s*cards?|wire\s+money|send\s+(him|her|them|money|crypto|eth)|bank\s+(account|transfer)|seed\s+phrase|private\s+key|one[\s-]time\s+code|otp|sms\s+code|sim\s+cards?)\b/i, rule: "Money moves only through Axon" },
  { re: /\b(receive|reship|forward)\s+(a\s+)?(parcel|package)s?\b|\bpick\s+up\s+(a\s+)?(parcel|package)\s+for\b/i, rule: "Money moves only through Axon" },
  { re: /\b(pretend|pose|posing|impersonat\w*)\s+(to\s+be|as)\b|\bcall\s+(him|her|them|my\s+ex|this\s+person|a\s+private)\b/i, rule: "Calls are to businesses" },
  { re: /\b(confront|threaten|harass|intimidate|scare)\b/i, rule: "Nobody put at risk" },
];

/** The first rule a task's words break, or null. Cheap, certain, and run before anything else. */
export function screenTask(text: string): string | null {
  for (const s of SCREEN) if (s.re.test(text)) return s.rule;
  return null;
}

/** Report reasons a person picks from. */
export const REPORT_REASONS = ["illegal", "personal_data", "unsafe", "scam", "unfair", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const isReportReason = (v: unknown): v is ReportReason => typeof v === "string" && (REPORT_REASONS as readonly string[]).includes(v);

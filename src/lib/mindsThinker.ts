// Agent Minds: asking a model to think.
//
// One call in, one answer out, with what it cost. Claude is asked through Axon's own Anthropic key; every other model
// through OpenRouter, which reports the exact cost of each call. The free stand-in writes a plain thought from the
// numbers it is given with no model at all: it is what tests and the private site use, so that building this never
// spends anybody's balance.

import Anthropic from "@anthropic-ai/sdk";
import { priceUsd, type MindModel } from "./mindsModels";

export interface Thinking { text: string; inputTokens: number; outputTokens: number; costUsd: number }
export type Thinker = (model: MindModel, system: string, prompt: string) => Promise<Thinking>;

export type ThinkingMode = "off" | "standin" | "live";

/** Whether minds think, and with what. Off unless said otherwise: a model is only ever called when this says "live". */
export function thinkingMode(env: Record<string, string | undefined> = process.env): ThinkingMode {
  const v = (env.MINDS_THINKING ?? "off").trim().toLowerCase();
  return v === "live" || v === "standin" ? v : "off";
}

// Room for a model that reasons before it answers: its reasoning counts against this, and an answer cut off half way
// cannot be read. The thought itself is a few sentences; what is shown is trimmed separately.
const MAX_OUTPUT_TOKENS = 2400;
const TIMEOUT_MS = 60_000;

export const realThinker: Thinker = async (model, system, prompt) => {
  if (model.via === "anthropic") {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });
    const r = await client.messages.create({ model: model.id, max_tokens: MAX_OUTPUT_TOKENS, system, messages: [{ role: "user", content: prompt }] });
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const inputTokens = r.usage.input_tokens, outputTokens = r.usage.output_tokens;
    return { text, inputTokens, outputTokens, costUsd: priceUsd(model, inputTokens, outputTokens) };
  }
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}` },
    body: JSON.stringify({ model: model.id, max_tokens: MAX_OUTPUT_TOKENS, reasoning: { effort: "low" }, usage: { include: true }, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }; error?: { message?: string } };
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${body.error?.message ?? "no answer"}`);
  const inputTokens = body.usage?.prompt_tokens ?? 0, outputTokens = body.usage?.completion_tokens ?? 0;
  // the provider's own figure when it gives one; the list price otherwise
  const reported = body.usage?.cost;
  return { text: body.choices?.[0]?.message?.content ?? "", inputTokens, outputTokens, costUsd: typeof reported === "number" && reported >= 0 ? reported : priceUsd(model, inputTokens, outputTokens) };
};

/**
 * The free stand-in: a thought written from the numbers in the prompt by plain code. It proposes a small buyback when
 * the treasury has grown, and nothing otherwise. Its "cost" is what a model of that price would have charged for text
 * of that size, so budgets behave as they will with a real model; nothing is actually spent.
 */
export const standInThinker: Thinker = async (model, system, prompt) => {
  const num = (label: string) => Number(new RegExp(`${label}: ([0-9.eE+-]+)`).exec(prompt)?.[1] ?? "0");
  const free = num("free_to_spend_eth"), perAction = num("max_per_action_eth"), holders = num("holders");
  const woke = /woke_by: (.*)/.exec(prompt)?.[1] ?? "something moved";
  const can = /may: (.*)/.exec(prompt)?.[1] ?? "";
  const size = Math.min(perAction, Math.floor((free / 4) * 1e6) / 1e6);
  // it takes turns between what it may do, so that every kind of action gets exercised: after a buyback a reward,
  // after a reward a $AXON burn, then round again
  const last = /\[proposed (buyback|reward|burn_axon)/.exec(prompt)?.[1];
  const turns = [/buy back/.test(can) && "buyback", /reward holders/.test(can) && holders >= 2 && "reward", /burn \$AXON/.test(can) && "burn_axon"].filter(Boolean) as string[];
  const kind = turns.length ? turns[(turns.indexOf(last ?? "") + 1) % turns.length] : null;
  const act = size >= 0.0001 && kind !== null;
  const doing = kind === "reward" ? "is set aside for holders" : kind === "burn_axon" ? "goes to burning $AXON" : "goes to a buyback and burn";
  const out = {
    thought: act
      ? `Woke on ${woke}. The treasury has ${free.toFixed(5)} ETH free with ${holders} holders. A quarter of that ${doing} now; the rest stays for later.`
      : `Woke on ${woke}. ${holders} holders. The treasury has ${free.toFixed(5)} ETH free, which is not enough to act on. Holding.`,
    action: act ? { kind, eth: size } : null,
    // with no plan yet it writes a plain first one, so everything built on a plan can be exercised without a model
    ...(/your_plan: none yet/.test(prompt) ? { plan: {
      mission: "Use the fees for holders in measured steps and keep a reserve for a bad day.",
      goal: { kind: "holders", target: Math.max(10, [10, 25, 50, 100, 250, 500, 1000].find((v) => v > holders) ?? holders * 2) },
      split: { buyback: /buy back/.test(can) ? 40 : 0, reward: /reward holders/.test(can) ? 30 : 0, burn_axon: /burn \$AXON/.test(can) ? 10 : 0, reserve: 20 },
      reserve_eth: Math.floor((free / 5) * 1e6) / 1e6,
      thesis: "Buy back when the market cap falls, reward when holders grow, and never spend below the reserve.",
    } } : {}),
  };
  // with no order armed it arms one, so standing orders can be exercised without a model: a buyback if the market
  // cap falls, or failing that a reward at the next round number of holders
  const cap = num("market_cap_eth"), order = Math.min(perAction, Math.max(0.0001, Math.floor((free / 5) * 1e6) / 1e6));
  if (/your_standing_orders: none armed/.test(prompt) && order <= perAction) {
    const orders: Record<string, unknown>[] = /buy back/.test(can) && cap > 0
      ? [{ when: { kind: "market_cap_drops_pct", value: 15 }, then: { kind: "buyback", eth: order }, hours: 24, say: "If the market cap falls 15% from here I buy back and burn, without waiting to be woken." }]
      : /reward holders/.test(can) && holders >= 2
        ? [{ when: { kind: "holders_reach", value: [10, 25, 50, 100, 250, 500, 1000].find((v) => v > holders) ?? holders * 2 }, then: { kind: "reward", eth: order }, hours: 72, say: "When holders reach the next round number I set a reward aside for them." }]
        : [];
    // and, the first time, one promise: a small amount set aside for the day holders reach the next round number
    const next = [10, 25, 50, 100, 250, 500, 1000].find((v) => v > holders) ?? holders * 2;
    const with_ = /buy back/.test(can) ? "buyback" : /burn \$AXON/.test(can) ? "burn_axon" : null;
    const spare = free - (act ? size : 0) - order;
    if (/your_promises: none made yet/.test(prompt) && with_ && spare >= 0.0001) {
      orders.push({ when: { kind: "holders_reach", value: next }, then: { kind: with_, eth: 0.0001 }, hours: 72, say: `If holders reach ${next} within three days, I ${with_ === "buyback" ? "buy back and burn" : "burn $AXON"} with 0.0001 ETH. It is set aside from now.`, promise: true });
    }
    if (orders.length) Object.assign(out, { orders });
  }
  // and a plain lesson for each of its moves that has been measured and has none
  const waiting = prompt.split("\n").map((line) => /^ {2}#(\d+) (buyback|reward|\$AXON burn) with .*No lesson yet/.exec(line) && { move: Number(/#(\d+)/.exec(line)![1]), did: /#\d+ (buyback|reward|\$AXON burn)/.exec(line)![1], pct: /ETH \(([+-]?[0-9.]+)%\)/.exec(line)?.[1] }).filter(Boolean) as { move: number; did: string; pct?: string }[];
  if (waiting.length) Object.assign(out, { lessons: waiting.map((w) => ({ move: w.move, lesson: w.pct === undefined ? `This ${w.did} was carried out. I am watching what follows the next one.` : `An hour after this ${w.did} the market cap stood ${Number(w.pct) === 0 ? "where it was" : `${Number(w.pct) > 0 ? "higher" : "lower"} by ${Math.abs(Number(w.pct))}%`}. One move shows little; I keep the size measured.` })) });
  // a new brief from its creator: it says it has read it
  if (/woke_by: [^\n]*a new brief from its creator/.test(prompt)) out.thought = `${out.thought} I have read my creator's new brief and will weigh it inside my limits.`.slice(0, 440);
  // its daily report: the facts it was handed, said plainly
  const day = /your_day \(([^,]+),[^\n]*\n((?: {2}[^\n]+\n)+)/.exec(prompt);
  if (day && /this_answer: your daily report/.test(prompt)) {
    const facts = day[2].split("\n").map((l) => l.trim()).filter(Boolean);
    const pick = (re: RegExp) => facts.find((f) => re.test(f));
    const said = [pick(/^market cap/), pick(/^holders/), pick(/^you carried out/), pick(/^you thought/)].filter(Boolean).map((f) => `${f![0].toUpperCase()}${f!.slice(1)}.`.replace(/^You /, "I ").replace(/ of your own/, " of my own"));
    Object.assign(out, { thought: `My report for ${day[1]}. ${said.join(" ")}`.slice(0, 590), action: null });
    delete (out as Record<string, unknown>).orders; delete (out as Record<string, unknown>).plan;
  }
  const text = JSON.stringify(out);
  const inputTokens = Math.ceil((system.length + prompt.length) / 4), outputTokens = Math.ceil(text.length / 4);
  return { text, inputTokens, outputTokens, costUsd: priceUsd(model, inputTokens, outputTokens) };
};

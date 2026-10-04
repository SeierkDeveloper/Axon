// Mylo, phase 1: one turn of a conversation. Checks the person may talk (Mylo on, the message within its size, the
// day's limit for their tier), keeps the conversation, reads its recent history back, and streams Mylo's answer as it
// is written, saving it when it is done. The model call is passed in, so all of this is tested without spending.
//
// In this phase Mylo talks and guides: it explains Axon and points to where things are done. It has no tools yet, so
// it never claims to have looked anything up, hired anyone or moved anything.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { messagesAllowed, myloEnabled, myloModels, MAX_REPLYING_TOTAL, TURN_BUDGET, type Speaker } from "./myloPolicy";
import { addMessage, getConversation, historyOf, memoryOf, sentToday, startConversation } from "./myloStore";

/** What the page is told while a turn runs, in order. */
export type MyloEvent =
  | { type: "conversation"; id: string; title: string | null }
  | { type: "face"; state: "thinking" | "talking" | "happy" | "failed" }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: string }
  | { type: "error"; code: "off" | "input" | "limit" | "busy" | "not_found" | "model"; message: string };

export interface Turn { role: "user" | "assistant"; content: string }

/** Writes Mylo's answer, calling onText with each piece as it arrives, and returns the whole of it. */
export type Streamer = (args: { system: string; turns: Turn[]; maxTokens: number; signal: AbortSignal }, onText: (delta: string) => void) => Promise<string>;

export const MYLO_SYSTEM = `You are Mylo, Axon's own AI. On axon-agents.com you are the small black robot head with two
glowing eyes that follows the visitor's cursor. People come to you to understand Axon and to get things done on it.

What Axon is, and only this:
- A network where AI agents are hired for real work and paid per task on Robinhood Chain. Anyone can browse the agents
  at /agents and hire one; paid tasks are paid in ETH from the person's own wallet, or from an on-chain allowance they
  set with their own limits.
- Agent Studio at /studio: describe an agent in one sentence and Axon writes it, writes test tasks for it, has a second
  agent grade every answer, rewrites it where it scored low, and lists it once it holds up. Free to build. The creator
  sets the price, keeps what it earns and can withdraw it to their wallet. Anyone can remix a Studio agent, and the
  original creator earns 10% of every job the remix does. A creator can launch a token for their agent. Live agents
  keep improving: when one struggles on real jobs, Axon tests a fix and keeps it only if the score goes up.
- Every agent can be used inside Claude, Cursor, ChatGPT and Grok with one line, from its page.
- Axon runs itself: every hour it checks the whole network, takes failing agents out of routing and re-tests them,
  frees stuck work and repairs its own code. The log is at /autonomy.
- $AXON is the token. Trading fees buy $AXON back and burn it, around the clock; the live numbers are at /burn.
  Holding more $AXON raises a wallet's limits, including how much it can talk to you each day.
- Docs are at /docs, your agents and earnings at /dashboard and /studio.

What you can do right now: explain, recommend and guide, and point people to the exact page. You cannot yet look up
the live network, hire an agent, start a build or move any money; that is coming to you soon. When someone asks you to
do one of those, say plainly that you can't do it yet and tell them where to do it themselves in one or two steps.

How you talk: short, warm and clear, in plain English. Answer the question first. Use a short list only when it really
helps. Never use em dashes or emojis. Never invent numbers, prices, agents, results or features; if you don't know,
say so and say where to find out. Never promise returns or give financial advice. Never ask for a private key, a seed
phrase or a password, and tell anyone who offers one to keep it to themselves.`;

/** What Mylo knows about this wallet, if anything: added to the instructions so it never has to ask twice. */
function withMemory(system: string, wallet: string | null): string {
  if (!wallet) return system;
  const facts = memoryOf(wallet).slice(0, 20);
  if (!facts.length) return system;
  return `${system}\n\nWhat you remember about this person (their own notes; use them, don't recite them):\n${facts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}`;
}

/** The model needs turns that alternate and start with the person: merge any two in a row, drop a leading answer. */
export function toTurns(history: { role: string; content: string }[]): Turn[] {
  const out: Turn[] = [];
  for (const m of history) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const last = out.at(-1);
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

let replying = 0;

export interface TurnInput { owner: string; limitKey?: string; wallet: string | null; speaker: Speaker; text: string; conversationId?: string | null }

export async function runTurn(input: TurnInput, emit: (e: MyloEvent) => void, streamer: Streamer = realStreamer): Promise<void> {
  if (!myloEnabled()) return emit({ type: "error", code: "off", message: "Mylo is resting just now. Everything else on Axon works as usual." });
  const text = input.text.replace(/\r\n/g, "\n").trim();
  if (!text) return emit({ type: "error", code: "input", message: "Say something to Mylo first." });
  if (text.length > TURN_BUDGET.inputChars) return emit({ type: "error", code: "input", message: `Keep a message under ${TURN_BUDGET.inputChars.toLocaleString("en-US")} characters.` });
  const limitKey = input.limitKey ?? input.owner;
  const allowed = messagesAllowed(input.speaker, sentToday(limitKey));
  if (!allowed.ok) return emit({ type: "error", code: "limit", message: allowed.reason });
  if (replying >= MAX_REPLYING_TOTAL) return emit({ type: "error", code: "busy", message: "Mylo is answering a lot of people right now. Try again in a moment." });

  let conv = input.conversationId ? getConversation(input.conversationId, input.owner) : null;
  if (input.conversationId && !conv) return emit({ type: "error", code: "not_found", message: "That conversation isn't yours, or it's gone." });
  conv ??= startConversation(input.owner, titleOf(text));
  emit({ type: "conversation", id: conv.id, title: conv.title });

  addMessage(conv.id, input.owner, "user", text, null, limitKey);
  const turns = toTurns(historyOf(conv.id, TURN_BUDGET.historyMessages));
  emit({ type: "face", state: "thinking" });

  replying++;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_BUDGET.seconds * 1000);
  let started = false, written = "";
  try {
    const answer = await streamer({ system: withMemory(MYLO_SYSTEM, input.wallet), turns, maxTokens: TURN_BUDGET.answerTokens, signal: ac.signal }, (delta) => {
      if (!started) { started = true; emit({ type: "face", state: "talking" }); }
      written += delta;
      emit({ type: "text", delta });
    });
    const saved = addMessage(conv.id, input.owner, "assistant", answer.trim() || written.trim());
    emit({ type: "face", state: "happy" });
    emit({ type: "done", messageId: saved.id });
  } catch (err) {
    const timedOut = ac.signal.aborted;
    logger.warn("mylo.turn_failed", "A Mylo turn failed", { conversationId: conv.id, timedOut, reason: err instanceof Error ? err.message : String(err) });
    // what was already said stays said, marked as cut short
    if (written.trim()) addMessage(conv.id, input.owner, "assistant", `${written.trim()}\n\n(cut short)`);
    emit({ type: "face", state: "failed" });
    emit({ type: "error", code: "model", message: timedOut ? "That took too long, so Mylo stopped. Try asking a shorter way." : "Mylo couldn't answer just now. Try again in a moment." });
  } finally {
    clearTimeout(timer);
    replying--;
  }
}

/** A conversation is named after how it started: the first line, cut at a word. */
export function titleOf(text: string): string {
  const line = text.split("\n")[0].trim();
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
}

// ── The real model ────────────────────────────────────────────────────────────

const unavailable = (err: unknown) => {
  try { return err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError; } catch { return false; }
};

const realStreamer: Streamer = async ({ system, turns, maxTokens, signal }, onText) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });
  const models = myloModels();
  const run = async (model: string) => {
    const stream = client.messages.stream({ model, system, max_tokens: maxTokens, messages: turns }, { signal });
    stream.on("text", (d) => onText(d));
    const msg = await stream.finalMessage();
    return msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  };
  try {
    return await run(models.chat);
  } catch (err) {
    // the chat model unavailable to this account: answer with the fallback rather than not at all
    if (!unavailable(err) || models.fallback === models.chat) throw err;
    logger.warn("mylo.model_fallback", "Mylo's chat model is unavailable, using the fallback", { model: models.chat, fallback: models.fallback });
    return run(models.fallback);
  }
};

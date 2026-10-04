// Mylo, phase 1: one turn of a conversation. Checks the person may talk (Mylo on, the message within its size, the
// day's limit for their tier), keeps the conversation, reads its recent history back, and streams Mylo's answer as it
// is written, saving it when it is done. The model call is passed in, so all of this is tested without spending.
//
// Mylo works with tools (myloTools): it looks things up on the live network and shows them as cards, and it proposes
// hires that the person confirms and pays for in the page. A turn may call tools a bounded number of times; the last
// call is made with tools off, so every turn ends in words.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { messagesAllowed, myloEnabled, myloModels, MAX_REPLYING_TOTAL, TURN_BUDGET, type Speaker } from "./myloPolicy";
import { addMessage, getConversation, historyOf, memoryOf, sentToday, startConversation } from "./myloStore";
import { MYLO_TOOL_DEFS, runTool, forModel, type Card } from "./myloTools";
import { getAction, viewOf } from "./myloActions";

/** What the page is told while a turn runs, in order. */
export type MyloEvent =
  | { type: "conversation"; id: string; title: string | null }
  | { type: "face"; state: "thinking" | "working" | "talking" | "happy" | "failed" }
  | { type: "tool"; name: string; label: string }
  | { type: "card"; card: Card }
  | { type: "action"; action: ReturnType<typeof viewOf> }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: string }
  | { type: "error"; code: "off" | "input" | "limit" | "busy" | "not_found" | "model"; message: string };

export interface Turn { role: "user" | "assistant"; content: string }

/** One block of what the model said: words, or a tool it wants to use. */
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
/** What goes to the model: the conversation so far, including this turn's tool calls and their results. */
export type ModelMessage = { role: "user" | "assistant"; content: string | ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean })[] };

/** One call to the model: streams its words through onText and returns all it said, and whether it wants tools. */
export type Streamer = (args: { system: string; messages: ModelMessage[]; tools: boolean; maxTokens: number; signal: AbortSignal }, onText: (delta: string) => void) => Promise<{ blocks: Block[]; stop: string }>;

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

What you can do with your tools:
- search_agents, agent_details, compare_agents: look at the live network and help people pick an agent by its tested
  score, track record and price. Always search before recommending; never recommend an agent you have not looked up.
- network_pulse and public_feed: say how the network is doing, from the real numbers.
- hire_agent and second_opinion: PROPOSE a hire. Proposing spends nothing: the page shows the person the exact agent,
  task and price, and they confirm and pay from their own wallet or allowance. After proposing, say what you proposed
  and that it waits for their OK. Never say a hire is done, paid or running, and never pretend to have an agent's
  answer: it arrives in the conversation when the agent finishes. Write the task for the agent fully and clearly.
- Before proposing, make sure you know what the person wants done. If it is unclear, ask one short question first.
- Hiring needs the person signed in with their wallet; if a tool says so, tell them to sign in.

What you cannot do yet: build agents in Studio, look at someone's own agents or earnings, or withdraw. Point them to
/studio or /dashboard for those. Never promise a refund or say money will come back; if a hire fails, say so and that
its receipt shows what happened.

How you talk: short, warm and clear, in plain English. Answer the question first. Use a short list only when it really
helps. Never use em dashes or emojis. Never name your tools to the person (say "I can compare them", not the tool's
name). Your earlier messages note the agents you showed and their ids: use those ids instead of searching again. Never invent numbers, prices, agents, results or features; if you don't know,
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

/** An earlier answer as the model rereads it: with the agents it showed, so it can act on them without searching again. */
export function forHistory(m: { role: string; content: string; meta?: unknown }): { role: string; content: string } {
  const cards = ((m.meta ?? {}) as { cards?: { kind: string; agents?: { agentId: string; name: string; priceEth: number | null }[] }[] }).cards ?? [];
  const shown = [...new Map(cards.flatMap((c) => c.agents ?? []).map((a) => [a.agentId, a])).values()];
  if (m.role !== "assistant" || !shown.length) return { role: m.role, content: m.content };
  return { role: m.role, content: `${m.content}\n\n[Agents shown: ${shown.map((a) => `${a.name} (id ${a.agentId}, ${a.priceEth === null ? "free" : `${a.priceEth} ETH`})`).join("; ")}]` };
}

/**
 * Takes em dashes out of Mylo's words as they stream. A dash can arrive with its spaces split across pieces, so the
 * spaces and dashes at the end of each piece wait for the next one.
 */
export function dashCleaner() {
  const fix = (s: string) => s.replace(/\s*\u2014[\s\u2014]*/g, ", ");
  let held = "";
  return {
    push(delta: string): string {
      const s = held + delta;
      const m = /[\s\u2014]*$/.exec(s)!;
      held = m[0];
      return fix(s.slice(0, m.index));
    },
    flush(): string { const h = fix(held); held = ""; return h; },
  };
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
  const turns = toTurns(historyOf(conv.id, TURN_BUDGET.historyMessages).map(forHistory));
  emit({ type: "face", state: "thinking" });

  replying++;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_BUDGET.seconds * 1000);
  const system = withMemory(MYLO_SYSTEM, input.wallet);
  const messages: ModelMessage[] = turns.map((t) => ({ role: t.role, content: t.content }));
  const cards: Card[] = [], actionIds: string[] = [];
  let talking = false, written = "", toolsUsed = 0;
  const clean = dashCleaner();
  try {
    for (;;) {
      // the last call has tools off, so a turn always ends in words
      const tools = toolsUsed < TURN_BUDGET.toolCalls;
      const res = await streamer({ system, messages, tools, maxTokens: TURN_BUDGET.answerTokens, signal: ac.signal }, (delta) => {
        if (!talking) { talking = true; emit({ type: "face", state: "talking" }); }
        const out = clean.push(delta);
        if (!out) return;
        written += out;
        emit({ type: "text", delta: out });
      });
      const uses = res.blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      if (!tools || res.stop !== "tool_use" || uses.length === 0) break;
      messages.push({ role: "assistant", content: res.blocks.map((b) => (b.type === "text" ? { type: "text" as const, text: b.text } : { type: "tool_use" as const, id: b.id, name: b.name, input: b.input })) });
      const results: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = [];
      for (const u of uses) {
        toolsUsed++;
        talking = false;
        const rest = clean.flush();
        if (rest) { written += rest; emit({ type: "text", delta: rest }); }
        if (written && !written.endsWith("\n")) { written += "\n\n"; emit({ type: "text", delta: "\n\n" }); }
        emit({ type: "face", state: "working" });
        const out = await runTool(u.name, u.input ?? {}, { wallet: input.wallet, owner: input.owner, conversationId: conv.id });
        emit({ type: "tool", name: u.name, label: out.label });
        if (out.card) { cards.push(out.card); emit({ type: "card", card: out.card }); }
        if (out.actionId) {
          const act = getAction(out.actionId, input.owner);
          if (act) { actionIds.push(act.id); emit({ type: "action", action: viewOf(act) }); }
        }
        const isError = typeof out.result === "object" && out.result !== null && "error" in out.result;
        results.push({ type: "tool_result", tool_use_id: u.id, content: forModel(out.result), ...(isError ? { is_error: true } : {}) });
      }
      messages.push({ role: "user", content: results });
    }
    const saved = addMessage(conv.id, input.owner, "assistant", written.trim(), cards.length || actionIds.length ? { cards, actionIds } : null);
    emit({ type: "face", state: "happy" });
    emit({ type: "done", messageId: saved.id });
  } catch (err) {
    const timedOut = ac.signal.aborted;
    logger.warn("mylo.turn_failed", "A Mylo turn failed", { conversationId: conv.id, timedOut, reason: err instanceof Error ? err.message : String(err) });
    // what was already said (and any cards or proposals made) stays, marked as cut short
    if (written.trim() || cards.length || actionIds.length) addMessage(conv.id, input.owner, "assistant", `${written.trim()}\n\n(cut short)`.trim(), cards.length || actionIds.length ? { cards, actionIds } : null);
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

const realStreamer: Streamer = async ({ system, messages, tools, maxTokens, signal }, onText) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });
  const models = myloModels();
  const run = async (model: string) => {
    const stream = client.messages.stream({
      model, system, max_tokens: maxTokens,
      messages: messages as Anthropic.MessageParam[],
      tools: MYLO_TOOL_DEFS as unknown as Anthropic.Tool[],
      tool_choice: tools ? { type: "auto" } : { type: "none" },
    }, { signal });
    stream.on("text", (d) => onText(d));
    const msg = await stream.finalMessage();
    const blocks: Block[] = msg.content.flatMap((b): Block[] => (b.type === "text" ? [{ type: "text", text: b.text }] : b.type === "tool_use" ? [{ type: "tool_use", id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : []));
    return { blocks, stop: msg.stop_reason ?? "end_turn" };
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

// Mylo, phase 1: one turn of a conversation. Checks the person may talk (Mylo on, the message within its size, the
// day's limit for their tier), keeps the conversation, reads its recent history back, and streams Mylo's answer as it
// is written, saving it when it is done. The model call is passed in, so all of this is tested without spending.
//
// Mylo works with tools (myloTools): it looks things up on the live network and shows them as cards, and it proposes
// hires that the person confirms and pays for in the page. A turn may call tools a bounded number of times; the last
// call is made with tools off, so every turn ends in words.
//
// Cost: Mylo talks to signed-in wallets only. The model is chosen per message ($AXON holders get the better one while
// the day's budget allows), and every call reserves its upper bound from the day's budget before it is made and
// records its real cost after (myloBudget), so Mylo can't spend past the budget however many people talk at once.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { messagesAllowed, modelFor, myloEnabled, myloModels, MAX_REPLYING_TOTAL, TURN_BUDGET, type Speaker, type Usage } from "./myloPolicy";
import { addMessage, getConversation, historyOf, memoryOf, sentFromAddress, sentToday, startConversation } from "./myloStore";
import { budgetShare, reserveCall, settleCall, type Hold } from "./myloBudget";
import { MYLO_TOOL_DEFS, runTool, forModel, type Card } from "./myloTools";
import { actionsOf, getAction, viewOf, type Action, type BuildDetail, type PublishDetail } from "./myloActions";

/** What the page is told while a turn runs, in order. */
export type MyloEvent =
  | { type: "conversation"; id: string; title: string | null }
  | { type: "face"; state: "thinking" | "working" | "talking" | "happy" | "failed" }
  | { type: "tool"; name: string; label: string }
  | { type: "card"; card: Card }
  | { type: "action"; action: ReturnType<typeof viewOf> }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: string }
  | { type: "error"; code: "off" | "signin" | "input" | "limit" | "budget" | "busy" | "not_found" | "model"; message: string };

export interface Turn { role: "user" | "assistant"; content: string }

/** One block of what the model said: words, or a tool it wants to use. */
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
/** What goes to the model: the conversation so far, including this turn's tool calls and their results. */
export type ModelMessage = { role: "user" | "assistant"; content: string | ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean })[] };

/** One call to the model: streams its words through onText and returns all it said, whether it wants tools, and what
 *  the call used (the model that answered and its own token counts), which is what the budget records. */
export type Streamer = (args: { model: string; system: string; messages: ModelMessage[]; tools: boolean; maxTokens: number; signal: AbortSignal }, onText: (delta: string) => void) => Promise<{ blocks: Block[]; stop: string; model?: string; usage?: Usage }>;

/** The size of a call in bytes, as sent: a token is never less than a byte, so this bounds what it can be billed. */
export const requestBytes = (system: string, messages: ModelMessage[]) => Buffer.byteLength(JSON.stringify({ system, messages, tools: MYLO_TOOL_DEFS }), "utf8");

/** The conversation as the model rereads it: each message cut to a length, and only as much recent history as fits. */
export function fitHistory(turns: Turn[]): Turn[] {
  const cut = turns.map((t) => (t.content.length > TURN_BUDGET.historyMessageChars ? { ...t, content: `${t.content.slice(0, TURN_BUDGET.historyMessageChars)}…(cut)` } : t));
  let total = 0, from = cut.length;
  while (from > 0 && total + cut[from - 1].content.length <= TURN_BUDGET.historyChars) total += cut[--from].content.length;
  const kept = cut.slice(Math.min(from, cut.length - 1));
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return kept;
}

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
- An agent whose price is "Free" costs nothing to hire; propose it like any other.
- hire_agent and second_opinion: PROPOSE a hire. Proposing spends nothing: the page shows the person the exact agent,
  task and price, and they confirm and pay from their own wallet or allowance. After proposing, say what you proposed
  and that it waits for their OK. Never say a hire is done, paid or running, and never pretend to have an agent's
  answer: it arrives in the conversation when the agent finishes. Write the task for the agent fully and clearly.
- Only say you proposed, set up or started something after a tool did it in this turn. The page shows a card only
  for what a tool created; never describe a button or card that wasn't made. Your earlier messages end with notes in
  square brackets of what you set up and its ids and status; use them.
- Before proposing, make sure you know what the person wants done. If it is unclear, ask one short question first.
- Hiring needs the person signed in with their wallet; if a tool says so, tell them to sign in.

Building agents with Agent Studio:
- build_agent: PROPOSE a new build from one sentence (what the agent does and for whom). Ask first if the purpose is
  unclear, then write a clear sentence. The page shows a Build it button; after they tap it Studio writes the agent and
  tests it, which takes a few minutes, and the result (score and weakest test) arrives in the conversation by itself.
  Never say it is built, tested or scored before that message.
- change_build: when they ask for a change to one of their builds that isn't live, make it; it is tested again and the
  new score arrives by itself. Don't guess scores.
- build_report: their builds, and for one build its score per round and its weakest tests with the grader's feedback.
  Coach from that: name the weakest test, say plainly why it scored low, and suggest one concrete change you can make
  for them. Offer it; don't make changes they didn't ask for.
- pricing_advice: what similar agents charge, with their scores and track records. Recommend a price with the reason,
  from those numbers. A new agent with no jobs yet usually wins first hires at or below the middle price.
- publish_build: PROPOSE listing a tested build (it needs a score of 6 or more) at a price. Nothing is listed until
  they tap Publish. Once live, what it earns is theirs.

What you cannot do yet: look at someone's live agents' earnings, or withdraw. Point them to /dashboard and /studio for
those. Never promise a refund or say money will come back; if a hire fails, say so and that its receipt shows what
happened.

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
/**
 * What the conversation's own words don't carry, for the model alone: the agents Mylo showed (with their ids) and what
 * it set up (with ids and where each has got to). It goes in the instructions, not into Mylo's past messages, so Mylo
 * never copies it into what people read.
 */
export function contextOf(history: { role: string; meta?: unknown }[], actions: Action[]): string {
  const shown = new Map<string, { agentId: string; name: string; priceEth: number | null }>();
  for (const m of history) {
    if (m.role !== "assistant") continue;
    const meta = (m.meta ?? {}) as { cards?: { agents?: { agentId: string; name: string; priceEth: number | null }[] }[] };
    for (const a of (meta.cards ?? []).flatMap((c) => c.agents ?? [])) shown.set(a.agentId, a);
  }
  const lines: string[] = [];
  if (shown.size) lines.push(`Agents you showed in this conversation: ${[...shown.values()].map((a) => `${a.name} (id ${a.agentId}, ${a.priceEth === null ? "free" : `${a.priceEth} ETH`})`).join("; ")}.`);
  if (actions.length) lines.push(`What you set up in this conversation, oldest first:\n${actions.map((a) => `- ${noteOf(a)}`).join("\n")}`);
  return lines.length ? `\n\nFor you only, never quote it:\n${lines.join("\n")}` : "";
}

/** One proposal as the model rereads it: what it is, its ids and where it has got to. */
export function noteOf(a: Action): string {
  if (a.kind === "build") { const d = a.detail as BuildDetail; return `build${d.name ? ` of ${d.name}` : ""}, build_id ${d.buildId ?? "none yet"}, ${a.status}${d.stage ? `, Studio stage ${d.stage}` : ""}${d.score !== null ? `, scored ${d.score}` : ""}${d.change ? `, after the change "${d.change}"` : ""}`; }
  if (a.kind === "publish") { const d = a.detail as PublishDetail; return `publish ${d.name} (build_id ${d.buildId}) at ${d.priceEth} ETH, ${a.status}${d.agentId ? `, live as /agents/${d.agentId}` : ""}`; }
  return `hire of ${a.hires.map((h) => `${h.name} (id ${h.agentId})`).join(", ")}, ${a.status}`;
}

/** Words that say Mylo set something up. Said with no tool called, they would promise a card that isn't there. */
const CLAIMS = /\bI(?:'ve| have)? (?:just )?(?:proposed|set (?:it|this|that) up|set up|prepared|queued)\b|\bpage now shows\b/i;

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

export interface TurnInput { owner: string; limitKey?: string; addressKey?: string | null; wallet: string | null; speaker: Speaker; text: string; conversationId?: string | null }

const RESTING = "Mylo has done all the talking it can for today and is resting until midnight UTC. Everything else on Axon works as usual.";

export async function runTurn(input: TurnInput, emit: (e: MyloEvent) => void, streamer: Streamer = realStreamer): Promise<void> {
  if (!myloEnabled()) return emit({ type: "error", code: "off", message: "Mylo is resting just now. Everything else on Axon works as usual." });
  const text = input.text.replace(/\r\n/g, "\n").trim();
  if (!text) return emit({ type: "error", code: "input", message: "Say something to Mylo first." });
  if (text.length > TURN_BUDGET.inputChars) return emit({ type: "error", code: "input", message: `Keep a message under ${TURN_BUDGET.inputChars.toLocaleString("en-US")} characters.` });
  if (input.speaker === "guest" || !input.wallet) return emit({ type: "error", code: "signin", message: "Sign in with your wallet to talk to Mylo. It's free." });
  const limitKey = input.limitKey ?? input.owner;
  const allowed = messagesAllowed(input.speaker, sentToday(limitKey), input.addressKey ? sentFromAddress(input.addressKey) : 0);
  if (!allowed.ok) return emit({ type: "error", code: "limit", message: allowed.reason });
  if (replying >= MAX_REPLYING_TOTAL) return emit({ type: "error", code: "busy", message: "Mylo is answering a lot of people right now. Try again in a moment." });

  let conv = input.conversationId ? getConversation(input.conversationId, input.owner) : null;
  if (input.conversationId && !conv) return emit({ type: "error", code: "not_found", message: "That conversation isn't yours, or it's gone." });

  // what the first call will read, so its cost can be held before anything is saved or started
  const model = modelFor(input.speaker, budgetShare());
  const past = conv ? historyOf(conv.id, TURN_BUDGET.historyMessages - 1) : [];
  const system = withMemory(MYLO_SYSTEM, input.wallet) + contextOf(past, conv ? actionsOf(conv.id, input.owner) : []);
  const earlier = past.map((m) => ({ role: m.role, content: m.content }));
  const messages: ModelMessage[] = fitHistory(toTurns([...earlier, { role: "user", content: text }])).map((t) => ({ role: t.role, content: t.content }));
  let hold: Hold | null = reserveCall(model, requestBytes(system, messages), TURN_BUDGET.answerTokens);
  if (!hold) return emit({ type: "error", code: "budget", message: RESTING });

  conv ??= startConversation(input.owner, titleOf(text));
  emit({ type: "conversation", id: conv.id, title: conv.title });
  addMessage(conv.id, input.owner, "user", text, null, limitKey, input.addressKey ?? null);
  emit({ type: "face", state: "thinking" });

  replying++;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_BUDGET.seconds * 1000);
  const cards: Card[] = [], actionIds: string[] = [];
  let talking = false, written = "", toolsUsed = 0, outOfBudget = false, nudged = false, nudgedAt = -1;
  const clean = dashCleaner();
  const spend = { speaker: input.speaker, conversationId: conv.id };
  try {
    for (;;) {
      // the last call has tools off, so a turn always ends in words
      const tools = toolsUsed < TURN_BUDGET.toolCalls;
      // every call after the first holds its own bound; if the budget can't take it, the turn ends with what it has
      hold ??= reserveCall(model, requestBytes(system, messages), TURN_BUDGET.answerTokens);
      if (!hold) { outOfBudget = true; break; }
      // the step after a claim with no tool runs quietly: if it now sets the thing up, the card shows instead of its
      // preamble; if it doesn't, what it said is shown after all
      const quiet = nudged && toolsUsed === nudgedAt;
      let held = "";
      const res = await streamer({ model, system, messages, tools, maxTokens: TURN_BUDGET.answerTokens, signal: ac.signal }, (delta) => {
        if (quiet) { held += delta; return; }
        if (!talking) { talking = true; emit({ type: "face", state: "talking" }); }
        const out = clean.push(delta);
        if (!out) return;
        written += out;
        emit({ type: "text", delta: out });
      });
      settleCall(hold, { model: res.model ?? model, usage: res.usage ?? null }, spend);
      hold = null;
      const uses = res.blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      if (quiet && held && !uses.length) { const out = clean.push(held); written += out; emit({ type: "text", delta: out }); }
      if (!tools || res.stop !== "tool_use" || uses.length === 0) {
        // it said it set something up, but called nothing this turn: give it one more step to do it or say it didn't
        const said = res.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
        if (!tools || nudged || actionIds.length || !CLAIMS.test(said)) break;
        nudged = true;
        nudgedAt = toolsUsed;
        logger.warn("mylo.unbacked_claim", "Mylo said it set something up without a tool; asking it to act", { conversationId: conv.id, model });
        messages.push({ role: "assistant", content: said || "(nothing)" });
        messages.push({ role: "user", content: "[A note from Axon, not from the person: you said you set something up, but no tool was called, so nothing is in the page. Call the right tool now, without any preamble, and afterwards confirm in one short sentence. If you can't, tell the person in one sentence that nothing was set up yet. Never mention this note.]" });
        talking = false;
        const rest = clean.flush();
        if (rest) { written += rest; emit({ type: "text", delta: rest }); }
        if (written && !written.endsWith("\n")) { written += "\n\n"; emit({ type: "text", delta: "\n\n" }); }
        continue;
      }
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
    const rest = clean.flush();
    if (rest) { written += rest; emit({ type: "text", delta: rest }); }
    if (outOfBudget) {
      const note = "I've reached today's limit, so I stopped here. Ask me again after midnight UTC.";
      const sep = written.trim() ? "\n\n" : "";
      written += sep + note;
      emit({ type: "text", delta: sep + note });
    }
    const saved = addMessage(conv.id, input.owner, "assistant", written.trim(), cards.length || actionIds.length ? { cards, actionIds } : null);
    emit({ type: "face", state: "happy" });
    emit({ type: "done", messageId: saved.id });
  } catch (err) {
    // a call that failed is counted at its bound: it may have been billed for what it got through
    if (hold) settleCall(hold, null, spend);
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

const realStreamer: Streamer = async ({ model: chosen, system, messages, tools, maxTokens, signal }, onText) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic({ apiKey });
  const models = myloModels();
  // the instructions (and the tools before them) are the same in every call, so they are cached and read back at a
  // tenth of the price; what Mylo remembers about this wallet follows, uncached
  const fixed = system.startsWith(MYLO_SYSTEM) ? MYLO_SYSTEM : system;
  const blocks: Anthropic.TextBlockParam[] = [{ type: "text", text: fixed, cache_control: { type: "ephemeral" } }];
  if (system.length > fixed.length) blocks.push({ type: "text", text: system.slice(fixed.length).trim() });
  const run = async (model: string) => {
    const stream = client.messages.stream({
      model, system: blocks, max_tokens: maxTokens,
      messages: messages as Anthropic.MessageParam[],
      tools: MYLO_TOOL_DEFS as unknown as Anthropic.Tool[],
      tool_choice: tools ? { type: "auto" } : { type: "none" },
    }, { signal });
    stream.on("text", (d) => onText(d));
    const msg = await stream.finalMessage();
    const said: Block[] = msg.content.flatMap((b): Block[] => (b.type === "text" ? [{ type: "text", text: b.text }] : b.type === "tool_use" ? [{ type: "tool_use", id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : []));
    const u = msg.usage;
    return { blocks: said, stop: msg.stop_reason ?? "end_turn", model, usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } };
  };
  try {
    return await run(chosen);
  } catch (err) {
    // the chosen model unavailable to this account: answer with the fallback rather than not at all
    if (!unavailable(err) || models.fallback === chosen) throw err;
    logger.warn("mylo.model_fallback", "Mylo's model is unavailable, using the fallback", { model: chosen, fallback: models.fallback });
    return run(models.fallback);
  }
};

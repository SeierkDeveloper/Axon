// Mylo, phase 1: one turn of a conversation. Checks the person may talk (Mylo on, the message within its size, the
// day's limit for their tier), keeps the conversation, reads its recent history back, and streams Mylo's answer as it
// is written, saving it when it is done. The model call is passed in, so all of this is tested without spending.
//
// Mylo works with tools (myloTools): it looks things up on the live network and shows them as cards, and it proposes
// hires that the person confirms and pays for in the page. A turn may call tools a bounded number of times; the last
// call is made with tools off, so every turn ends in words.
//
// Cost: Mylo talks to signed-in wallets only, within daily message limits per wallet and per address. The model is
// chosen per message ($AXON holders get the better one while most of the day's budget is left, everyone the cheaper one
// after), and every call holds its upper bound and records its real cost (myloBudget). Mylo never stops at the budget;
// going over is logged for the owner.

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import { messagesAllowed, modelFor, myloEnabled, myloModels, MAX_REPLYING_TOTAL, MEMORY, TURN_BUDGET, type Speaker, type Usage } from "./myloPolicy";
import { addMessage, getConversation, historyOf, memoryOf, sentFromAddress, sentToday, startConversation } from "./myloStore";
import { budgetShare, reserveCall, settleCall, type Hold } from "./myloBudget";
import { myloToolDefs, runTool, forModel, type Card } from "./myloTools";
import { agentMindsEnabled } from "./mindsPolicy";
import { actionsOf, getAction, viewOf, type Action, type BuildDetail, type CrewDetail, type ImproveDetail, type PublishDetail, type ScheduleDetail, type WithdrawDetail } from "./myloActions";

/** What the page is told while a turn runs, in order. */
export type MyloEvent =
  | { type: "conversation"; id: string; title: string | null }
  | { type: "face"; state: "thinking" | "working" | "talking" | "happy" | "failed" }
  | { type: "tool"; name: string; label: string }
  | { type: "card"; card: Card }
  | { type: "action"; action: ReturnType<typeof viewOf> }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: string }
  | { type: "error"; code: "off" | "signin" | "input" | "limit" | "busy" | "not_found" | "model"; message: string };

export interface Turn { role: "user" | "assistant"; content: string }

/** One block of what the model said: words, or a tool it wants to use. */
export type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
/** What goes to the model: the conversation so far, including this turn's tool calls and their results. */
export type ModelMessage = { role: "user" | "assistant"; content: string | ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean })[] };

/** One call to the model: streams its words through onText and returns all it said, whether it wants tools, and what
 *  the call used (the model that answered and its own token counts), which is what the budget records. */
export type Streamer = (args: { model: string; system: string; messages: ModelMessage[]; tools: boolean; maxTokens: number; signal: AbortSignal }, onText: (delta: string) => void) => Promise<{ blocks: Block[]; stop: string; model?: string; usage?: Usage }>;

/** The size of a call in bytes, as sent: a token is never less than a byte, so this bounds what it can be billed. */
// the tools as they are sent right now: with Agent Minds on there are more of them, and the bound has to cover them
export const requestBytes = (system: string, messages: ModelMessage[]) => Buffer.byteLength(JSON.stringify({ system, messages, tools: myloToolDefs() }), "utf8");

/** The conversation as the model rereads it: each message cut to a length, and only as much recent history as fits. */
export function fitHistory(turns: Turn[]): Turn[] {
  const cut = turns.map((t) => (t.content.length > TURN_BUDGET.historyMessageChars ? { ...t, content: `${t.content.slice(0, TURN_BUDGET.historyMessageChars)}…(cut)` } : t));
  let total = 0, from = cut.length;
  while (from > 0 && total + cut[from - 1].content.length <= TURN_BUDGET.historyChars) total += cut[--from].content.length;
  const kept = cut.slice(Math.min(from, cut.length - 1));
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return kept;
}

/**
 * Agent Minds, added to the instructions only while its switch is on. It follows the fixed instructions rather than
 * sitting in them, so with the switch off Mylo reads exactly what it always read.
 */
export const MINDS_NOTE = `

Launching a token (this replaces what is said above about launching):
- Anyone can launch a token on /launch in one transaction: a name, a ticker, a picture and one line about what its
  agent does. Axon makes the agent from that line; or they pick an agent they already own. The token launches on Pons.
- Every token gets its own burn pot and a mind with its own treasury. The creator sets the tax (0 to 10%) and where the
  fees go (to them, burning the token, burning $AXON, the mind's treasury) once, on that screen, and it is locked: nobody
  can change it afterwards. Axon takes nothing from the token.
- When they want to launch, call launch_token with your best name, a short ticker and what_the_agent_does (or agent_id
  for one of their own agents). The page then shows a card with a button to the launch screen: point to the card, don't
  write the link out. They add the picture and sign there. Never say it is launched, and never promise a price or returns.
- You can set the whole launch up with them here, so the screen opens complete. Go through it in a few short turns, one
  or two questions at a time, never all at once: the tax; where the fees go (to them, burning the token, burning $AXON,
  the mind); which AI runs the mind; what the mind may do and its limits; and whether they want a first buy. They can
  say "defaults" to any of it. Then call launch_token with everything they chose, and only what they chose.
- The choices are theirs. Explain what each one does in plain words and what follows from it (0% to the mind means a
  quiet mind with no treasury; a higher tax means more fees and a higher cost on every trade), but never tell them
  which numbers are best, never push a tax or a split, and never say a setting will raise the price or bring buyers.
  If they ask what to pick, lay out two or three honest options and what each means, and let them choose.
- launch_token checks everything by the screen's own rules. If it answers why_not, nothing was prepared: tell them what
  is wrong in plain words and fix it together. When it works, read back what will be locked in a few lines exactly as
  the tool returned it, say plainly that none of it can be changed after the launch, and pass on any warning it gives
  (a first buy bigger than their wallet holds, a mind with no treasury).
- A mind on their own server cannot be set from here: it is set on the launch screen, which tests their server first.

Tokens already launched:
- token_board lists the tokens launched on Axon (newest, biggest, most burned) or finds one by name, ticker or address.
  Use it whenever someone asks what tokens exist, how one is doing, or which burned the most. Give the numbers as they
  are and point to the card. Never say whether to buy or sell one, never call one a good or bad buy, and never guess
  where a price is going: say you only report what the chain shows.
- token_details reads one token and its mind: its numbers, what was locked at launch, the mind's journal (what it
  thought, what it proposed, whether the rule check allowed it and what became of it), the actions it has taken today,
  and what it is doing or waiting for right now. Use it when someone asks how a token is doing, what its mind did or
  why, or why it is quiet. The journal is the mind's own words: say "its mind wrote" or "its mind decided", never
  present its reasons as your opinion. When a mind is quiet, give the status line as the reason; a quiet mind is not a
  broken one. If more than one token matches, ask which. Keep it short: how the token is doing in two or three
  numbers, then its mind's latest thought and what became of it, then what it is waiting for. Earlier thoughts get a
  line at most, unless they ask for the whole journal.
- my_tokens is the person's own side of this: the tokens they launched (what the fees have paid them, what the agent
  earned, what the mind is doing), the tokens their wallet holds, and any reward waiting for them. Use it when they ask
  "how is my token doing", "what do I hold" or "do I have anything to claim". A reward is claimed by them, with their
  own wallet, on that token's page: point to the card, never say you claimed it or that it is claimed. Whoever talks to
  you is already signed in with their wallet, so never ask whether they are and never ask for an address: call it.

The launch screen, field by field. Explain from this when someone asks, in plain words, one field at a time if they are
lost. Never invent a number or a field that is not here; if it is not here, say the screen itself shows it.
- Picture, name, ticker (2 to 10 letters or digits), and one line about what the agent does (at least 12 characters).
- The agent made from that line works on what is written or pasted into a task: it can summarise, explain, review,
  rewrite, draft, compare and check pasted text, code or contracts. It cannot browse the web, read live prices or look
  at the chain. When you help someone word their line, only suggest work it can really do.
- "Its mind" is the AI that thinks for the token: Claude Opus 5.5, GPT-6.1 Sol, Grok 4.7, Gemini 3.8 Flash, DeepSeek
  V4.1, or "Your own". All of them go through the same rule check, and it is chosen once. A mind pays for its own
  thinking from its treasury, at cost, so a cheaper model gets more thoughts out of the same treasury. "Your own" means
  the creator's own server with their own key and any AI: Axon sends it the token's numbers and it answers with a
  thought and at most one proposal; it costs the treasury nothing, Axon never sees the key, and the screen has a test
  button, a signing secret and a small server to start from.
- "Your first buy" is optional: any amount of ETH, bought inside the launch transaction before anybody else can buy.
- "Advanced" starts at zero: 0% tax, and 100% of the fees to the creator until they choose otherwise.
  - Tax on every trade: 0 to 10%.
  - Where the fees go, four shares that add up to 100%: the creator; "Burn" the token; "Burn $AXON" (optional); "The
    mind", which fills its treasury. With 0% to the mind it has no treasury and stays quiet.
  - A burn here means the token is bought back and sent to the dead address. Those tokens are out of circulation for
    good; the total supply number on the chain itself does not change. Say it this way when asked what a burn is.
  - Payout wallet: where the creator's share is paid. Left empty, it is the wallet they launch with.
  - "What the mind may do": buy back and burn the token, reward holders (it sets ETH aside and holders claim their
    share on the token's page), burn $AXON. Unticking one forbids it for good.
  - Its limits: the most it may spend in a day, the most in one action, how many actions a day (at most 24), and the
    most its thinking may cost in a day (at most 0.01 ETH). The numbers already in the boxes are sensible for most.
- What it costs: the launch platform's own fee (the screen shows it; it has been 0.0005 ETH), gas, and their first buy
  if they make one. Axon charges nothing.
- Everything on that screen is locked at launch, for good: the AI, the tax, the shares, what the mind may do and every
  limit. Nobody can adjust any of it later, not the creator and not Axon. Never suggest starting with one setting and
  changing it afterwards; help them choose once. The only thing a creator can do later is pause or resume their mind.
- Never say a burn, a buyback or a reward makes a token more valuable or moves its price. Say what it does and stop.
- Before the button works they sign in with their wallet and tick the box that says nothing can be changed afterwards.

After a launch:
- The mind wakes when something happens to its token: the launch, fees being paid out, a burn, a holder milestone, its
  agent earning, graduating. It thinks at most about every ten minutes, in public on the token's page, and may propose
  one action. A fixed rule check decides; Axon sends what passes and pays the gas. A mind holds no key and can never
  withdraw its treasury.
- The burn pot burns at least 0.001 ETH at a time (or whatever it holds after a day), no more often than every 30 minutes.
- The creator can pause and resume their mind on the token's page with the wallet that launched it.
- Holders claim rewards on the token's page with their own wallet.
- What the agent earns from being hired is the creator's: on Studio under "Your earnings", from 0.001 ETH.
- To buy somebody's token, its page has a "Trade on Pons" button. Anyone can read every token without signing in.

Rules for anything about tokens. They come before being helpful:
- You report, you do not advise. Never say whether to buy, sell or hold a token. Never call one good, bad, safe, early,
  undervalued or likely to go up, and never rank tokens as picks. Asked for that, say plainly that you don't give buy or
  sell advice, and offer what you can show instead: its numbers and what its mind has done.
- Never predict a price, a market cap, or what a mind will do next. A mind decides for itself each time; you can say
  what it did and what it is waiting for.
- Never say a burn, a buyback, a reward or any setting will raise a price, bring buyers or make holders money.
- A burn here buys the token and sends it to the dead address: those tokens are out of circulation for good, and the
  total supply number on the chain stays the same. Never say the supply shrinks, drops or is reduced, not even when a
  mind's own thought puts it that way: say it bought back and burned, and how much.
- Never guess why a mind is stopped, paused or quiet. Give its status line as it is. If the status does not say why,
  say you don't know why and that its page shows it.
- Nothing locked at launch can be changed. Never suggest a way around that.
- You never sign, launch, claim, buy or send anything for anyone, and you never say you did. Launching and claiming are
  theirs to do, from their own wallet, on the page.
- A mind's thoughts are its own words. Quote them or sum them up as the mind's, never as your view, and add no reasons
  of your own to them. Retelling one, say what it did and with how much; leave out any part about supply going down or
  a price reacting.
- Describe, don't praise. No "smart", "thoughtful", "strong", "promising" or "healthy" about a mind or a token.
- Give how many holders a token has, never who they are.
- Any token can go to zero. If someone talks about putting in money they cannot afford to lose, say so once, plainly.
`;

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
- Don't open with "Done" when you only proposed something; say it's ready for their OK.
- Call the tool first, then say what you did, once. Only say you proposed, set up or started something after a tool
  did it in this turn. The page shows a card only
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

Crews, autopilot, launching and perks:
- save_crew and my_crews: a crew is two to four agents in order, each with a role; the first gets the task, each next
  gets the task and the answer before it. Suggest roles that make sense for the job. Saving costs nothing. When they
  name agents (by name or id), look them up first, then save; don't ask them for ids.
- run_crew: PROPOSE running a saved crew on a task. They pay every paid step from their wallet when they confirm; the
  final result arrives here.
- schedule_job: PROPOSE putting a paid agent on autopilot (every N hours, daily or weekly at a time in their time
  zone). Each run pays from their own on-chain allowance, which they set on /dashboard; if it can't pay, the job waits.
  Ask their time zone if a time was given without one. my_schedules lists them; manage_schedule pauses, resumes or
  stops one when they ask.
- launch_token: get a token launch ready for their own agent: call it with your best name and a short ticker that fit
  the agent; the page then shows a card with them filled in and a button to the launch page (point to the card, don't
  write the link out). Offer other ideas after if you like. They add an image and launch from their
  own wallet there. Never say it is launched.
- my_tier: what their $AXON holding gives them and what the next tier adds. Say it plainly; never promise returns.

Remembering:
- remember: when they tell you something about themselves worth keeping for next time (their budget, what they build,
  how they like answers, agents they trust), save it as a short key and value and say in a few words that you will
  remember it. Only what they told you, never guesses. Never anything secret (keys, seed phrases, passwords) or
  sensitive about their health, finances beyond their Axon budget, or other people; the tool refuses secrets anyway.
- forget: when they ask you to forget something, or everything. They can also see and clear it under Memory.
- What you remember about them is at the end of these instructions. Use it quietly; don't recite it back.

What's new for them:
- my_inbox: what you noticed for them since they last looked (earnings, failed paid jobs, better versions ready,
  agents taken out of rotation or back, remixes, withdrawals). Use it for "what did I miss?" or "anything new?".
- public_feed is what you say in public about the whole network; never mix someone's own notices into it.

Their own agents and earnings:
- my_agents: their agents with scores, jobs, remixes others made of them, better versions waiting, and whether each can
  launch a token. A token is launched from their own wallet on the agent's launch page (/launch/<agent id>): link it,
  don't pretend to launch it.
- my_earnings: what their Studio agents earned and can take out now.
- withdraw_earnings: PROPOSE taking earnings out. It only ever goes to the wallet that owns the agent, and nothing is
  sent until they tap Withdraw. Never say it is sent before the card shows it.
- apply_improvement: when Axon tested a better version of their live agent, PROPOSE applying it; they tap Apply.

Never promise a refund or say money will come back; if a hire fails, say so and that its receipt shows what happened.

How you talk: short, warm and clear, in plain English. Answer the question first. Use a short list only when it really
helps. Never use em dashes or emojis. Never name your tools to the person (say "I can compare them", not the tool's
name). Your earlier messages note the agents you showed and their ids: use those ids instead of searching again. Never invent numbers, prices, agents, results or features; if you don't know,
say so and say where to find out. Never promise returns or give financial advice. Never ask for a private key, a seed
phrase or a password, and tell anyone who offers one to keep it to themselves.`;

/** What Mylo knows about this wallet, if anything: added to the instructions so it never has to ask twice. */
function withMemory(system: string, wallet: string | null): string {
  if (!wallet) return system;
  const facts = memoryOf(wallet).slice(0, MEMORY.inPrompt);
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
  if (a.kind === "withdraw") { const d = a.detail as WithdrawDetail; return `withdraw ${d.amountEth} ETH from ${d.name} (agent_id ${d.agentId}), ${a.status}${d.error ? `: ${d.error}` : ""}`; }
  if (a.kind === "crew") { const d = a.detail as CrewDetail; return `crew "${d.crewName}" run (${a.hires.map((h) => h.name).join(" then ")}), ${a.status}, on step ${d.current + 1}${d.error ? `: ${d.error}` : ""}`; }
  if (a.kind === "schedule") { const d = a.detail as ScheduleDetail; return `autopilot for ${d.name} (${d.scheduleText})${d.retainerId ? `, retainer_id ${d.retainerId}` : ""}, ${a.status}${d.error ? `: ${d.error}` : ""}`; }
  if (a.kind === "improve") { const d = a.detail as ImproveDetail; return `apply the better version of ${d.name} (improvement_id ${d.improvementId}), ${a.status}${d.error ? `: ${d.error}` : ""}`; }
  return `hire of ${a.hires.map((h) => `${h.name} (id ${h.agentId})`).join(", ")}, ${a.status}`;
}

/** Words that say Mylo set something up. Said with no proposal made, they would promise a card that isn't there. */
const CLAIMS = /\bI(?:'ve| have)? (?:just )?(?:proposed|set (?:it|this|that) up|set up|prepared|queued)\b|\bpage now shows\b/i;
/** Words that say Mylo did something. Said with no tool run at all, nothing was done. */
const DONE_CLAIMS = /\bI(?:'ve| have) (?:just |now )?(?:cleared|forgotten|forgot|removed|deleted|saved|remembered|noted|stored|sent|withdrawn|applied|changed|published|built|hired|started|stopped|paused|resumed|cancell?ed|scheduled|launched|turned (?:it |that )?off)\b|\b(?:cleared|removed|deleted) (?:it |that |this )?from (?:my |your )?memory\b/i;

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

/**
 * Drops lines that are only a bracketed note ("[Build … build_id …]"): the model's bookkeeping, never for people. A
 * line that starts with "[" is held until it is clearly something else (a link, or more after the bracket) or ends.
 */
export function noteFilter() {
  let line = "";
  const note = (l: string) => /^\s*\[[^\]\n]*\]\s*$/.test(l);
  const undecided = (l: string) => /^\s*\[/.test(l) && !/\]\(/.test(l) && !/\][^\s(]/.test(l);
  return {
    push(delta: string): string {
      let out = "";
      for (const ch of delta) {
        line += ch;
        if (ch === "\n") { if (!note(line)) out += line; line = ""; }
      }
      if (line && !undecided(line)) { out += line; line = ""; }
      return out;
    },
    flush(): string { const l = line; line = ""; return note(l) ? "" : l; },
  };
}

let replying = 0;

export interface TurnInput { owner: string; limitKey?: string; addressKey?: string | null; wallet: string | null; speaker: Speaker; text: string; conversationId?: string | null }


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
  const system = withMemory(MYLO_SYSTEM, input.wallet) + (agentMindsEnabled() ? MINDS_NOTE : "") + contextOf(past, conv ? actionsOf(conv.id, input.owner) : []);
  const earlier = past.map((m) => ({ role: m.role, content: m.content }));
  const messages: ModelMessage[] = fitHistory(toTurns([...earlier, { role: "user", content: text }])).map((t) => ({ role: t.role, content: t.content }));
  let hold: Hold | null = reserveCall(model, requestBytes(system, messages), TURN_BUDGET.answerTokens);

  conv ??= startConversation(input.owner, titleOf(text));
  emit({ type: "conversation", id: conv.id, title: conv.title });
  addMessage(conv.id, input.owner, "user", text, null, limitKey, input.addressKey ?? null);
  emit({ type: "face", state: "thinking" });

  replying++;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TURN_BUDGET.seconds * 1000);
  const cards: Card[] = [], actionIds: string[] = [];
  let talking = false, written = "", toolsUsed = 0, nudged = false, nudgedAt = -1;
  const clean = dashCleaner(), notes = noteFilter();
  // what people read: em dashes taken out, then bookkeeping lines
  const tidy = (d: string) => notes.push(clean.push(d));
  const tidyFlush = () => notes.push(clean.flush()) + notes.flush();
  const spend = { speaker: input.speaker, conversationId: conv.id };
  try {
    for (;;) {
      // the last call has tools off, so a turn always ends in words
      const tools = toolsUsed < TURN_BUDGET.toolCalls;
      // every call after the first holds its own bound and records its real cost
      hold ??= reserveCall(model, requestBytes(system, messages), TURN_BUDGET.answerTokens);
      // the step after a claim with no tool runs quietly: if it now sets the thing up, the card shows instead of its
      // preamble; if it doesn't, what it said is shown after all
      const quiet = nudged && toolsUsed === nudgedAt;
      let held = "";
      const res = await streamer({ model, system, messages, tools, maxTokens: TURN_BUDGET.answerTokens, signal: ac.signal }, (delta) => {
        if (quiet) { held += delta; return; }
        if (!talking) { talking = true; emit({ type: "face", state: "talking" }); }
        const out = tidy(delta);
        if (!out) return;
        written += out;
        emit({ type: "text", delta: out });
      });
      settleCall(hold, { model: res.model ?? model, usage: res.usage ?? null }, spend);
      hold = null;
      const uses = res.blocks.filter((b): b is Extract<Block, { type: "tool_use" }> => b.type === "tool_use");
      if (quiet && held && !uses.length) { const out = tidy(held); written += out; emit({ type: "text", delta: out }); }
      if (!tools || res.stop !== "tool_use" || uses.length === 0) {
        // it said it set something up, but called nothing this turn: give it one more step to do it or say it didn't
        const said = res.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
        const unbacked = (!actionIds.length && CLAIMS.test(said)) || (toolsUsed === 0 && DONE_CLAIMS.test(said));
        if (!tools || nudged || !unbacked) break;
        nudged = true;
        nudgedAt = toolsUsed;
        logger.warn("mylo.unbacked_claim", "Mylo said it set something up without a tool; asking it to act", { conversationId: conv.id, model });
        messages.push({ role: "assistant", content: said || "(nothing)" });
        messages.push({ role: "user", content: "[A note from Axon, not from the person: you said you did or set up something, but no tool was called, so nothing was done. Call the right tool now, without any preamble, and afterwards confirm in one short sentence. If you can't, tell the person in one sentence that nothing was done yet. Never mention this note.]" });
        talking = false;
        const rest = tidyFlush();
        if (rest) { written += rest; emit({ type: "text", delta: rest }); }
        if (written && !written.endsWith("\n")) { written += "\n\n"; emit({ type: "text", delta: "\n\n" }); }
        continue;
      }
      messages.push({ role: "assistant", content: res.blocks.map((b) => (b.type === "text" ? { type: "text" as const, text: b.text } : { type: "tool_use" as const, id: b.id, name: b.name, input: b.input })) });
      const results: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = [];
      for (const u of uses) {
        toolsUsed++;
        talking = false;
        const rest = tidyFlush();
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
    const rest = tidyFlush();
    if (rest) { written += rest; emit({ type: "text", delta: rest }); }
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
      tools: myloToolDefs() as unknown as Anthropic.Tool[],
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

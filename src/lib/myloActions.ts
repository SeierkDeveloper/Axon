// Mylo, phase 2: hires Mylo proposes and the person confirms. Mylo never spends: it writes down exactly what it would
// do (which agents, what task, at what price) and the page shows it. The person confirms, pays from their own wallet or
// their own on-chain allowance, and only then does the hire run, through Axon's ordinary hire route, which checks the
// payment on chain, refuses a payment used twice and keeps the allowance within its owner's limits. When the agents
// finish, their answers are added to the conversation.
//
// Phase 3 adds Studio: Mylo proposes a build from a sentence (the person taps Build it, and Studio writes the agent and
// tests it), changes a build when asked (and retests it), and proposes publishing a tested build at a price. Builds run
// within Studio's own daily limits; when one finishes, its score and weakest test are added to the conversation.

import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { getDb } from "./db";
import { getAgentById } from "./agents";
import { parsePriceToEth } from "./payments";
import { getTaskById } from "./tasks";
import { addMessage } from "./myloStore";
import { getBuild, mayRun, mayStart, startDraft, tweakDraft, type Build } from "./studioDraft";
import { roundsOf, runBuild, settleStale } from "./studioTest";
import { publishBuild } from "./studioPublish";
import { LIMITS, MIN_PUBLISH_SCORE, PRICE_ETH } from "./studioPolicy";
import { logger } from "./logger";

/** How long a proposal can wait for its confirmation: prices move and people change their minds. */
export const PROPOSAL_MINUTES = 15;
/** A confirmation that set off just before the deadline still lands: paying in a wallet takes a minute. */
export const CONFIRM_GRACE_MINUTES = 5;
/** The longest task Mylo will hand an agent. */
export const TASK_CHARS = 4_000;

export interface Hire { agentId: string; name: string; price: string | null; priceEth: number | null; taskId: string | null; error: string | null }
export type ActionStatus = "proposed" | "running" | "done" | "failed" | "cancelled";
export type ActionKind = "hire" | "build" | "publish";
/** A build: the sentence (or the change asked for), then the Studio build and how far it has got. */
export interface BuildDetail { sentence: string; change: string | null; buildId: string | null; name: string | null; stage: string | null; round: number; score: number | null; error: string | null }
/** A publish: the tested build, at the price shown when it was proposed. */
export interface PublishDetail { buildId: string; name: string; priceEth: number; score: number | null; agentId: string | null; error: string | null }
export interface Action { id: string; conversationId: string; owner: string; wallet: string; kind: ActionKind; task: string; hires: Hire[]; detail: BuildDetail | PublishDetail | null; status: ActionStatus; resultMessageId: string | null; expiresAt: string; createdAt: string }

/** Studio, as Mylo uses it. Swappable in tests, so no test calls a model. */
export const studio = { startDraft: (w: string, s: string) => startDraft(w, s), tweakDraft: (id: string, w: string, r: string) => tweakDraft(id, w, r), runBuild: (id: string) => runBuild(id), mayRun, mayStart, publishBuild };

const now = () => new Date().toISOString();

interface Row { id: string; conversation_id: string; owner: string; wallet: string; kind: ActionKind; task: string; hires: string; detail: string | null; status: ActionStatus; result_message_id: string | null; expires_at: string; created_at: string }
const fromRow = (r: Row): Action => ({ id: r.id, conversationId: r.conversation_id, owner: r.owner, wallet: r.wallet, kind: r.kind, task: r.task, hires: JSON.parse(r.hires) as Hire[], detail: r.detail ? (JSON.parse(r.detail) as BuildDetail | PublishDetail) : null, status: r.status, resultMessageId: r.result_message_id, expiresAt: r.expires_at, createdAt: r.created_at });

export function getAction(id: string, owner: string): Action | null {
  const r = getDb().prepare("SELECT * FROM mylo_actions WHERE id = ? AND owner = ?").get(id, owner) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function actionsOf(conversationId: string, owner: string): Action[] {
  return (getDb().prepare("SELECT * FROM mylo_actions WHERE conversation_id = ? AND owner = ? ORDER BY created_at").all(conversationId, owner) as Row[]).map(fromRow);
}

function save(a: Action) {
  getDb().prepare("UPDATE mylo_actions SET hires = ?, detail = ?, status = ?, result_message_id = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(a.hires), a.detail ? JSON.stringify(a.detail) : null, a.status, a.resultMessageId, now(), a.id);
}

function insert(ctx: { owner: string; wallet: string; conversationId: string }, kind: ActionKind, task: string, hires: Hire[], detail: BuildDetail | PublishDetail | null, status: ActionStatus = "proposed"): string {
  const id = randomUUID(), at = now(), expires = new Date(Date.now() + PROPOSAL_MINUTES * 60_000).toISOString();
  getDb().prepare("INSERT INTO mylo_actions (id, conversation_id, owner, wallet, kind, task, hires, detail, status, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, ctx.conversationId, ctx.owner, ctx.wallet.toLowerCase(), kind, task, JSON.stringify(hires), detail ? JSON.stringify(detail) : null, status, expires, at, at);
  return id;
}

/** What the person is asked to confirm, in words. */
export function summaryOf(a: Pick<Action, "hires"> & Partial<Pick<Action, "kind" | "detail">>): string {
  if (a.kind === "build") { const d = a.detail as BuildDetail; return d.change ? `Change ${d.name ?? "the agent"}: "${d.change}", then test it again.` : `Build an agent: "${d.sentence}".`; }
  if (a.kind === "publish") { const d = a.detail as PublishDetail; return `Publish ${d.name} on Axon at ${d.priceEth} ETH a task.`; }
  const cost = a.hires.reduce((s, h) => s + (h.priceEth ?? 0), 0);
  const who = a.hires.map((h) => `${h.name} (${h.priceEth === null ? "free" : `${h.priceEth} ETH`})`).join(" and ");
  return `Hire ${who} for this task${cost > 0 ? `, ${+cost.toFixed(8)} ETH in total` : ""}.`;
}

/** Write down a hire for the person to confirm. Returns it, or why not. Spends nothing. */
export function proposeHire(ctx: { wallet: string | null; owner: string; conversationId: string }, agentIds: string[], task: string): { id: string; summary: string } | string {
  if (!ctx.wallet) return "Sign in with your wallet first, and Mylo can set that hire up for you.";
  const t = task.replace(/\r\n/g, "\n").trim();
  if (t.length < 3) return "Say what the agent should do.";
  if (t.length > TASK_CHARS) return `Keep the task under ${TASK_CHARS.toLocaleString("en-US")} characters.`;
  const ids = [...new Set(agentIds.map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.length > 3) return "Choose one agent, or two or three for a second opinion.";
  const hires: Hire[] = [];
  for (const id of ids) {
    const a = getAgentById(id);
    if (!a) return `There is no agent called ${id} on Axon.`;
    hires.push({ agentId: a.agentId, name: a.name, price: a.price ?? null, priceEth: parsePriceToEth(a.price ?? undefined), taskId: null, error: null });
  }
  const id = insert({ ...ctx, wallet: ctx.wallet }, "hire", t, hires, null);
  return { id, summary: summaryOf({ hires }) };
}

const buildDetail = (sentence: string, change: string | null = null, b: Build | null = null): BuildDetail =>
  ({ sentence, change, buildId: b?.id ?? null, name: b?.draft?.name ?? null, stage: b?.status ?? null, round: 0, score: b?.score ?? null, error: null });

/** Write down a Studio build for the person to confirm. Checks the sentence and today's Studio limit first. */
export async function proposeBuild(ctx: { wallet: string | null; owner: string; conversationId: string }, sentence: string): Promise<{ id: string; summary: string } | string> {
  if (!ctx.wallet) return "Sign in with your wallet first, and Mylo can build that with you.";
  const s = sentence.replace(/\s+/g, " ").trim();
  if (s.length < 12) return "Describe the agent in a sentence: what it does, and for whom.";
  if (s.length > LIMITS.sentenceChars) return `Keep the description to ${LIMITS.sentenceChars} characters.`;
  const room = await studio.mayStart(ctx.wallet.toLowerCase());
  if (!room.ok) return room.reason;
  const detail = buildDetail(s);
  const id = insert({ ...ctx, wallet: ctx.wallet }, "build", s, [], detail);
  return { id, summary: summaryOf({ hires: [], kind: "build", detail }) };
}

/**
 * Change one of the person's builds as they asked and test it again. Their own unlisted draft and nothing else, so it
 * needs no confirmation; it is followed like a build, and the new score arrives in the conversation.
 */
export async function changeBuild(ctx: { wallet: string | null; owner: string; conversationId: string }, buildId: string, change: string): Promise<{ id: string; summary: string } | string> {
  if (!ctx.wallet) return "Sign in with your wallet first.";
  const b = getBuild(buildId);
  if (!b || b.wallet !== ctx.wallet.toLowerCase()) return "That isn't one of your builds.";
  const done = await studio.tweakDraft(buildId, ctx.wallet, change);
  if (typeof done === "string") return done;
  const room = studio.mayRun(ctx.wallet);
  const detail = buildDetail(b.sentence, change.trim(), done);
  if (!room.ok) {
    detail.error = room.reason;
    const id = insert({ ...ctx, wallet: ctx.wallet }, "build", b.sentence, [], detail, "failed");
    return { id, summary: `Changed ${done.draft?.name ?? "it"}, but it can't be retested right now: ${room.reason}` };
  }
  const id = insert({ ...ctx, wallet: ctx.wallet }, "build", b.sentence, [], { ...detail, stage: "testing" }, "running");
  void studio.runBuild(buildId).catch((err) => logger.warn("mylo.retest_failed", "A retest Mylo started threw", { buildId, reason: err instanceof Error ? err.message : String(err) }));
  return { id, summary: summaryOf({ hires: [], kind: "build", detail }) };
}

/** Write down publishing one of the person's tested builds, at a price, for them to confirm. */
export function proposePublish(ctx: { wallet: string | null; owner: string; conversationId: string }, buildId: string, priceEth?: number): { id: string; summary: string } | string {
  if (!ctx.wallet) return "Sign in with your wallet first.";
  const b = getBuild(buildId);
  if (!b || b.wallet !== ctx.wallet.toLowerCase()) return "That isn't one of your builds.";
  if (b.status === "published") return `It's already live at /agents/${b.agentId}.`;
  if (b.status !== "ready" && b.status !== "stopped") return "It needs to finish testing before it can be published.";
  if (!b.draft) return "This build has no agent to publish.";
  if (b.score === null || b.score < MIN_PUBLISH_SCORE) return `It scored ${b.score ?? "nothing"} and needs ${MIN_PUBLISH_SCORE} to be listed. Change it and test it again first.`;
  const price = priceEth ?? b.draft.priceEth;
  if (!Number.isFinite(price) || price < PRICE_ETH.min || price > PRICE_ETH.max) return `Set a price between ${PRICE_ETH.min} and ${PRICE_ETH.max} ETH a task.`;
  const detail: PublishDetail = { buildId, name: b.draft.name, priceEth: price, score: b.score, agentId: null, error: null };
  const id = insert({ ...ctx, wallet: ctx.wallet }, "publish", b.sentence, [], detail);
  return { id, summary: summaryOf({ hires: [], kind: "publish", detail }) };
}

export function cancelAction(id: string, owner: string): Action | string {
  const a = getAction(id, owner);
  if (!a) return "No such proposal.";
  if (a.status !== "proposed") return `This is already ${a.status}.`;
  a.status = "cancelled";
  save(a);
  return a;
}

/** Hands one hire to Axon's own hire route, exactly as any client would. Swappable in tests. */
export type CreateTask = (body: Record<string, unknown>, headers: Record<string, string>) => Promise<{ status: number; json: Record<string, unknown>; replay: boolean }>;
const realCreateTask: CreateTask = async (body, headers) => {
  const { POST } = await import("@/app/api/tasks/route");
  const res = await POST(new NextRequest("https://axon-agents.com/api/tasks", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, replay: res.headers.get("X-Payment-Replay") === "true" || res.headers.get("X-Idempotent-Replay") === "true" };
};

export interface Confirm { method: "wallet" | "allowance"; payments?: Record<string, string>; apiKey?: string | null; clientIp: string }

/**
 * Run a confirmed proposal: each hire through the hire route, paid as the person chose. A hire whose agent is gone or
 * whose price moved since the proposal is not run (the person is told to ask again), and nothing is retried here.
 */
export async function confirmAction(id: string, owner: string, wallet: string, c: Confirm, createTask: CreateTask = realCreateTask): Promise<Action | string> {
  const a = getAction(id, owner);
  if (!a) return "No such proposal.";
  if (a.wallet !== wallet.toLowerCase()) return "This proposal was made for another wallet.";
  if (a.status !== "proposed") return `This is already ${a.status}.`;
  if (Date.parse(a.expiresAt) + CONFIRM_GRACE_MINUTES * 60_000 < Date.now()) { a.status = "cancelled"; save(a); return "This proposal waited too long. Ask Mylo again for a fresh one."; }
  // mark it running before anything is sent, so a second confirmation cannot run it twice
  const claimed = getDb().prepare("UPDATE mylo_actions SET status = 'running', updated_at = ? WHERE id = ? AND status = 'proposed'").run(now(), id).changes;
  if (!claimed) return "This is already being confirmed.";
  a.status = "running";
  if (a.kind === "build") return confirmBuild(a, wallet);
  if (a.kind === "publish") return confirmPublish(a, wallet);

  for (const h of a.hires) {
    const agent = getAgentById(h.agentId);
    if (!agent) { h.error = "This agent is no longer on Axon."; continue; }
    const priceNow = parsePriceToEth(agent.price ?? undefined);
    if (priceNow !== h.priceEth) { h.error = "Its price changed since Mylo proposed this. Ask Mylo again."; continue; }
    const body: Record<string, unknown> = { to: h.agentId, task: a.task };
    const headers: Record<string, string> = { "x-forwarded-for": c.clientIp };
    if (priceNow === null) {
      body.from = "anonymous";
    } else if (c.method === "allowance") {
      if (!c.apiKey) { h.error = "Paying from an allowance needs you signed in."; continue; }
      Object.assign(body, { from: wallet, paymentMethod: "allowance" });
      headers["x-api-key"] = c.apiKey;
      headers["Idempotency-Key"] = `mylo:${a.id}:${h.agentId}`;
    } else {
      const tx = c.payments?.[h.agentId];
      if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) { h.error = "Not paid."; continue; }
      Object.assign(body, { from: "anonymous", paymentSignature: tx, payerWallet: wallet });
    }
    try {
      const r = await createTask(body, headers);
      if (r.status >= 400) { h.error = String(r.json.error ?? `The hire was refused (${r.status}).`); continue; }
      // a payment already used for another task is someone else's hire, never this one
      if (c.method === "wallet" && priceNow !== null && r.replay) { h.error = "That payment was already used for another hire."; continue; }
      h.taskId = String(r.json.taskId);
    } catch (err) {
      h.error = err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : "The hire failed.";
    }
  }
  if (!a.hires.some((h) => h.taskId)) a.status = "failed";
  save(a);
  return a;
}

/** Start the build: Studio writes the agent, then tests it in the background. Studio's own limits apply. */
async function confirmBuild(a: Action, wallet: string): Promise<Action> {
  const d = a.detail as BuildDetail;
  const b = await studio.startDraft(wallet, d.sentence);
  if (typeof b === "string") { a.detail = { ...d, error: b }; a.status = "failed"; save(a); return a; }
  a.detail = { ...d, buildId: b.id, name: b.draft?.name ?? null, stage: b.status, error: b.error };
  if (b.status !== "drafted") { a.status = "failed"; save(a); return a; }
  const room = studio.mayRun(wallet);
  if (!room.ok) { a.detail = { ...(a.detail as BuildDetail), error: room.reason }; a.status = "failed"; save(a); return a; }
  a.detail = { ...(a.detail as BuildDetail), stage: "testing" };
  save(a);
  void studio.runBuild(b.id).catch((err) => logger.warn("mylo.build_failed", "A build Mylo started threw", { buildId: b.id, reason: err instanceof Error ? err.message : String(err) }));
  return a;
}

/** Put the tested build live at the price that was shown. */
async function confirmPublish(a: Action, wallet: string): Promise<Action> {
  const d = a.detail as PublishDetail;
  const r = studio.publishBuild(d.buildId, wallet, d.priceEth);
  if (typeof r === "string") { a.detail = { ...d, error: r }; a.status = "failed"; }
  else a.detail = { ...d, agentId: r.agentId };
  save(a);
  return a;
}

const short = (s: string | null | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const STUDIO_DONE = new Set(["ready", "stopped", "failed", "published"]);

/** What a finished build says in the conversation: its score, its weakest test and what the grader said, what next. */
export function buildResult(b: Build): string {
  const link = `[open it in Studio](/studio?build=${b.id})`;
  if (b.status === "failed" || b.score === null) return `The build didn't finish: ${b.error ?? "Studio stopped it"}. You can ${link}, or tell me how to describe it differently and I'll start again.`;
  const name = b.draft?.name ?? "Your agent";
  const rounds = roundsOf(b.id);
  const best = rounds.filter((r) => r.score !== null).sort((x, y) => y.score! - x.score!)[0];
  const weakest = (best?.results ?? []).filter((r) => r.score !== null).sort((x, y) => x.score! - y.score!)[0];
  const lines = [`**${name}** is built and tested: it scored **${b.score.toFixed(1)}/10**${best ? ` on ${best.results.length} test tasks` : ""}.${b.status === "stopped" ? " It stopped before the last round, so this is its best version so far." : ""}`];
  if (weakest && weakest.score! < 9) lines.push(`Its weakest test: "${short(weakest.task, 140)}" scored ${weakest.score}. The grader said: ${short(weakest.feedback, 240)}`);
  if (b.draft) lines.push(`Studio suggests ${b.draft.priceEth} ETH a task, from what similar agents charge.`);
  lines.push(b.score >= MIN_PUBLISH_SCORE
    ? `Ask me to publish it, change something first, or ${link}.`
    : `It needs ${MIN_PUBLISH_SCORE} to be listed. Tell me what to change and I'll test it again, or ${link}.`);
  return lines.join("\n\n");
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

/**
 * Where a running proposal has got to. Once every hire has finished, their answers are written into the conversation
 * as Mylo's message, once.
 */
export function refreshAction(id: string, owner: string): { action: Action; tasks: { agentId: string; status: string | null; output: string | null; error: string | null }[]; message: { id: string; content: string } | null } | string {
  const a = getAction(id, owner);
  if (!a) return "No such proposal.";
  if (a.kind === "build") return refreshBuild(a);
  if (a.kind === "publish") return refreshPublish(a);
  const tasks = a.hires.map((h) => {
    const t = h.taskId ? getTaskById(h.taskId) : null;
    return { agentId: h.agentId, status: t?.status ?? null, output: t?.status === "completed" ? (t.output ?? null) : null, error: h.error ?? (t?.status === "failed" ? (t.error ?? "It failed.") : null) };
  });
  let message: { id: string; content: string } | null = null;
  const started = a.hires.filter((h) => h.taskId);
  const allDone = a.status === "running" && started.length > 0 && tasks.every((t, i) => !a.hires[i].taskId || TERMINAL.has(t.status ?? ""));
  if (allDone) {
    const parts = a.hires.map((h, i) => {
      const t = tasks[i];
      if (!h.taskId) return `**${h.name}** wasn't hired: ${h.error ?? "not paid"}.`;
      if (t.status === "completed") return `**${h.name}** finished:\n\n${(t.output ?? "").trim() || "(it returned nothing)"}\n\n[Receipt](/r/${h.taskId})`;
      return `**${h.name}** couldn't finish: ${t.error ?? "it failed"}. [Receipt](/r/${h.taskId})`;
    });
    const content = a.hires.length > 1 ? `Here are their answers, side by side.\n\n${parts.join("\n\n---\n\n")}` : parts[0];
    const m = addMessage(a.conversationId, a.owner, "assistant", content, { actionId: a.id });
    a.status = tasks.some((t) => t.status === "completed") ? "done" : "failed";
    a.resultMessageId = m.id;
    save(a);
    message = { id: m.id, content };
  }
  return { action: a, tasks, message };
}

/** The hires in a proposal that can't go ahead as proposed: the agent left, or its price moved. Checked before paying. */
export function staleHires(a: Pick<Action, "hires">): string[] {
  return a.hires.filter((h) => {
    const agent = getAgentById(h.agentId);
    return !agent || parsePriceToEth(agent.price ?? undefined) !== h.priceEth;
  }).map((h) => h.name);
}

type Refresh = { action: Action; tasks: { agentId: string; status: string | null; output: string | null; error: string | null }[]; message: { id: string; content: string } | null };

function finishWith(a: Action, content: string, status: "done" | "failed"): Refresh {
  const m = addMessage(a.conversationId, a.owner, "assistant", content, { actionId: a.id });
  a.status = status;
  a.resultMessageId = m.id;
  save(a);
  return { action: a, tasks: [], message: { id: m.id, content } };
}

/** Follow a running build: its stage, round and score as Studio has them; when it finishes, its result, once. */
function refreshBuild(a: Action): Refresh {
  const d = a.detail as BuildDetail;
  if (a.status !== "running" || !d.buildId) return { action: a, tasks: [], message: null };
  settleStale(d.buildId);
  const b = getBuild(d.buildId);
  if (!b) return finishWith(a, "That build is gone, so I stopped following it.", "failed");
  a.detail = { ...d, name: b.draft?.name ?? d.name, stage: b.status, round: roundsOf(b.id).length, score: b.score, error: b.error };
  if (!STUDIO_DONE.has(b.status)) { save(a); return { action: a, tasks: [], message: null }; }
  return finishWith(a, buildResult(b), b.status === "failed" || b.score === null ? "failed" : "done");
}

function refreshPublish(a: Action): Refresh {
  const d = a.detail as PublishDetail;
  if (a.status !== "running" || !d.agentId) return { action: a, tasks: [], message: null };
  return finishWith(a, `**${d.name}** is live on Axon at ${d.priceEth} ETH a task: [/agents/${d.agentId}](/agents/${d.agentId}). Anyone can hire it now, and what it earns is yours.`, "done");
}

/** What the page shows for a proposal. Public facts about the agents and the person's own task only. */
export function viewOf(a: Action) {
  return { id: a.id, kind: a.kind, detail: a.detail, status: a.status, task: a.task, summary: summaryOf(a), expiresAt: a.expiresAt, hires: a.hires.map(({ agentId, name, price, priceEth, taskId, error }) => ({ agentId, name, price, priceEth, taskId, error })), payTo: process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ?? null };
}

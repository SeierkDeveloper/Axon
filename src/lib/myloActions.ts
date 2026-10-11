// Mylo, phase 2: hires Mylo proposes and the person confirms. Mylo never spends: it writes down exactly what it would
// do (which agents, what task, at what price) and the page shows it. The person confirms, pays from their own wallet or
// their own on-chain allowance, and only then does the hire run, through Axon's ordinary hire route, which checks the
// payment on chain, refuses a payment used twice and keeps the allowance within its owner's limits. When the agents
// finish, their answers are added to the conversation.
//
// Phase 3 adds Studio: Mylo proposes a build from a sentence (the person taps Build it, and Studio writes the agent and
// tests it), changes a build when asked (and retests it), and proposes publishing a tested build at a price. Builds run
// within Studio's own daily limits; when one finishes, its score and weakest test are added to the conversation.
//
// Phase 4 adds the person's own things: withdrawing what their agents earned (Studio's payout sends it to the wallet
// that owns the agent and nowhere else, within its limits) and applying a better version Axon tested for a live agent.
//
// Phase 8 adds crews (a saved team run in order, each agent getting the task and the one before's answer, every step
// paid from the person's wallet when they confirm) and autopilot (a job on a schedule, Axon's retainers, paid from the
// person's own on-chain allowance on each run within its limits).

import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { getDb } from "./db";
import { getAgentById } from "./agents";
import { parsePriceToEth } from "./payments";
import { getTaskById } from "./tasks";
import { pagesOf } from "./taskPages";
import { addMessage } from "./myloStore";
import { getBuild, mayRun, mayStart, startDraft, tweakDraft, type Build } from "./studioDraft";
import { roundsOf, runBuild, settleStale } from "./studioTest";
import { publishBuild } from "./studioPublish";
import { earningsOf, withdraw } from "./studioWithdraw";
import { decideImprovement, proposalsOf } from "./studioImprove";
import { WITHDRAW } from "./studioPolicy";
import { shortWallet } from "./myloPolicy";
import { getCrew } from "./myloStore";
import { createRetainer, RetainerError } from "./retainers";
import { readCreate } from "./retainerApi";
import { describeSchedule } from "./retainerSchedule";
import { maxDailySpendWei } from "./retainerPolicy";
import { weiToEth } from "./money";
import { LIMITS, MIN_PUBLISH_SCORE, PRICE_ETH } from "./studioPolicy";
import { logger } from "./logger";
import { agentReads, filesEnabled, filesOfTask, fileTokenFor, fitForHire, passFiles } from "./agentFiles";
import { getMcpServerByAgentId } from "./mcp";
import { bringInEnabled, followUpEnabled } from "./followUp";
import { askEnabled } from "./ask";
import { planEnabled } from "./planFirst";
import { memoryEnabled } from "./agentMemory";
import { libraryOwnerOf } from "./library";
import { claimTokenFor } from "./claimToken";
import { waitingNotice } from "./myloWork";

/** How long a proposal can wait for its confirmation: prices move and people change their minds. */
export const PROPOSAL_MINUTES = 15;
/** A confirmation that set off just before the deadline still lands: paying in a wallet takes a minute. */
export const CONFIRM_GRACE_MINUTES = 5;
/** The longest task Mylo will hand an agent. */
export const TASK_CHARS = 4_000;

export interface Hire { agentId: string; name: string; price: string | null; priceEth: number | null; taskId: string | null; error: string | null }
export type ActionStatus = "proposed" | "running" | "done" | "failed" | "cancelled";
export type ActionKind = "hire" | "build" | "publish" | "withdraw" | "improve" | "crew" | "schedule";
/** A build: the sentence (or the change asked for), then the Studio build and how far it has got. */
export interface BuildDetail { sentence: string; change: string | null; buildId: string | null; name: string | null; stage: string | null; round: number; score: number | null; error: string | null; changing?: boolean }
/** A publish: the tested build, at the price shown when it was proposed. */
export interface PublishDetail { buildId: string; name: string; priceEth: number; score: number | null; agentId: string | null; error: string | null }
/** A withdrawal: which agent's earnings, how much, to which (the owner's own) wallet, and the transaction once sent. */
export interface WithdrawDetail { agentId: string; name: string; amountEth: number; to: string; txHash: string | null; sent: string | null; error: string | null }
/** Applying a better version Axon tested for a live agent. */
export interface ImproveDetail { improvementId: string; agentId: string; name: string; fromScore: number | null; toScore: number | null; error: string | null }
/** A crew run: its name, each step's role, the step working now, and the payment for each paid step. */
export interface CrewDetail { crewName: string; roles: string[]; current: number; payments: Record<string, string>; error: string | null }
/** A job on a schedule: what, when, at most how much a run and a day, and the retainer once it exists. */
export interface ScheduleDetail { agentId: string; name: string; schedule: Record<string, unknown>; scheduleText: string; maxPriceEth: number; maxPerDayEth: number; maxRuns: number | null; retainerId: string | null; nextRunAt: string | null; error: string | null }
/** A hire that continues a finished job, or shows its plan first; and which questions and plans were announced. */
export interface HireDetail { followUpOf: string | null; planFirst: boolean; told: string[] }
export type Detail = BuildDetail | PublishDetail | WithdrawDetail | ImproveDetail | CrewDetail | ScheduleDetail | HireDetail;
export interface Action { id: string; conversationId: string; owner: string; wallet: string; kind: ActionKind; task: string; hires: Hire[]; detail: Detail | null; status: ActionStatus; resultMessageId: string | null; expiresAt: string; createdAt: string }

/** Studio, as Mylo uses it. Swappable in tests, so no test calls a model. */
export const studio = { createRetainer: (w: string, input: Parameters<typeof createRetainer>[1]) => createRetainer(w, input), startDraft: (w: string, s: string) => startDraft(w, s), tweakDraft: (id: string, w: string, r: string) => tweakDraft(id, w, r), runBuild: (id: string) => runBuild(id), mayRun, mayStart, publishBuild, withdraw: (agentId: string, w: string, eth: number) => withdraw(agentId, w, eth), decideImprovement };

const now = () => new Date().toISOString();

interface Row { id: string; conversation_id: string; owner: string; wallet: string; kind: ActionKind; task: string; hires: string; detail: string | null; status: ActionStatus; result_message_id: string | null; expires_at: string; created_at: string }
const fromRow = (r: Row): Action => ({ id: r.id, conversationId: r.conversation_id, owner: r.owner, wallet: r.wallet, kind: r.kind, task: r.task, hires: JSON.parse(r.hires) as Hire[], detail: r.detail ? (JSON.parse(r.detail) as Detail) : null, status: r.status, resultMessageId: r.result_message_id, expiresAt: r.expires_at, createdAt: r.created_at });

/** Was this job hired through Mylo by this person? */
export function hiredThroughMylo(owner: string, taskId: string): boolean {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(taskId)) return false;
  const rows = getDb().prepare("SELECT hires FROM mylo_actions WHERE owner = ? AND hires LIKE ?").all(owner, `%${taskId}%`) as { hires: string }[];
  return rows.some((r) => (JSON.parse(r.hires) as Hire[]).some((h) => h.taskId === taskId));
}

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

function insert(ctx: { owner: string; wallet: string; conversationId: string }, kind: ActionKind, task: string, hires: Hire[], detail: Detail | null, status: ActionStatus = "proposed"): string {
  const id = randomUUID(), at = now(), expires = new Date(Date.now() + PROPOSAL_MINUTES * 60_000).toISOString();
  getDb().prepare("INSERT INTO mylo_actions (id, conversation_id, owner, wallet, kind, task, hires, detail, status, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, ctx.conversationId, ctx.owner, ctx.wallet.toLowerCase(), kind, task, JSON.stringify(hires), detail ? JSON.stringify(detail) : null, status, expires, at, at);
  return id;
}

/** What the person is asked to confirm, in words. */
function summaryOf(a: Pick<Action, "hires"> & Partial<Pick<Action, "kind" | "detail">>): string {
  if (a.kind === "build") { const d = a.detail as BuildDetail; return d.change ? `Change ${d.name ?? "the agent"}: "${d.change}", then test it again.` : `Build an agent: "${d.sentence}".`; }
  if (a.kind === "publish") { const d = a.detail as PublishDetail; return `Publish ${d.name} on Axon at ${d.priceEth} ETH a task.`; }
  if (a.kind === "withdraw") { const d = a.detail as WithdrawDetail; return `Withdraw ${d.amountEth} ETH that ${d.name} earned, to your wallet ${shortWallet(d.to)}.`; }
  if (a.kind === "crew") { const d = a.detail as CrewDetail; const cost = a.hires.reduce((x, h) => x + (h.priceEth ?? 0), 0); return `Run the crew "${d.crewName}": ${a.hires.map((h) => h.name).join(", then ")}${cost > 0 ? `, ${+cost.toFixed(8)} ETH in total` : ""}.`; }
  if (a.kind === "schedule") { const d = a.detail as ScheduleDetail; return `Put ${d.name} on autopilot: ${d.scheduleText.charAt(0).toLowerCase()}${d.scheduleText.slice(1)}, at most ${d.maxPriceEth} ETH a run from your allowance.`; }
  if (a.kind === "improve") { const d = a.detail as ImproveDetail; return `Apply the better version of ${d.name}${d.fromScore !== null && d.toScore !== null ? ` (tested ${d.fromScore} before, ${d.toScore} now)` : ""}.`; }
  const cost = a.hires.reduce((s, h) => s + (h.priceEth ?? 0), 0);
  const who = a.hires.map((h) => `${h.name} (${h.priceEth === null ? "free" : `${h.priceEth} ETH`})`).join(" and ");
  const how = (a.detail ?? null) as HireDetail | null;
  const plan = how?.planFirst ? " It shows its plan first and starts when you approve." : "";
  if (how?.followUpOf) return `Continue the job with ${who}: it carries on from the conversation and the files so far.${plan}`;
  return `Hire ${who} for this task${cost > 0 ? `, ${+cost.toFixed(8)} ETH in total` : ""}.${plan}`;
}

/** Write down a hire for the person to confirm. Returns it, or why not. Spends nothing. */
export function proposeHire(ctx: { wallet: string | null; owner: string; conversationId: string }, agentIds: string[], task: string, how: { followUpOf?: string | null; planFirst?: boolean } = {}): { id: string; summary: string } | string {
  if (!ctx.wallet) return "Sign in with your wallet first, and Mylo can set that hire up for you.";
  const t = task.replace(/\r\n/g, "\n").trim();
  if (t.length < 3) return "Say what the agent should do.";
  if (t.length > TASK_CHARS) return `Keep the task under ${TASK_CHARS.toLocaleString("en-US")} characters.`;
  // continuing a finished job: it must be theirs and finished, and it goes to one agent (by default the one that did it)
  let followUpOf: string | null = null;
  if (how.followUpOf && followUpEnabled()) {
    const parent = getTaskById(how.followUpOf.trim());
    const theirs = parent && (hiredThroughMylo(ctx.owner, parent.taskId) || libraryOwnerOf(parent.taskId) === `w:${ctx.wallet.toLowerCase()}`);
    if (!parent || !theirs) return "That is not one of their jobs. Use a task_id from your notes or from my_work.";
    if (parent.status !== "completed") return "That job has not finished yet. It can be continued once its answer is in.";
    followUpOf = parent.taskId;
    if (!agentIds.some((s) => s.trim())) agentIds = [parent.toAgent];
    if (new Set(agentIds.map((s) => s.trim()).filter(Boolean)).size > 1) return "A job is continued with one agent.";
    if (agentIds[0].trim() !== parent.toAgent && !bringInEnabled()) return `That job is continued with the agent that did it (${parent.toAgent}).`;
  }
  const ids = [...new Set(agentIds.map((s) => s.trim()).filter(Boolean))];
  if (!ids.length || ids.length > 3) return "Choose one agent, or two or three for a second opinion.";
  const hires: Hire[] = [];
  for (const id of ids) {
    const a = getAgentById(id);
    if (!a) return `There is no agent called ${id} on Axon.`;
    hires.push({ agentId: a.agentId, name: a.name, price: a.price ?? null, priceEth: parsePriceToEth(a.price ?? undefined), taskId: null, error: null });
  }
  const planFirst = Boolean(how.planFirst) && planEnabled();
  const detail: HireDetail | null = followUpOf || planFirst ? { followUpOf, planFirst, told: [] } : null;
  const id = insert({ ...ctx, wallet: ctx.wallet }, "hire", t, hires, detail);
  return { id, summary: summaryOf({ hires, kind: "hire", detail }) };
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
 * needs no confirmation. The writer can take a minute, so the change runs in the background and is followed like a
 * build: the card shows it being made, then tested, and the new score arrives in the conversation.
 */
export async function changeBuild(ctx: { wallet: string | null; owner: string; conversationId: string }, buildId: string, change: string): Promise<{ id: string; summary: string } | string> {
  if (!ctx.wallet) return "Sign in with your wallet first.";
  const me = ctx.wallet.toLowerCase();
  const b = getBuild(buildId);
  if (!b || b.wallet !== me) return "That isn't one of your builds.";
  if (!b.draft) return "This build has no draft to change yet.";
  if (b.status === "published") return "This agent is live, so this build can't change any more. Start a new build for a different version.";
  if (!["drafted", "ready", "stopped"].includes(b.status)) return `This build is ${b.status}. Wait for it to finish first.`;
  const ask = change.replace(/\s+/g, " ").trim();
  if (ask.length < 3) return "Say what to change.";
  if (ask.length > LIMITS.sentenceChars) return `Keep a change to ${LIMITS.sentenceChars} characters.`;
  const room = studio.mayRun(me);
  if (!room.ok) return room.reason;
  const detail: BuildDetail = { ...buildDetail(b.sentence, ask, b), stage: "changing", changing: true };
  const id = insert({ ...ctx, wallet: me }, "build", b.sentence, [], detail, "running");
  void (async () => {
    const done = await studio.tweakDraft(buildId, me, ask).catch((err: unknown) => (err instanceof Error ? err.message : "The writer did not answer."));
    const a = getAction(id, ctx.owner);
    if (!a) return;
    if (typeof done === "string") {
      a.detail = { ...(a.detail as BuildDetail), changing: false, stage: null, error: done };
      finishWith(a, /^that change/i.test(done) ? done : `That change couldn't be made: ${done}`, "failed");
      return;
    }
    a.detail = { ...(a.detail as BuildDetail), changing: false, stage: "testing", name: done.draft?.name ?? null };
    save(a);
    await studio.runBuild(buildId);
  })().catch((err) => logger.warn("mylo.change_failed", "A change Mylo started threw", { buildId, reason: err instanceof Error ? err.message : String(err) }));
  return { id, summary: summaryOf({ hires: [], kind: "build", detail }) };
}

/**
 * Write down taking out what one of the person's agents earned, for them to confirm. The money can only go to the
 * wallet that owns the agent; the amount is everything it can take out unless they name less.
 */
export function proposeWithdraw(ctx: { wallet: string | null; owner: string; conversationId: string }, agentId: string, amountEth?: number): { id: string; summary: string } | string {
  if (!ctx.wallet) return "Sign in with your wallet first.";
  const me = ctx.wallet.toLowerCase();
  const e = earningsOf(me).find((x) => x.agentId === agentId);
  if (!e) return "That isn't one of your Studio agents. Withdrawals are open for agents built in Agent Studio.";
  if (e.availableEth < WITHDRAW.minEth) return `${e.name} has ${e.availableEth} ETH to take out; the least you can withdraw is ${WITHDRAW.minEth} ETH.`;
  const amount = amountEth === undefined ? e.availableEth : amountEth;
  if (!Number.isFinite(amount) || amount < WITHDRAW.minEth) return `The least you can withdraw is ${WITHDRAW.minEth} ETH.`;
  if (amount > e.availableEth) return `${e.name} has ${e.availableEth} ETH to take out, less than that.`;
  if (amount > WITHDRAW.maxPerDayEth) return `At most ${WITHDRAW.maxPerDayEth} ETH can go out per day.`;
  const detail: WithdrawDetail = { agentId, name: e.name, amountEth: amount, to: me, txHash: null, sent: null, error: null };
  const id = insert({ ...ctx, wallet: me }, "withdraw", `withdraw ${amount} ETH from ${agentId}`, [], detail);
  return { id, summary: summaryOf({ hires: [], kind: "withdraw", detail }) };
}

/** Write down applying a better version Axon tested for one of the person's live agents, for them to confirm. */
export function proposeImprovement(ctx: { wallet: string | null; owner: string; conversationId: string }, improvementId: string): { id: string; summary: string } | string {
  if (!ctx.wallet) return "Sign in with your wallet first.";
  const me = ctx.wallet.toLowerCase();
  const p = proposalsOf(me).find((x) => x.id === improvementId);
  if (!p) return "There's no open improvement with that id for your agents.";
  const name = getAgentById(p.agentId)?.name ?? p.agentId;
  const detail: ImproveDetail = { improvementId, agentId: p.agentId, name, fromScore: p.fromScore, toScore: p.toScore, error: null };
  const id = insert({ ...ctx, wallet: me }, "improve", `apply improvement ${improvementId}`, [], detail);
  return { id, summary: summaryOf({ hires: [], kind: "improve", detail }) };
}

/** Write down running one of the person's saved crews on a task, for them to confirm and pay. */
export function proposeCrew(ctx: { wallet: string | null; owner: string; conversationId: string }, crewName: string, task: string): { id: string; summary: string } | string {
  if (!ctx.wallet) return "Sign in with your wallet first.";
  const crew = getCrew(ctx.wallet, crewName);
  if (!crew) return `There's no crew called "${crewName}". Save one first.`;
  const t = task.replace(/\r\n/g, "\n").trim();
  if (t.length < 3) return "Say what the crew should do.";
  if (t.length > TASK_CHARS) return `Keep the task under ${TASK_CHARS.toLocaleString("en-US")} characters.`;
  const hires: Hire[] = [];
  for (const m of crew.members) {
    const a = getAgentById(m.agentId);
    if (!a) return `${m.agentId} in this crew is no longer on Axon. Save the crew again without it.`;
    hires.push({ agentId: a.agentId, name: a.name, price: a.price ?? null, priceEth: parsePriceToEth(a.price ?? undefined), taskId: null, error: null });
  }
  const detail: CrewDetail = { crewName: crew.name, roles: crew.members.map((m) => m.role), current: 0, payments: {}, error: null };
  const id = insert({ ...ctx, wallet: ctx.wallet }, "crew", t, hires, detail);
  return { id, summary: summaryOf({ hires, kind: "crew", detail }) };
}

/** The schedule as the person said it, in the retainer's own shape. */
export interface ScheduleInput { kind: string; every_hours?: number; time?: string; time_zone?: string; day?: number }
const toSchedule = (s: ScheduleInput) => ({ kind: s.kind, everyHours: s.every_hours, time: s.time, timeZone: s.time_zone || "UTC", day: s.day });

/** Write down putting an agent on a schedule, paid from the person's allowance on each run, for them to confirm. */
export async function proposeSchedule(ctx: { wallet: string | null; owner: string; conversationId: string }, agentId: string, task: string, schedule: ScheduleInput, maxRuns?: number | null): Promise<{ id: string; summary: string } | string> {
  if (!ctx.wallet) return "Sign in with your wallet first.";
  const parsed = readCreate({ agentId, instructions: task, schedule: toSchedule(schedule), ...(maxRuns ? { maxRuns } : {}) });
  if (!parsed.ok) return ((await parsed.response.json()) as { error?: string }).error ?? "That schedule isn't valid.";
  const agent = getAgentById(agentId);
  if (!agent) return `There is no agent called ${agentId} on Axon.`;
  if (!agent.price) return "Autopilot is for paid agents: each run pays from your allowance.";
  const v = parsed.value;
  const detail: ScheduleDetail = { agentId, name: agent.name, schedule: toSchedule(schedule), scheduleText: describeSchedule(v.schedule), maxPriceEth: +weiToEth(v.maxPriceWei).toFixed(8), maxPerDayEth: +weiToEth(maxDailySpendWei(v.schedule, v.maxPriceWei)).toFixed(8), maxRuns: v.maxRuns ?? null, retainerId: null, nextRunAt: null, error: null };
  const id = insert({ ...ctx, wallet: ctx.wallet }, "schedule", v.instructions, [], detail);
  return { id, summary: summaryOf({ hires: [], kind: "schedule", detail }) };
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
  if (a.kind === "withdraw") return confirmWithdraw(a, wallet);
  if (a.kind === "improve") return confirmImprove(a, wallet);
  if (a.kind === "crew") return confirmCrew(a, wallet, c, createTask);
  if (a.kind === "schedule") return confirmSchedule(a, wallet);

  for (const h of a.hires) {
    const agent = getAgentById(h.agentId);
    if (!agent) { h.error = "This agent is no longer on Axon."; continue; }
    const priceNow = parsePriceToEth(agent.price ?? undefined);
    if (priceNow !== h.priceEth) { h.error = "Its price changed since Mylo proposed this. Ask Mylo again."; continue; }
    // Working with the agent: it may ask, it remembers the person, and the hire can continue a job or show its plan
    // first. The person's key goes along so the job joins their library; it pays for nothing by itself.
    const how = (a.detail ?? null) as HireDetail | null;
    const body: Record<string, unknown> = {
      to: h.agentId, task: a.task,
      ...(askEnabled() ? { allowQuestions: true } : {}),
      ...(memoryEnabled() ? { memory: true } : {}),
      ...(how?.planFirst ? { planFirst: true } : {}),
      ...(how?.followUpOf ? { followUpOf: how.followUpOf, followUpToken: claimTokenFor(how.followUpOf) } : {}),
    };
    const headers: Record<string, string> = { "x-forwarded-for": c.clientIp, ...(c.apiKey ? { "x-api-key": c.apiKey } : {}) };
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

/** Send the earnings, through Studio's payout: to the owner's wallet only, under its floor and daily ceiling. */
async function confirmWithdraw(a: Action, wallet: string): Promise<Action> {
  const d = a.detail as WithdrawDetail;
  const w = await studio.withdraw(d.agentId, wallet, d.amountEth);
  if (typeof w === "string") { a.detail = { ...d, error: w }; a.status = "failed"; }
  else if (w.status === "failed") { a.detail = { ...d, error: w.error ?? "The payout didn't go through. Nothing left your earnings." }; a.status = "failed"; }
  else a.detail = { ...d, txHash: w.txHash, sent: w.status };
  save(a);
  return a;
}

async function confirmImprove(a: Action, wallet: string): Promise<Action> {
  const d = a.detail as ImproveDetail;
  const r = studio.decideImprovement(d.improvementId, wallet, true);
  a.detail = typeof r === "string" ? { ...d, error: r } : { ...d, error: null };
  if (typeof r === "string") a.status = "failed";
  save(a);
  return a;
}

/** What one crew step is asked: its role, the task, and from the second step on, the one before's answer. */
/** For a job that used its browser: the sites it opened, in a line under the answer. */
export function sitesLine(taskId: string): string {
  const pages = pagesOf(taskId);
  if (!pages.length) return "";
  const hosts: string[] = [];
  for (const p of pages) {
    let host = "";
    try { host = new URL(p.url).hostname.replace(/^www\./, ""); } catch { continue; }
    // a host is letters, digits, dots and dashes: anything else is not written into the conversation
    if (/^[a-z0-9.-]{1,80}$/i.test(host) && !hosts.includes(host)) hosts.push(host);
  }
  if (!hosts.length) return "";
  const shown = hosts.slice(0, 5).join(", ") + (hosts.length > 5 ? ` and ${hosts.length - 5} more` : "");
  return `\n\nIt opened ${pages.length === 1 ? "1 page" : `${pages.length} pages`} in its browser: ${shown}.`;
}

function crewTask(a: Action, i: number, before: { name: string; role: string; output: string } | null): string {
  const role = (a.detail as CrewDetail).roles[i];
  const head = role ? `Your part in this crew: ${role}.\n\n` : "";
  if (!before) return `${head}${a.task}`;
  return `${head}The task: ${a.task}\n\nThe step before you (${before.name}${before.role ? `, ${before.role}` : ""}) produced:\n\n${before.output.slice(0, 6000)}`;
}

/** The files a crew step is handed from the step before it, as the hire route takes them. Empty while files are off. */
function crewFiles(a: Action, i: number): { id: string; token: string }[] {
  const prev = i > 0 ? a.hires[i - 1]?.taskId : null;
  if (!prev || !filesEnabled()) return [];
  try {
    const agent = getAgentById(a.hires[i].agentId);
    if (!agent) return [];
    const fit = fitForHire(
      [...filesOfTask(prev, "out").reverse(), ...filesOfTask(prev, "in")],
      agentReads(agent, { runsThroughMcp: Boolean(getMcpServerByAgentId(agent.agentId)) }),
      a.hires[i].priceEth !== null,
    );
    return passFiles(fit.rows, null).map((f) => ({ id: f.id, token: fileTokenFor(f.id) }));
  } catch {
    return []; // a crew goes on without the files rather than stopping over them
  }
}

/** Hand one crew step to the hire route, paid by its own payment from the person's wallet (or free). */
async function startCrewStep(a: Action, i: number, wallet: string, createTask: CreateTask, before: { name: string; role: string; output: string } | null): Promise<void> {
  const d = a.detail as CrewDetail, h = a.hires[i];
  const body: Record<string, unknown> = { to: h.agentId, task: crewTask(a, i, before), from: "anonymous" };
  if (h.priceEth !== null) Object.assign(body, { paymentSignature: d.payments[h.agentId], payerWallet: wallet });
  // Files travel with the work: what the step before made, and what it was itself working from, go to this step as
  // far as one hire of this agent may carry. They wait as copies for the hire route to take, exactly as uploads do.
  const handed = crewFiles(a, i);
  if (handed.length) body.files = handed;
  try {
    const r = await createTask(body, { "x-forwarded-for": "mylo-crew" });
    if (r.status >= 400) h.error = String(r.json.error ?? `The hire was refused (${r.status}).`);
    else if (h.priceEth !== null && r.replay) h.error = "That payment was already used for another hire.";
    else h.taskId = String(r.json.taskId);
  } catch (err) {
    h.error = err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : "The hire failed.";
  }
}

/** Start a crew: every paid step must be paid first; then the first step runs and the rest follow one by one. */
async function confirmCrew(a: Action, wallet: string, c: Confirm, createTask: CreateTask): Promise<Action> {
  const d = a.detail as CrewDetail;
  if (c.method !== "wallet") { a.detail = { ...d, error: "A crew is paid from your wallet, one payment per paid step." }; a.status = "failed"; save(a); return a; }
  const unpaid = a.hires.filter((h) => h.priceEth !== null && !/^0x[0-9a-fA-F]{64}$/.test(c.payments?.[h.agentId] ?? ""));
  if (unpaid.length) { a.detail = { ...d, error: `Not paid: ${unpaid.map((h) => h.name).join(", ")}. Nothing ran.` }; a.status = "failed"; save(a); return a; }
  a.detail = { ...d, payments: Object.fromEntries(a.hires.filter((h) => h.priceEth !== null).map((h) => [h.agentId, c.payments![h.agentId]])), current: 0 };
  await startCrewStep(a, 0, wallet, createTask, null);
  if (!a.hires[0].taskId) a.status = "failed";
  save(a);
  return a;
}

/**
 * Move a running crew along: when the step working now has finished, start the next with its answer. Called when the
 * page asks how it is going and by Mylo's background pass, so a crew keeps going with the page closed.
 */
export async function advanceCrew(id: string, owner: string, createTask: CreateTask = realCreateTask): Promise<void> {
  const a = getAction(id, owner);
  if (!a || a.kind !== "crew" || a.status !== "running") return;
  const d = a.detail as CrewDetail, h = a.hires[d.current];
  const t = h?.taskId ? getTaskById(h.taskId) : null;
  if (!t || t.status !== "completed" || d.current >= a.hires.length - 1) return;
  // claim the move to the next step, so two callers at once can't both start it
  const next = d.current + 1;
  a.detail = { ...d, current: next };
  const claimed = getDb().prepare("UPDATE mylo_actions SET detail = ?, updated_at = ? WHERE id = ? AND detail = ?").run(JSON.stringify(a.detail), now(), a.id, JSON.stringify(d)).changes;
  if (!claimed) return;
  await startCrewStep(a, next, a.wallet, createTask, { name: h.name, role: d.roles[d.current] ?? "", output: t.output ?? "" });
  save(a);
}

/** Every running crew, moved along. Mylo's background pass runs this. */
export async function advanceRunningCrews(createTask: CreateTask = realCreateTask): Promise<number> {
  const rows = getDb().prepare("SELECT id, owner FROM mylo_actions WHERE kind = 'crew' AND status = 'running'").all() as { id: string; owner: string }[];
  for (const r of rows) { await advanceCrew(r.id, r.owner, createTask); refreshAction(r.id, r.owner); }
  return rows.length;
}

/** Start the schedule: the retainer, owned by the person's wallet, paid from their allowance on each run. */
async function confirmSchedule(a: Action, wallet: string): Promise<Action> {
  const d = a.detail as ScheduleDetail;
  const parsed = readCreate({ agentId: d.agentId, instructions: a.task, schedule: d.schedule, ...(d.maxRuns ? { maxRuns: d.maxRuns } : {}) });
  if (!parsed.ok) { a.detail = { ...d, error: ((await parsed.response.json()) as { error?: string }).error ?? "That schedule isn't valid." }; a.status = "failed"; save(a); return a; }
  try {
    const r = await studio.createRetainer(wallet, parsed.value);
    a.detail = { ...d, retainerId: r.retainerId, nextRunAt: r.nextRunAt };
  } catch (err) {
    a.detail = { ...d, error: err instanceof RetainerError || err instanceof Error ? err.message : "The schedule couldn't start." };
    a.status = "failed";
  }
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
  if (a.kind === "withdraw") return refreshWithdraw(a);
  if (a.kind === "improve") return refreshImprove(a);
  if (a.kind === "crew") return refreshCrew(a);
  if (a.kind === "schedule") return refreshSchedule(a);
  const tasks = a.hires.map((h) => {
    const t = h.taskId ? getTaskById(h.taskId) : null;
    return { agentId: h.agentId, status: t?.status ?? null, output: t?.status === "completed" ? (t.output ?? null) : null, error: h.error ?? (t?.status === "failed" ? (t.error ?? "It failed.") : null) };
  });
  let message: { id: string; content: string } | null = null;
  // A job that stopped to ask, or whose plan waits: said in the conversation, once for each question and plan.
  if (a.status === "running") {
    const how: HireDetail = (a.detail as HireDetail | null) ?? { followUpOf: null, planFirst: false, told: [] };
    for (const h of a.hires) {
      const notice = h.taskId ? waitingNotice(h.taskId, h.name) : null;
      if (!notice || how.told.includes(notice.mark)) continue;
      const m = addMessage(a.conversationId, a.owner, "assistant", notice.text, { actionId: a.id });
      a.detail = { ...how, told: [...how.told, notice.mark] };
      save(a);
      return { action: a, tasks, message: { id: m.id, content: notice.text } };
    }
  }
  const started = a.hires.filter((h) => h.taskId);
  const allDone = a.status === "running" && started.length > 0 && tasks.every((t, i) => !a.hires[i].taskId || TERMINAL.has(t.status ?? ""));
  if (allDone) {
    const parts = a.hires.map((h, i) => {
      const t = tasks[i];
      if (!h.taskId) return `**${h.name}** wasn't hired: ${h.error ?? "not paid"}.`;
      if (t.status === "completed") return `**${h.name}** finished:\n\n${(t.output ?? "").trim() || "(it returned nothing)"}${sitesLine(h.taskId)}\n\n[Receipt](/r/${h.taskId})`;
      if (t.status === "cancelled") return `**${h.name}**'s job was called off before it delivered. Whatever was paid for it is refunded. [Receipt](/r/${h.taskId})`;
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
  // a change still being written leaves the build as it was: nothing to follow yet
  if (a.status !== "running" || !d.buildId || d.changing) return { action: a, tasks: [], message: null };
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

function refreshWithdraw(a: Action): Refresh {
  const d = a.detail as WithdrawDetail;
  if (a.status !== "running" || !d.sent) return { action: a, tasks: [], message: null };
  const what = `${d.amountEth} ETH that **${d.name}** earned`;
  return finishWith(a, d.sent === "sent" ? `Sent ${what} to your wallet ${shortWallet(d.to)}. The transaction is on the card above.` : `${what} is on its way to your wallet ${shortWallet(d.to)}. The transaction is on the card above.`, "done");
}

/** A crew's progress; when the last step finishes (or one fails), its result in the conversation, once. */
function refreshCrew(a: Action): Refresh {
  const d = a.detail as CrewDetail;
  const tasks = a.hires.map((h) => { const t = h.taskId ? getTaskById(h.taskId) : null; return { agentId: h.agentId, status: t?.status ?? null, output: t?.status === "completed" ? (t.output ?? null) : null, error: h.error ?? (t?.status === "failed" ? (t.error ?? "It failed.") : null) }; });
  if (a.status !== "running") return { action: a, tasks, message: null };
  const step = (i: number) => `${i + 1}. **${a.hires[i].name}**${d.roles[i] ? ` (${d.roles[i]})` : ""}${a.hires[i].taskId ? `: [receipt](/r/${a.hires[i].taskId})` : ""}`;
  const broke = tasks.findIndex((t, i) => i <= d.current && (t.error || t.status === "failed"));
  if (broke >= 0) {
    const r = finishWith(a, `The crew "${d.crewName}" stopped at step ${broke + 1}, ${a.hires[broke].name}: ${tasks[broke].error ?? "it didn't finish"}. Steps after it didn't run.\n\n${a.hires.slice(0, broke + 1).map((_, i) => step(i)).join("\n")}`, "failed");
    return { ...r, tasks };
  }
  const last = a.hires.length - 1;
  if (d.current === last && tasks[last].status === "completed") {
    const r = finishWith(a, `The crew "${d.crewName}" finished. Here is the final result, from ${a.hires[last].name}:\n\n${(tasks[last].output ?? "").trim() || "(it returned nothing)"}\n\n---\n\n${a.hires.map((_, i) => step(i)).join("\n")}`, "done");
    return { ...r, tasks };
  }
  return { action: a, tasks, message: null };
}

function refreshSchedule(a: Action): Refresh {
  const d = a.detail as ScheduleDetail;
  if (a.status !== "running" || !d.retainerId) return { action: a, tasks: [], message: null };
  const next = d.nextRunAt ? new Date(d.nextRunAt).toUTCString().replace(":00 GMT", " UTC") : null;
  return finishWith(a, `**${d.name}** is on autopilot: ${d.scheduleText.charAt(0).toLowerCase()}${d.scheduleText.slice(1)}${next ? `, first run ${next}` : ""}. Each run pays at most ${d.maxPriceEth} ETH from your allowance. Ask me to pause or stop it any time.`, "done");
}

function refreshImprove(a: Action): Refresh {
  const d = a.detail as ImproveDetail;
  if (a.status !== "running") return { action: a, tasks: [], message: null };
  return finishWith(a, `**${d.name}** now runs the better version${d.toScore !== null ? `, which tested ${d.toScore}/10` : ""}. Its next jobs use it.`, "done");
}

/** What the page shows for a proposal. Public facts about the agents and the person's own task only. */
export function viewOf(a: Action) {
  return { id: a.id, kind: a.kind, detail: a.detail, status: a.status, task: a.task, summary: summaryOf(a), expiresAt: a.expiresAt, hires: a.hires.map(({ agentId, name, price, priceEth, taskId, error }) => ({ agentId, name, price, priceEth, taskId, error })), payTo: process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ?? null };
}

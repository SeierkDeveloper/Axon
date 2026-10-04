// Mylo, phase 2: hires Mylo proposes and the person confirms. Mylo never spends: it writes down exactly what it would
// do (which agents, what task, at what price) and the page shows it. The person confirms, pays from their own wallet or
// their own on-chain allowance, and only then does the hire run, through Axon's ordinary hire route, which checks the
// payment on chain, refuses a payment used twice and keeps the allowance within its owner's limits. When the agents
// finish, their answers are added to the conversation.

import { randomUUID } from "crypto";
import { NextRequest } from "next/server";
import { getDb } from "./db";
import { getAgentById } from "./agents";
import { parsePriceToEth } from "./payments";
import { getTaskById } from "./tasks";
import { addMessage } from "./myloStore";

/** How long a proposal can wait for its confirmation: prices move and people change their minds. */
export const PROPOSAL_MINUTES = 15;
/** A confirmation that set off just before the deadline still lands: paying in a wallet takes a minute. */
export const CONFIRM_GRACE_MINUTES = 5;
/** The longest task Mylo will hand an agent. */
export const TASK_CHARS = 4_000;

export interface Hire { agentId: string; name: string; price: string | null; priceEth: number | null; taskId: string | null; error: string | null }
export type ActionStatus = "proposed" | "running" | "done" | "failed" | "cancelled";
export interface Action { id: string; conversationId: string; owner: string; wallet: string; kind: "hire"; task: string; hires: Hire[]; status: ActionStatus; resultMessageId: string | null; expiresAt: string; createdAt: string }

const now = () => new Date().toISOString();

interface Row { id: string; conversation_id: string; owner: string; wallet: string; kind: "hire"; task: string; hires: string; status: ActionStatus; result_message_id: string | null; expires_at: string; created_at: string }
const fromRow = (r: Row): Action => ({ id: r.id, conversationId: r.conversation_id, owner: r.owner, wallet: r.wallet, kind: r.kind, task: r.task, hires: JSON.parse(r.hires) as Hire[], status: r.status, resultMessageId: r.result_message_id, expiresAt: r.expires_at, createdAt: r.created_at });

export function getAction(id: string, owner: string): Action | null {
  const r = getDb().prepare("SELECT * FROM mylo_actions WHERE id = ? AND owner = ?").get(id, owner) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function actionsOf(conversationId: string, owner: string): Action[] {
  return (getDb().prepare("SELECT * FROM mylo_actions WHERE conversation_id = ? AND owner = ? ORDER BY created_at").all(conversationId, owner) as Row[]).map(fromRow);
}

function save(a: Action) {
  getDb().prepare("UPDATE mylo_actions SET hires = ?, status = ?, result_message_id = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(a.hires), a.status, a.resultMessageId, now(), a.id);
}

/** What the person is asked to confirm, in words. */
export function summaryOf(a: Pick<Action, "hires">): string {
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
  const id = randomUUID(), at = now(), expires = new Date(Date.now() + PROPOSAL_MINUTES * 60_000).toISOString();
  getDb().prepare("INSERT INTO mylo_actions (id, conversation_id, owner, wallet, kind, task, hires, status, expires_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, ctx.conversationId, ctx.owner, ctx.wallet.toLowerCase(), "hire", t, JSON.stringify(hires), "proposed", expires, at, at);
  return { id, summary: summaryOf({ hires }) };
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

const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

/**
 * Where a running proposal has got to. Once every hire has finished, their answers are written into the conversation
 * as Mylo's message, once.
 */
export function refreshAction(id: string, owner: string): { action: Action; tasks: { agentId: string; status: string | null; output: string | null; error: string | null }[]; message: { id: string; content: string } | null } | string {
  const a = getAction(id, owner);
  if (!a) return "No such proposal.";
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

/** What the page shows for a proposal. Public facts about the agents and the person's own task only. */
export function viewOf(a: Action) {
  return { id: a.id, status: a.status, task: a.task, summary: summaryOf(a), expiresAt: a.expiresAt, hires: a.hires.map(({ agentId, name, price, priceEth, taskId, error }) => ({ agentId, name, price, priceEth, taskId, error })), payTo: process.env.NEXT_PUBLIC_PAYMENT_RECEIVER_WALLET_ADDRESS ?? null };
}

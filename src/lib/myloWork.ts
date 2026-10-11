// Work with your agent, through Mylo.
//
// What a person can do with a hire on an agent's page they can ask Mylo to do: continue a finished job, answer the
// question an agent stopped to ask, approve or change its plan, tell a running job something or stop it, and look
// through what agents have done for them before. Mylo acts only on jobs that are the person's own: hired through
// Mylo by them, or in their wallet's library.
//
// Each tool follows the switch of its feature. With all of them off Mylo's tools and instructions are unchanged.

import { getTaskById } from "./tasks";
import { getAgentById } from "./agents";
import { followUpEnabled, bringInEnabled } from "./followUp";
import { answerQuestion, askEnabled, questionsView } from "./ask";
import { decidePlan, planEnabled, planView, type PlanAction } from "./planFirst";
import { sendNote, steerEnabled, stopJob } from "./steer";
import { memoryEnabled } from "./agentMemory";
import { conversationOf, conversationsOf, libraryEnabled, libraryOwnerOf } from "./library";
import { hiredThroughMylo } from "./myloActions";
import { browserEnabled } from "./agentBrowser";

type Input = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Is this job the person's own: hired by them through Mylo, or kept in their wallet's library? */
export function ownsJob(ctx: { wallet: string | null; owner: string }, taskId: string): boolean {
  if (!taskId || !ctx.wallet) return false;
  return hiredThroughMylo(ctx.owner, taskId) || libraryOwnerOf(taskId) === `w:${ctx.wallet.toLowerCase()}`;
}

const TASK_ID = { type: "string", description: "The job's task_id, from your notes or from my_work" } as const;

/** What hire_agent also takes, by what is switched on. */
export function myloHireProps(): Record<string, unknown> {
  return {
    ...(followUpEnabled() ? { follow_up_of: { type: "string", description: `To continue a finished job instead of starting over: its task_id, from your notes or from my_work. The agent gets the conversation so far and the files from before, so task is only what the person says next. One agent: the one that did the job${bringInEnabled() ? ", or another agent to bring in" : ""}.` } } : {}),
    ...(planEnabled() ? { plan_first: { type: "boolean", description: "True to have the agent show its plan and wait for the person's OK before it starts. Use it for a bigger job, or when they ask to see the plan." } } : {}),
  };
}

/** The tools this adds, as the model sees them. */
export function myloWorkTools(): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  const tools: { name: string; description: string; input_schema: Record<string, unknown> }[] = [];
  if (askEnabled()) tools.push({ name: "answer_agent", description: "Pass the person's answer on to an agent that stopped to ask them a question. Only their own answer, in their words: never answer for them.", input_schema: { type: "object", properties: { task_id: TASK_ID, answer: { type: "string" } }, required: ["task_id", "answer"] } });
  if (planEnabled()) tools.push({ name: "decide_plan", description: "Pass on what the person decided about an agent's plan: approve starts the work, change has the agent write the plan again from what they said, cancel ends the job before any work and refunds what was paid. Only after they have seen the plan and said so.", input_schema: { type: "object", properties: { task_id: TASK_ID, decision: { type: "string", enum: ["approve", "change", "cancel"] }, change: { type: "string", description: "With change: what should be different" } }, required: ["task_id", "decision"] } });
  if (steerEnabled()) tools.push({ name: "steer_job", description: "While a job is running: tell the agent something it should take into account (note), or stop the job (stop: true) when the person says to. A stopped job delivers nothing and is refunded.", input_schema: { type: "object", properties: { task_id: TASK_ID, note: { type: "string" }, stop: { type: "boolean" } }, required: ["task_id"] } });
  if (libraryEnabled()) tools.push({ name: "my_work", description: "What agents have done for the person: their conversations with agents, the latest first, each with the task_id of its latest job. Give a thread to read one conversation in full. Use it to find a job to continue, or to answer what an agent told them before.", input_schema: { type: "object", properties: { thread: { type: "string", description: "A conversation from the list" } } } });
  return tools;
}

/**
 * Added to Mylo's instructions while agents have a browser: what an agent can do with a website, what it never
 * does, and that it is the agent that browses, not Mylo.
 */
export function myloBrowserNote(): string {
  if (!browserEnabled()) return "";
  return `\n\nAgents that use the internet:
- An agent Axon runs can open websites in a real browser when the job names one or asks it to go somewhere. It reads
  the page as it is drawn, clicks, scrolls, compares several pages, fills in forms, and saves a page (as a picture, a
  PDF or text) or downloads a file from it. For a job about a website (read this page, compare these sites, get this
  file, fill in this form), propose a hire and put the site's address in the task, as the person gave it.
  agent_details says whether an agent browses (browses: true). You do not browse yourself: never say you opened or
  read a page.
- What it never does: sign in anywhere, type a password or a card number, press a button that pays or orders, or
  solve a CAPTCHA. It sends a form only when the task asks for that in words, and the result then shows exactly what
  was sent. Never promise any of these, and say so plainly when a job needs one of them.
- The browser is the agent's own and starts empty on every job. It is not the person's browser: nothing they are
  signed in to is signed in there, and signing in themselves first changes nothing. A page behind a sign-in cannot
  be read at all. Say that, and offer what is public instead. Never suggest a way around it.
- A hire made on an agent's own page shows each step with a picture of the page while it works. A hire made through
  you comes back with the answer and the sites it opened, and their library on /dashboard lists every page. Say what
  the agent found, not that you saw the pages.
- A person can have a page watched: on /dashboard, under triggers, "A web page changes" starts their agent when the
  page changes. You cannot set that up from here; point them to /dashboard.`;
}

export const MYLO_WORK_LABELS: Record<string, string> = { answer_agent: "Passing your answer on", decide_plan: "Passing your decision on", steer_job: "Telling the agent", my_work: "Looking at your work" };

/** Added to Mylo's instructions while any of this is switched on. */
export function myloWorkNote(): string {
  const lines: string[] = [];
  if (followUpEnabled()) lines.push("- A finished hire can be continued: call hire_agent with follow_up_of set to that job's task_id and task set to what the person says next. The agent carries on from the conversation and the files from before. When the person asks for a change, a detail or the next step on something an agent already did for them, continue that job; do not start a new hire for it. It is proposed and confirmed like any hire, at the agent's price. After proposing it, stop: say it waits for their OK and nothing more. Never write what the agent will answer, not even a likely version: its answer arrives by itself when it has run.");
  if (askEnabled()) lines.push("- An agent may stop to ask the person a question. The question arrives in the conversation by itself. When the person answers, pass it on with answer_agent. Never answer for them.");
  if (planEnabled()) lines.push("- With plan_first the agent shows its plan before it starts; the plan arrives in the conversation by itself. When the person says yes, what to change, or cancel, pass it on with decide_plan. Never approve a plan they have not seen.");
  if (steerEnabled()) lines.push("- steer_job tells a running job something, or stops it when the person says stop. A stopped job is refunded. Only the tool does it: saying a job is stopped, or that an answer was passed on, without calling the tool leaves everything as it was.");
  if (libraryEnabled()) lines.push("- my_work lists what agents have done for the person before, with the task_id to continue each. Their library is also on /dashboard.");
  if (memoryEnabled()) lines.push("- Agents hired here remember the person on the next hire: what they prefer and what was done for them before.");
  return lines.length ? `\n\nWorking with an agent after it is hired:\n${lines.join("\n")}` : "";
}

const cut = (s: string | null, most: number): string | null => (s && s.length > most ? `${s.slice(0, most)} [cut short here]` : s);

/** Run one of the tools above. Undefined for a name that is not one of them, or whose feature is switched off. */
export function runMyloWorkTool(name: string, input: Input, ctx: { wallet: string | null; owner: string }): unknown | undefined {
  if (name === "my_work") {
    if (!libraryEnabled()) return undefined;
    if (!ctx.wallet) return { error: "Sign in with your wallet first." };
    const owners = [`w:${ctx.wallet.toLowerCase()}`];
    if (text(input.thread)) {
      const whole = conversationOf(owners, text(input.thread));
      if (!whole) return { error: "That conversation is not in their library." };
      return { thread: whole.thread, turns: whole.turns.map((t) => ({ task_id: t.taskId, agent: t.agent.name, agent_id: t.agent.id, asked: cut(t.task, 600), status: t.status, answer: cut(t.output, 2_500), files: t.outputFiles.map((f) => `${f.name}${f.version && f.version > 1 ? ` (version ${f.version})` : ""}`), receipt: t.receipt })), note: "To continue it, propose hire_agent with follow_up_of set to the last finished turn's task_id." };
    }
    const list = conversationsOf(owners, { limit: 15 });
    return { conversations: list.map((c) => ({ thread: c.thread, agents: c.agents, began: c.asked, turns: c.turns, files: c.files, status: c.status, last_task_id: c.lastTaskId, last_agent_id: c.lastAgent.id, last_at: c.lastAt })), note: list.length ? "Their full library, with every file and receipt, is on /dashboard." : "Nothing yet. Hires made while signed in are kept here." };
  }
  const acts = (name === "answer_agent" && askEnabled()) || (name === "decide_plan" && planEnabled()) || (name === "steer_job" && steerEnabled());
  if (!acts) return undefined;
  const taskId = text(input.task_id), job = taskId ? getTaskById(taskId) : null;
  // a job that is not theirs is answered exactly like one that does not exist
  if (!job || !ownsJob(ctx, taskId)) return { error: "That is not one of their jobs. Use a task_id from your notes or from my_work." };
  const who = getAgentById(job.toAgent)?.name ?? job.toAgent;
  if (name === "answer_agent") {
    const done = answerQuestion(taskId, text(input.answer));
    if (!done.ok) return { error: done.refused === "not_waiting" ? `${who} is not waiting on a question right now.` : done.reason };
    return { passed_on: true, note: `${who} has the answer and is working again. Its result arrives in the conversation by itself. Say that in a sentence.` };
  }
  if (name === "decide_plan") {
    const action = (["approve", "change", "cancel"] as PlanAction[]).find((a) => a === input.decision);
    if (!action) return { error: "decision is approve, change or cancel." };
    const done = decidePlan(taskId, action, text(input.change) || null);
    if (!done.ok) return { error: done.refused === "not_waiting" ? `${who} has no plan waiting right now.` : done.reason };
    return { passed_on: true, note: action === "approve" ? `${who} has started the work. Its result arrives in the conversation by itself.` : action === "change" ? `${who} is writing the plan again. The new plan arrives in the conversation by itself.` : "Cancelled before any work. Whatever was paid for it is refunded." };
  }
  if (input.stop === true) {
    const done = stopJob(taskId);
    if (!done.ok) return { error: done.reason };
    return { stopped: true, note: "Stopped. Nothing is delivered, and whatever was paid for it is refunded." };
  }
  if (!text(input.note)) return { error: "Give the note to pass on, or stop: true." };
  const sent = sendNote(taskId, text(input.note));
  if (!sent.ok) return { error: sent.reason };
  return { passed_on: true, note: `${who} reads it at its next step, or before it finishes.` };
}

/** What a job that waits on the person is announced with in the conversation, and the mark that says it was announced. */
export function waitingNotice(taskId: string, agentName: string): { mark: string; text: string } | null {
  const job = getTaskById(taskId);
  if (!job || job.status !== "waiting") return null;
  const { question } = questionsView(job);
  if (question) {
    const choices = question.choices?.length ? `\n\n${question.choices.map((c) => `- ${c}`).join("\n")}` : "";
    return { mark: `${taskId}:q${question.n}`, text: `**${agentName}** has a question before it goes on:\n\n${question.text}${choices}\n\nTell me your answer and I'll pass it on.` };
  }
  const { plan } = planView(job);
  if (plan) return { mark: `${taskId}:p${plan.n}`, text: `**${agentName}** wrote its plan and waits for your OK:\n\n${plan.text}\n\nSay go ahead, tell me what to change, or cancel${plan.price ? " and your payment is refunded" : ""}.` };
  return null;
}

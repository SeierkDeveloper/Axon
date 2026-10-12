// Work with your agent, inside an assistant (Claude, Cursor, ChatGPT, Grok).
//
// What a hire can do on the site it can do through the tool layer: a finished job is followed up, the agent may
// stop to ask and is answered, a plan is approved or changed before the work starts, a running job is told
// something or stopped, the agent remembers the wallet behind the connection, and the library is read back.
//
// Everything here follows the switches of the features themselves. With all of them off this adds nothing: the
// hire tool takes what it took, reading a result says what it said, and no tool is added.

import { NextRequest } from "next/server";
import { getTaskById, type Task } from "./tasks";
import { authenticateApiKey } from "./identity";
import { bringInEnabled, followUpEnabled, followUpView } from "./followUp";
import { answerQuestion, askEnabled, questionsView } from "./ask";
import { decidePlan, planEnabled, planView, type PlanAction } from "./planFirst";
import { sendNote, steerEnabled, steerView, stopJob } from "./steer";
import { memoryEnabled, memoryOwnerFor, rememberedBy, validMemoryKey } from "./agentMemory";
import { conversationOf, conversationsOf, filesOf, libraryEnabled } from "./library";
import { officeEnabled } from "./officeFiles";
import { filesEnabled } from "./agentFiles";
import { claimTokenValid } from "./claimToken";
import type { McpTool } from "./mcpServer";

type Args = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** What the hire tool also takes, by what is switched on. */
export function hireWorkProperties(): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (followUpEnabled()) {
    p.followUpOf = {
      type: "string",
      description: `Continue a finished job instead of starting over: the taskId of the job to follow up. The agent is given the conversation so far and the files from before, and \`task\` is what you say next. Leave agentId out to stay with the agent that did the job${bringInEnabled() ? ", or name another agent to bring it into the conversation" : ""}. A follow-up is a hire of its own, with its own price and receipt`,
    };
    p.followUpToken = { type: "string", description: "With followUpOf: the claimToken hire_agent returned for that job. It proves the job is yours" };
  }
  if (askEnabled()) p.allowQuestions = { type: "boolean", description: "Set true to let the agent stop and ask when something it needs is unclear. get_task_result then says status \"waiting\" with the question; answer it with answer_agent. Unanswered, the job goes on by itself after a while" };
  if (planEnabled()) p.planFirst = { type: "boolean", description: "Set true to have the agent say what it will do before it starts. get_task_result then says status \"waiting\" with the plan; approve it, ask for a change or cancel with decide_plan. Cancelling refunds what was paid" };
  if (memoryEnabled()) {
    p.memory = { type: "boolean", description: "Set true and the agent is told what it noted about you on earlier jobs, and may note more for next time. Kept per person and per agent: the wallet behind this connection's key, or without a key the memoryKey you send" };
    p.memoryKey = { type: "string", description: "Without a key on this connection: a long random string (32 to 128 letters, digits, - or _) that you keep and send on every hire. It names your memory with agents, and your library. Only its hash is stored" };
  }
  return p;
}

/** The fields a hire carries on to the hire route, from what the tool was given. Unknown or switched-off ones are dropped. */
export function hireWorkBody(args: Args): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  if (followUpEnabled() && text(args.followUpOf)) {
    b.followUpOf = text(args.followUpOf);
    if (text(args.followUpToken)) b.followUpToken = text(args.followUpToken);
  }
  if (askEnabled() && args.allowQuestions === true) b.allowQuestions = true;
  if (planEnabled() && args.planFirst === true) b.planFirst = true;
  if (memoryEnabled() && typeof args.memory === "boolean") b.memory = args.memory;
  // the key names the library too, so it is passed on whenever either is on
  if ((memoryEnabled() || libraryEnabled()) && validMemoryKey(args.memoryKey)) b.memoryKey = args.memoryKey;
  return b;
}

/** The agent a hire goes to when none is named: the one that did the job it follows. */
export function followedAgent(args: Args): string {
  if (!followUpEnabled() || !text(args.followUpOf)) return "";
  return getTaskById(text(args.followUpOf))?.toAgent ?? "";
}

/** What the hire tool says about itself on top of its standing words. */
export function hireWorkNote(): string {
  const can: string[] = [];
  if (followUpEnabled()) can.push("continue a finished job with followUpOf");
  if (askEnabled()) can.push("let the agent ask with allowQuestions");
  if (planEnabled()) can.push("see its plan first with planFirst");
  if (filesEnabled() && officeEnabled()) can.push("hand it Word, Excel and PowerPoint files and ask for one back");
  return can.length ? ` You can also ${can.join(", ")}.` : "";
}

/** What reading a job says on top of its status and answer: what it waits on, and what can be done with it next. */
export function resultWork(task: Task): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const { question, questions } = questionsView(task);
  if (question) out.question = { text: question.text, ...(question.choices?.length ? { choices: question.choices } : {}), answerBy: question.answerBy, next: "The job is waiting on this. Ask the person, then call answer_agent with their answer." };
  else if (questions?.length) out.asked = questions.filter((q) => q.answeredAt).map((q) => ({ question: q.text, answer: q.answer ?? null, answeredBy: q.answeredHow === "timeout" ? "nobody, it went on by itself" : "you" }));
  const { plan } = planView(task);
  if (plan) out.plan = { text: plan.text, price: plan.price, answerBy: plan.answerBy, changesLeft: plan.changesLeft, next: "The job is waiting on this plan. Show it to the person, then call decide_plan: approve, change or cancel." };
  const { steer, notes } = steerView(task);
  if (steer && (steer.open || steer.stoppable)) out.whileItRuns = { ...(steer.open ? { notesLeft: steer.notesLeft } : {}), stoppable: steer.stoppable, next: "steer_task sends the agent a note or stops the job." };
  if (notes?.length) out.notes = notes.map((n) => ({ text: n.text, read: Boolean(n.deliveredAt) }));
  const follow = followUpView(task);
  if (follow) {
    out.conversation = { thread: follow.thread, turn: follow.turn, ...(follow.of ? { follows: follow.of } : {}) };
    if (follow.open) out.followUp = { turnsLeft: follow.turnsLeft, next: "To continue this job, call hire_agent with followUpOf set to this taskId and followUpToken set to its claimToken." };
  }
  if (memoryEnabled()) {
    const noted = rememberedBy(task.taskId).map((m) => m.text);
    if (noted.length) out.remembered = noted;
  }
  if (task.status === "cancelled") out.cancelled = "This job was called off before it delivered. Whatever was paid for it is refunded.";
  return out;
}

const JOB = { taskId: { type: "string" }, claimToken: { type: "string", description: "The claim token hire_agent returned for this job" } } as const;

/** The tools this adds, by what is switched on. */
export function workTools(): McpTool[] {
  const tools: McpTool[] = [];
  if (askEnabled()) tools.push({
    name: "answer_agent",
    description: "Answer the question a job is waiting on (get_task_result says status \"waiting\" with a question). The same job goes on with the answer; nothing is paid again. Ask the person first unless they already told you the answer.",
    inputSchema: { type: "object", properties: { ...JOB, answer: { type: "string", description: "The answer, in the person's words" } }, required: ["taskId", "claimToken", "answer"] },
  });
  if (planEnabled()) tools.push({
    name: "decide_plan",
    description: "Decide on the plan a job is waiting on (get_task_result says status \"waiting\" with a plan). approve starts the work; change has the agent write the plan again from what you say; cancel ends the job before any work and refunds what was paid. The decision is the person's: show them the plan first.",
    inputSchema: { type: "object", properties: { ...JOB, decision: { type: "string", enum: ["approve", "change", "cancel"] }, change: { type: "string", description: "With decision \"change\": what should be different" } }, required: ["taskId", "claimToken", "decision"] },
  });
  if (steerEnabled()) tools.push({
    name: "steer_task",
    description: "While a job runs: send the agent a note it reads at its next step (\"use euros\", \"skip the appendix\"), or stop the job. A stopped job delivers nothing, is refunded, and counts neither for nor against the agent. A finished job takes a follow-up instead.",
    inputSchema: { type: "object", properties: { ...JOB, note: { type: "string", description: "What to tell the agent" }, stop: { type: "boolean", description: "Set true to stop the job instead of sending a note" } }, required: ["taskId", "claimToken"] },
  });
  if (libraryEnabled()) tools.push({
    name: "get_library",
    description: "The person's library: every conversation they have had with agents, the latest first, and the files that came back. Give a thread to read one conversation in full, with each job's claimToken so it can be followed up; set files true to list the files instead. Needs a full Axon key on this connection (an allowance key reads only what it hired), or the memoryKey the hires used.",
    inputSchema: { type: "object", properties: { thread: { type: "string", description: "A conversation from the list: read it in full" }, agentId: { type: "string", description: "Only conversations this agent worked on" }, files: { type: "boolean", description: "List the files handed back, the latest version of each" }, memoryKey: { type: "string", description: "The key the hires used, when there is no Axon key on this connection" }, limit: { type: "number" } } },
  });
  return tools;
}

/** The job a tool call is about, once its claim token checks out. Otherwise the words to send back. */
function jobOf(args: Args): { job: Task } | { refused: { error: string } } {
  const taskId = text(args.taskId), token = text(args.claimToken);
  const no = (error: string) => ({ refused: { error } });
  if (!taskId || !token) return no("taskId and claimToken are required");
  if (!claimTokenValid(taskId, token)) return no("invalid claim token for this task");
  const job = getTaskById(taskId);
  return job ? { job } : no(`task '${taskId}' not found`);
}

/** Whose library this connection may read: the wallet of a full key, and the key it was handed. */
function libraryOwners(args: Args, apiKey: string | null, baseUrl: string): string[] | { error: string } {
  const owners: string[] = [];
  if (apiKey) {
    const user = authenticateApiKey(new NextRequest(`${baseUrl}/mcp`, { headers: { "x-api-key": apiKey } }));
    const byWallet = user ? memoryOwnerFor({ wallet: user.walletAddress }) : null;
    if (byWallet) owners.push(byWallet);
  }
  const byKey = memoryOwnerFor({ key: args.memoryKey });
  if (byKey) owners.push(byKey);
  if (owners.length) return owners;
  return { error: apiKey
    ? "The key on this connection is an allowance key: it reads the jobs it hired (get_task_result), not its owner's whole library. Use a full Axon key, or pass the memoryKey the hires used."
    : "The library needs a full Axon key on this connection, or the memoryKey the hires used." };
}

/** Run one of the tools above. Undefined for a name that is not one of them, or whose feature is switched off. */
export async function callWorkTool(name: string, args: Args, apiKey: string | null, baseUrl: string): Promise<unknown | undefined> {
  if (name === "answer_agent" && askEnabled()) {
    const found = jobOf(args);
    if ("refused" in found) return found.refused;
    const { job } = found;
    const done = answerQuestion(job.taskId, text(args.answer));
    if (!done.ok) return { error: done.reason, code: done.refused };
    return { taskId: job.taskId, status: done.task.status, note: "Answered. The job is working again: read it with get_task_result." };
  }
  if (name === "decide_plan" && planEnabled()) {
    const found = jobOf(args);
    if ("refused" in found) return found.refused;
    const { job } = found;
    const action = (["approve", "change", "cancel"] as PlanAction[]).find((a) => a === args.decision);
    if (!action) return { error: "decision must be approve, change or cancel" };
    const done = decidePlan(job.taskId, action, text(args.change) || null);
    if (!done.ok) return { error: done.reason, code: done.refused };
    const said = action === "approve" ? "Approved. The agent has started the work." : action === "change" ? "Sent back. The agent is writing the plan again: read it with get_task_result." : "Cancelled before any work. Whatever was paid for it is refunded.";
    return { taskId: job.taskId, status: done.task.status, note: said };
  }
  if (name === "steer_task" && steerEnabled()) {
    const found = jobOf(args);
    if ("refused" in found) return found.refused;
    const { job } = found;
    if (args.stop === true) {
      const done = stopJob(job.taskId);
      if (!done.ok) return { error: done.reason, code: done.refused };
      return { taskId: job.taskId, status: done.task.status, note: "Stopped. Nothing is delivered and whatever was paid for it is refunded." };
    }
    if (!text(args.note)) return { error: "send a note, or stop: true" };
    const sent = sendNote(job.taskId, text(args.note));
    if (!sent.ok) return { error: sent.reason, code: sent.refused };
    return { taskId: job.taskId, sent: sent.note.text, notesLeft: steerView(getTaskById(job.taskId)!).steer?.notesLeft ?? 0, note: "Sent. The agent reads it at its next step, or before it finishes." };
  }
  if (name === "get_library" && libraryEnabled()) {
    const owners = libraryOwners(args, apiKey, baseUrl);
    if (!Array.isArray(owners)) return owners;
    const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? { limit: Number(args.limit) } : {};
    if (text(args.thread)) {
      const whole = conversationOf(owners, text(args.thread));
      if (!whole) return { error: "No such conversation in this library" };
      return {
        thread: whole.thread,
        turns: whole.turns.map((t) => ({
          taskId: t.taskId, claimToken: t.claimToken, agent: t.agent.name, agentId: t.agent.id, asked: t.task, status: t.status, answer: t.output,
          ...(t.outputFiles.length ? { files: t.outputFiles.map((f) => ({ name: f.name, type: f.type, size: f.size, sha256: f.sha256, ...(f.version ? { version: f.version } : {}), url: `${baseUrl}${f.path}?token=${f.token}` })) } : {}),
          ...(t.pages.length ? { pages: t.pages.map((p) => ({ url: p.url, title: p.title })) } : {}),
          ...(t.site ? { page: { title: t.site.title, url: `${baseUrl}${t.site.url}`, version: t.site.version } } : {}),
          receiptUrl: `${baseUrl}${t.receipt}`,
        })),
        next: "To carry it on, call hire_agent with followUpOf and followUpToken set to the last finished turn's taskId and claimToken.",
      };
    }
    if (args.files === true) {
      return { files: filesOf(owners, limit).map((f) => ({ name: f.name, type: f.type, size: f.size, sha256: f.sha256, version: f.version ?? 1, madeBy: f.agent.name, thread: f.thread, url: `${baseUrl}${f.path}?token=${f.token}`, receiptUrl: `${baseUrl}${f.receipt}` })) };
    }
    const list = conversationsOf(owners, { agentId: text(args.agentId) || null, ...limit });
    return { conversations: list.map((c) => ({ thread: c.thread, agents: c.agents, began: c.asked, turns: c.turns, files: c.files, status: c.status, lastAt: c.lastAt })), ...(list.length ? {} : { note: "Nothing in this library yet. Hires made with this key, or with this memoryKey, are kept here." }) };
  }
  return undefined;
}

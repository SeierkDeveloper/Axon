// Work with your agent, phase 10: through Mylo. Mylo continues a finished job, passes on the person's answer to an
// agent's question and their decision on its plan, tells a running job something or stops it, and looks through
// their library. Hires go through the real hire route. No model is called.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createApiKey } from "@/lib/identity";
import type { Agent } from "@/sdk/types";
import { completeTask, getTaskById, startTask } from "@/lib/tasks";
import { askTool, parkForAnswer, questionsOf } from "@/lib/ask";
import { keepPlan, parkForPlan } from "@/lib/planFirst";
import { notesOf } from "@/lib/steer";
import { memoryOwnerOf } from "@/lib/agentMemory";
import { libraryOwnerOf } from "@/lib/library";
import { runTool, myloToolDefs, MYLO_TOOL_DEFS } from "@/lib/myloTools";
import { confirmAction, getAction, refreshAction, type HireDetail } from "@/lib/myloActions";
import { noteOf } from "@/lib/myloChat";
import { myloWorkNote, ownsJob } from "@/lib/myloWork";
import { historyOf, startConversation } from "@/lib/myloStore";
import { TOOLS } from "@/lib/myloPolicy";

const SWITCHES = { AGENT_FOLLOWUP: "on", AGENT_BRINGIN: "on", AGENT_ASK: "on", AGENT_PLAN: "on", AGENT_STEER: "on", AGENT_MEMORY: "on", AGENT_LIBRARY: "on" };
const saved = { ...process.env };
let n = 0;
const wallet = () => `0x${(++n + 5_500_000).toString(16).padStart(40, "0")}`;
function agent(id: string, over: Partial<Agent> = {}) {
  const a: Agent = { agentId: id, name: id, capabilities: ["writing"], publicKey: `pk-${id}`, walletAddress: wallet().toLowerCase(), provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
/** Somebody signed in and talking to Mylo. */
function person() {
  const w = wallet().toLowerCase(), { apiKey } = createApiKey(w, {});
  return { w, apiKey, ctx: { wallet: w, owner: w, conversationId: startConversation(w, "t").id } };
}
type Me = ReturnType<typeof person>;
const tool = async (me: Me, name: string, input: Record<string, unknown>) => {
  const out = await runTool(name, input, me.ctx);
  return { ...out, said: out.result as Record<string, unknown> & { error?: string } };
};
/** Propose a hire through Mylo and confirm it as the person would in the page. Returns the action and its job. */
async function hireThroughMylo(me: Me, input: Record<string, unknown>) {
  const out = await tool(me, "hire_agent", input);
  if (!out.actionId) throw new Error(`not proposed: ${out.said.error}`);
  const a = await confirmAction(out.actionId, me.ctx.owner, me.w, { method: "wallet", apiKey: me.apiKey, clientIp: "10.11.0.1" });
  if (typeof a === "string") throw new Error(a);
  return { actionId: a.id, taskId: a.hires[0].taskId!, error: a.hires[0].error, summary: (out.said.summary as string) };
}
const finish = (taskId: string, answer: string) => { startTask(taskId, "test"); completeTask(taskId, answer); };

beforeEach(() => {
  Object.assign(process.env, { ...SWITCHES, TRUST_PROXY_HEADERS: "true" });
  getDb().exec("DELETE FROM task_questions; DELETE FROM task_notes; DELETE FROM agent_memories; DELETE FROM rate_limit_windows; DELETE FROM mylo_actions; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents; DELETE FROM api_keys;");
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("Mylo's tools", () => {
  it("with every switch off Mylo has the tools and the instructions it always had", () => {
    for (const k of Object.keys(SWITCHES)) process.env[k] = "off";
    expect(myloToolDefs()).toEqual(MYLO_TOOL_DEFS);
    expect(myloWorkNote()).toBe("");
  });

  it("each feature adds its own tool, every tool has a rule, and none of them spends or waits for a confirmation", () => {
    const names = myloToolDefs().map((t) => t.name);
    expect(names.slice(-4)).toEqual(["answer_agent", "decide_plan", "steer_job", "my_work"]);
    for (const t of myloToolDefs()) expect(TOOLS[t.name], t.name).toBeTruthy();
    for (const t of ["answer_agent", "decide_plan", "steer_job", "my_work"]) expect(TOOLS[t]).toMatchObject({ wallet: true, confirm: false, spends: false });
    const hire = myloToolDefs().find((t) => t.name === "hire_agent")!;
    expect(Object.keys(hire.input_schema.properties)).toEqual(["agent_id", "task", "follow_up_of", "plan_first"]);
    expect(hire.input_schema.required).toEqual(["task"]);
    process.env.AGENT_PLAN = "off";
    expect(myloToolDefs().map((t) => t.name)).not.toContain("decide_plan");
    expect(myloWorkNote()).toMatch(/follow_up_of/);
    expect(myloWorkNote()).not.toMatch(/decide_plan|—/);
  });

  it("needs a wallet", async () => {
    const guest = { wallet: null, owner: "guest:x", conversationId: startConversation("guest:x", "t").id };
    expect((await runTool("my_work", {}, guest)).result).toMatchObject({ error: expect.stringMatching(/Sign in/) });
    expect((await runTool("answer_agent", { task_id: "x", answer: "y" }, guest)).result).toMatchObject({ error: expect.stringMatching(/Sign in/) });
  });
});

describe("a hire made through Mylo", () => {
  it("lets the agent ask, remembers the person and joins their library", async () => {
    agent("quill");
    const me = person();
    const job = await hireThroughMylo(me, { agent_id: "quill", task: "Write a line" });
    const t = getTaskById(job.taskId)!;
    expect(t.fromAgent).toBe("anonymous");
    expect(t.context).toMatchObject({ mayAsk: true });
    expect(libraryOwnerOf(job.taskId)).toBe(`w:${me.w}`);
    expect(memoryOwnerOf(job.taskId)).toBe(`w:${me.w}`);
    expect(ownsJob(me.ctx, job.taskId)).toBe(true);
    expect(ownsJob(person().ctx, job.taskId)).toBe(false);
    // Mylo rereads the job's id and where it stands
    expect(noteOf(getAction(job.actionId, me.ctx.owner)!)).toContain(`task_id ${job.taskId}, job queued`);
  });

  it("continues a finished job with the agent that did it", async () => {
    agent("quill");
    const me = person();
    const first = await hireThroughMylo(me, { agent_id: "quill", task: "Write a line" });
    // not before it has finished
    expect((await tool(me, "hire_agent", { task: "Shorter", follow_up_of: first.taskId })).said.error).toMatch(/not finished/);
    finish(first.taskId, "A line.");
    const next = await hireThroughMylo(me, { task: "Shorter", follow_up_of: first.taskId });
    expect(next.summary).toMatch(/^Continue the job with quill/);
    expect(getTaskById(next.taskId)).toMatchObject({ toAgent: "quill", parentTaskId: first.taskId, threadId: first.taskId });
    expect((getAction(next.actionId, me.ctx.owner)!.detail as HireDetail).followUpOf).toBe(first.taskId);
    expect(noteOf(getAction(next.actionId, me.ctx.owner)!)).toContain(`continuing task_id ${first.taskId}`);
  });

  it("brings in another agent, and never continues somebody else's job", async () => {
    agent("Data Agent");
    agent("Design Agent");
    const me = person(), other = person();
    const first = await hireThroughMylo(me, { agent_id: "Data Agent", task: "Chart revenue" });
    finish(first.taskId, "Here is the chart.");
    const joined = await hireThroughMylo(me, { agent_id: "Design Agent", task: "Restyle it", follow_up_of: first.taskId });
    expect(getTaskById(joined.taskId)).toMatchObject({ toAgent: "Design Agent", threadId: first.taskId });
    expect((await tool(other, "hire_agent", { task: "Mine now", follow_up_of: first.taskId })).said.error).toMatch(/not one of their jobs/);
    expect((await tool(me, "hire_agent", { task: "x y z", follow_up_of: "no-such-job" })).said.error).toMatch(/not one of their jobs/);
  });
});

describe("a job that waits on the person", () => {
  it("its question is said in the conversation once, and the answer is passed on", async () => {
    agent("quill");
    const me = person();
    const job = await hireThroughMylo(me, { agent_id: "quill", task: "Write a line" });
    startTask(job.taskId, "test");
    await askTool({ taskId: job.taskId, onAsked: () => {} }).run({ question: "Which language?", choices: ["English", "Swedish"] });
    expect(parkForAnswer(job.taskId)).toBe(true);

    const seen = refreshAction(job.actionId, me.ctx.owner);
    if (typeof seen === "string") throw new Error(seen);
    expect(seen.message?.content).toMatch(/\*\*quill\*\* has a question[\s\S]*Which language\?[\s\S]*- Swedish[\s\S]*pass it on/);
    expect(seen.action.status).toBe("running");
    // the next look says nothing new
    const again = refreshAction(job.actionId, me.ctx.owner);
    expect(typeof again !== "string" && again.message).toBeNull();
    expect(historyOf(me.ctx.conversationId, 50).filter((m) => /has a question/.test(m.content))).toHaveLength(1);
    expect(noteOf(getAction(job.actionId, me.ctx.owner)!)).toContain("job waiting on the person");

    // somebody else cannot answer it
    expect((await tool(person(), "answer_agent", { task_id: job.taskId, answer: "English" })).said.error).toMatch(/not one of their jobs/);
    const passed = await tool(me, "answer_agent", { task_id: job.taskId, answer: "Swedish" });
    expect(passed.said).toMatchObject({ passed_on: true });
    expect(passed.label).toBe("Passing your answer on");
    expect(questionsOf(job.taskId)[0]).toMatchObject({ answer: "Swedish", answeredHow: "person" });
    expect(getTaskById(job.taskId)!.status).toBe("queued");
    expect((await tool(me, "answer_agent", { task_id: job.taskId, answer: "Again" })).said.error).toMatch(/not waiting on a question/);

    // and its answer arrives as it always did
    finish(job.taskId, "En rad.");
    const done = refreshAction(job.actionId, me.ctx.owner);
    expect(typeof done !== "string" && done.message?.content).toMatch(/\*\*quill\*\* finished:[\s\S]*En rad\./);
  });

  it("its plan is said in the conversation, and approve, change and cancel are passed on", async () => {
    agent("quill");
    const me = person();
    const planned = async () => {
      const job = await hireThroughMylo(me, { agent_id: "quill", task: "Write a long report on shipping lanes", plan_first: true });
      expect(job.summary).toMatch(/shows its plan first/);
      expect(getTaskById(job.taskId)!.context).toMatchObject({ planFirst: true });
      startTask(job.taskId, "test");
      keepPlan(job.taskId, "1. Read. 2. Write.");
      expect(parkForPlan(job.taskId)).toBe(true);
      return job;
    };
    const a = await planned();
    const seen = refreshAction(a.actionId, me.ctx.owner);
    expect(typeof seen !== "string" && seen.message?.content).toMatch(/wrote its plan[\s\S]*1\. Read\. 2\. Write\.[\s\S]*go ahead/);
    expect((await tool(me, "decide_plan", { task_id: a.taskId, decision: "perhaps" })).said.error).toMatch(/approve, change or cancel/);
    expect((await tool(me, "decide_plan", { task_id: a.taskId, decision: "change", change: "Two pages" })).said).toMatchObject({ passed_on: true });
    // the plan written again is a new plan, said again
    startTask(a.taskId, "test");
    keepPlan(a.taskId, "1. Read less. 2. Write two pages.");
    parkForPlan(a.taskId);
    const second = refreshAction(a.actionId, me.ctx.owner);
    expect(typeof second !== "string" && second.message?.content).toMatch(/Write two pages/);
    expect((await tool(me, "decide_plan", { task_id: a.taskId, decision: "approve" })).said.note).toMatch(/started the work/);
    expect(getTaskById(a.taskId)!.status).toBe("queued");

    const b = await planned();
    expect((await tool(me, "decide_plan", { task_id: b.taskId, decision: "cancel" })).said.note).toMatch(/refunded/);
    const ended = refreshAction(b.actionId, me.ctx.owner);
    expect(typeof ended !== "string" && ended.message?.content).toMatch(/called off before it delivered/);
    expect((await tool(me, "decide_plan", { task_id: b.taskId, decision: "approve" })).said.error).toMatch(/no plan waiting/);
  });
});

describe("while a job runs", () => {
  it("a note is passed on, and stop stops it", async () => {
    agent("quill");
    const me = person();
    const job = await hireThroughMylo(me, { agent_id: "quill", task: "Write a long report" });
    startTask(job.taskId, "test");
    expect((await tool(me, "steer_job", { task_id: job.taskId })).said.error).toMatch(/note/);
    expect((await tool(me, "steer_job", { task_id: job.taskId, note: "Use euros" })).said).toMatchObject({ passed_on: true });
    expect(notesOf(job.taskId).map((x) => x.text)).toEqual(["Use euros"]);
    expect((await tool(person(), "steer_job", { task_id: job.taskId, stop: true })).said.error).toMatch(/not one of their jobs/);
    expect((await tool(me, "steer_job", { task_id: job.taskId, stop: true })).said).toMatchObject({ stopped: true });
    expect(getTaskById(job.taskId)!.status).toBe("cancelled");
  });
});

describe("their library", () => {
  it("lists what agents did for them, reads one conversation, and nobody else's", async () => {
    agent("quill");
    const me = person(), other = person();
    const first = await hireThroughMylo(me, { agent_id: "quill", task: "Write a line about rivers" });
    finish(first.taskId, "Rivers run.");
    await hireThroughMylo(other, { agent_id: "quill", task: "A stranger's job" });
    const listed = (await tool(me, "my_work", {})).said as { conversations: { thread: string; began: string; last_task_id: string; status: string }[] };
    expect(listed.conversations).toEqual([expect.objectContaining({ thread: first.taskId, began: "Write a line about rivers", last_task_id: first.taskId, status: "completed" })]);
    const whole = (await tool(me, "my_work", { thread: first.taskId })).said as { turns: { task_id: string; answer: string; agent: string }[] };
    expect(whole.turns).toEqual([expect.objectContaining({ task_id: first.taskId, answer: "Rivers run.", agent: "quill" })]);
    expect(JSON.stringify(whole)).not.toMatch(/claimToken/i);
    expect((await tool(other, "my_work", { thread: first.taskId })).said.error).toMatch(/not in their library/);
    // a job in the library that was not hired through Mylo can be continued through Mylo
    getDb().prepare("DELETE FROM mylo_actions WHERE owner = ?").run(me.ctx.owner);
    expect(ownsJob(me.ctx, first.taskId)).toBe(true);
    expect((await hireThroughMylo(me, { task: "Longer", follow_up_of: first.taskId })).error).toBeNull();
  });
});

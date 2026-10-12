// Agents that build, phase 9: everywhere. That an agent builds is said wherever an agent is described (its profile,
// an assistant, Mylo), and the page a job built comes back wherever a job is read: the tool layer, the library and
// Mylo. No model is called and no browser is started.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { POST as mcpPOST } from "@/app/mcp/route";
import { GET as agentGET } from "@/app/api/agents/[agentId]/route";
import { GET as libraryGET } from "@/app/api/library/route";
import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { addVersion, agentBuilds, createSite, hideSite } from "@/lib/agentSites";
import { createTask, startTask, completeTask } from "@/lib/tasks";
import { claimTokenFor, mcpTools } from "@/lib/mcpServer";
import { conversationOf, pagesBuiltFor } from "@/lib/library";
import { memoryOwnerFor } from "@/lib/agentMemory";
import { myloBuildNote } from "@/lib/myloWork";
import { runTool } from "@/lib/myloTools";
import { startConversation } from "@/lib/myloStore";
import type { Agent } from "@/sdk/types";

const saved = { ...process.env };
let n = 0;
function agent(over: Partial<Agent> = {}): Agent {
  n++;
  const a: Agent = { agentId: `builder-${n}`, name: `Builder ${n}`, capabilities: ["research"], publicKey: `pk-builder-${n}`, provider: "anthropic", reputation: 0, createdAt: new Date().toISOString(), ...over };
  createAgent(a, { describe: false });
  return a;
}
/** A finished job of this agent's that built a page. `owner` puts it in that person's library. */
function builtJob(agentId: string, o: { owner?: string; from?: string; title?: string } = {}): { taskId: string; siteId: string } {
  const t = createTask({ fromAgent: o.from ?? "anonymous", toAgent: agentId, task: "Build me a tip calculator" });
  if (o.owner) getDb().prepare("UPDATE tasks SET library_owner = ? WHERE task_id = ?").run(o.owner, t.taskId);
  startTask(t.taskId);
  const m = createSite({ taskId: t.taskId, agentId, ownerMark: o.owner ?? null, title: o.title ?? "Tip Calculator" });
  if (!m.ok) throw new Error(m.why);
  const kept = addVersion(m.site.siteId, [{ path: "index.html", content: "<h1>Tips</h1>" }], { taskId: t.taskId });
  if (!kept.ok) throw new Error(kept.problems.join("; "));
  completeTask(t.taskId, "Your tip calculator is ready.");
  return { taskId: t.taskId, siteId: m.site.siteId };
}
async function callTool(name: string, args: Record<string, unknown>) {
  const req = new NextRequest("https://axon-agents.com/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const json = (await (await mcpPOST(req)).json()) as { result: { content: { text: string }[] } };
  return JSON.parse(json.result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

beforeEach(() => {
  process.env = { ...saved, AGENT_SITES: "on", AGENT_LIBRARY: "on" };
  getDb().exec("DELETE FROM built_site_answers; DELETE FROM built_site_files; DELETE FROM built_site_versions; DELETE FROM built_sites; DELETE FROM rate_limit_windows;");
});
afterAll(() => { process.env = saved; });

describe("which agents build, said wherever an agent is described", () => {
  it("an agent Axon runs on Claude, while building is on: its profile says so and no other's does", async () => {
    const yes = agent(), own = agent({ endpoint: "https://agent.example/run" }), other = agent({ provider: "openai" });
    const read = async (id: string) => (await (await agentGET(new NextRequest(`https://axon-agents.com/api/agents/${id}`), { params: Promise.resolve({ agentId: id }) })).json()) as Record<string, unknown>;
    expect((await read(yes.agentId)).builds).toBe(true);
    expect("builds" in (await read(own.agentId))).toBe(false);
    expect("builds" in (await read(other.agentId))).toBe(false);
    process.env.AGENT_SITES = "off";
    expect("builds" in (await read(yes.agentId))).toBe(false);
    expect(agentBuilds(yes)).toBe(false);
  });

  it("an assistant is told, where it hires, that an agent can build a page", () => {
    const hire = mcpTools().find((t) => t.name === "hire_agent")!;
    expect(hire.description).toMatch(/can also build a working web page or small app when the task asks for one/);
    expect(hire.description).toMatch(/the result then carries a page with a link the person opens/);
    expect(hire.description).not.toMatch(/—/);
  });

  it("Mylo is told what an agent can build and that Mylo does not, and only while building is on", async () => {
    const note = myloBuildNote();
    expect(note).toMatch(/Agents that build:/);
    expect(note).toMatch(/a landing page, a\s+calculator, a quiz, a tracker, a sign-up or RSVP form, a dashboard/);
    expect(note).toMatch(/the link stays the same/);
    expect(note).toMatch(/You do not build pages yourself:\s+never say you built one/);
    expect(note).not.toMatch(/—/);
    const yes = agent(), no = agent({ endpoint: "https://agent.example/run" });
    const w = "0x00000000000000000000000000000000000b1d01";
    const ctx = { wallet: w, owner: w, conversationId: startConversation(w, "t").id };
    expect(((await runTool("agent_details", { agent_id: yes.agentId }, ctx as never)).result as Record<string, unknown>).builds).toBe(true);
    expect("builds" in ((await runTool("agent_details", { agent_id: no.agentId }, ctx as never)).result as Record<string, unknown>)).toBe(false);
    process.env.AGENT_SITES = "off";
    expect(myloBuildNote()).toBe("");
  });
});

describe("the page a job built, wherever the job is read", () => {
  it("the tool layer: the result carries the page, with a link an assistant can hand over", async () => {
    const { taskId, siteId } = builtJob(agent().agentId);
    const got = await callTool("get_task_result", { taskId, claimToken: claimTokenFor(taskId) });
    expect(got).toMatchObject({ status: "completed", output: "Your tip calculator is ready.", page: { title: "Tip Calculator", version: 1 } });
    expect((got.page as { url: string }).url).toMatch(new RegExp(`/s/${siteId}$`));
    expect((got.page as { url: string }).url).toMatch(/^https?:\/\//);
    expect((got.page as { note: string }).note).toMatch(/Give the person the link/);
    // a job that built nothing reads exactly as before
    const plain = createTask({ fromAgent: "anonymous", toAgent: agent().agentId, task: "Say hi" });
    startTask(plain.taskId); completeTask(plain.taskId, "Hi.");
    expect("page" in (await callTool("get_task_result", { taskId: plain.taskId, claimToken: claimTokenFor(plain.taskId) }))).toBe(false);
    // and a page that was taken down is not handed out
    hideSite(siteId, "reported");
    expect("page" in (await callTool("get_task_result", { taskId, claimToken: claimTokenFor(taskId) }))).toBe(false);
  });

  it("the library: the turn that built it carries the page, and what reads its versions, answers and files", () => {
    const owner = "k:library-owner-1";
    const { taskId, siteId } = builtJob(agent().agentId, { owner });
    const turn = conversationOf([owner], taskId)!.turns[0];
    expect(turn.site).toEqual({ siteId, title: "Tip Calculator", version: 1, url: `/s/${siteId}` });
    expect(turn.claimToken).toBe(claimTokenFor(taskId));
    process.env.AGENT_SITES = "off";
    expect("site" in conversationOf([owner], taskId)!.turns[0]).toBe(false);
  });

  it("the library lists every page built for a person that is up: theirs, the newest first, and nobody else's", async () => {
    const mine = "k:library-owner-2", theirs = "k:library-owner-3";
    const a = agent();
    const first = builtJob(a.agentId, { owner: mine, title: "Tip Calculator" });
    const second = builtJob(a.agentId, { owner: mine, title: "Party RSVP" });
    builtJob(a.agentId, { owner: theirs, title: "Not mine" });
    builtJob(a.agentId, { title: "Nobody's" });
    // changing the first page makes it the newest, and the job named for it is the one that made that version
    const change = createTask({ fromAgent: "anonymous", toAgent: a.agentId, task: "Make it green" });
    getDb().prepare("UPDATE tasks SET library_owner = ?, thread_id = ? WHERE task_id = ?").run(mine, first.taskId, change.taskId);
    addVersion(first.siteId, [{ path: "index.html", content: "<h1>Tips, green</h1>" }], { taskId: change.taskId });
    const pages = pagesBuiltFor([mine]);
    expect(pages.map((p) => p.title)).toEqual(["Tip Calculator", "Party RSVP"]);
    expect(pages[0]).toMatchObject({ siteId: first.siteId, version: 2, url: `/s/${first.siteId}`, taskId: change.taskId, claimToken: claimTokenFor(change.taskId), thread: first.taskId, agent: { id: a.agentId, name: a.name }, receipt: `/r/${change.taskId}` });
    expect(pages[1]).toMatchObject({ siteId: second.siteId, version: 1, taskId: second.taskId });
    // one that was taken down is no longer listed
    hideSite(second.siteId, "reported");
    expect(pagesBuiltFor([mine]).map((p) => p.title)).toEqual(["Tip Calculator"]);
    expect(pagesBuiltFor([])).toEqual([]);
    expect(pagesBuiltFor(["k:nobody"])).toEqual([]);
    process.env.AGENT_SITES = "off";
    expect(pagesBuiltFor([mine])).toEqual([]);
  });

  it("the library's address gives the pages to the person whose key it is, and to nobody without one", async () => {
    const key = "a-browser-key-of-at-least-thirty-two-characters";
    const owner = memoryOwnerFor({ key })!;
    const { siteId } = builtJob(agent().agentId, { owner });
    builtJob(agent().agentId, { owner: "k:somebody-else", title: "Not mine" });
    const res = await libraryGET(new NextRequest("https://axon-agents.com/api/library?view=pages", { headers: { "x-memory-key": key } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pages: { siteId: string; title: string }[] };
    expect(body.pages.map((p) => p.siteId)).toEqual([siteId]);
    expect((await libraryGET(new NextRequest("https://axon-agents.com/api/library?view=pages"))).status).toBe(401);
  });

  it("Mylo: a conversation read back says which turn built a page, with its link", async () => {
    const w = "0x00000000000000000000000000000000000b1d02";
    const { taskId, siteId } = builtJob(agent().agentId, { owner: `w:${w}`, from: w });
    const ctx = { wallet: w, owner: w, conversationId: startConversation(w, "t").id };
    const got = (await runTool("my_work", { thread: taskId }, ctx as never)).result as { turns?: { built_page?: { title: string; link: string; version: number } }[]; error?: string };
    expect(got.turns?.[0].built_page).toEqual({ title: "Tip Calculator", link: `/s/${siteId}`, version: 1 });
  });
});

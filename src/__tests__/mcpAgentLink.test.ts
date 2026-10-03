// One agent's own link (/mcp/agents/:id, /api/tools?agent=:id): the agent is a tool in someone's assistant, hired the
// same way as through the marketplace, with only its own tools there.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { createAgent } from "@/lib/agents";
import type { Agent } from "@/sdk/types";
import { POST as agentMcpPOST, GET as agentMcpGET } from "@/app/mcp/agents/[agentId]/route";
import { GET as toolsGET } from "@/app/api/tools/route";
import { POST as toolsCallPOST } from "@/app/api/tools/call/route";

let n = 0;
function paidAgent(): Agent {
  n++;
  const a: Agent = { agentId: `link-agent-${n}`, name: `Link Agent ${n}`, capabilities: ["research"], publicKey: `pk-link-${n}`, provider: "anthropic", reputation: 0, category: "Research", price: "0.0004 ETH", createdAt: new Date().toISOString() };
  createAgent(a);
  return a;
}
const ctx = (agentId: string) => ({ params: Promise.resolve({ agentId }) });
async function rpc(agentId: string, method: string, params: Record<string, unknown> = {}) {
  const req = new NextRequest(`https://axon-agents.com/mcp/agents/${agentId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await (await agentMcpPOST(req, ctx(agentId))).json()) as { result?: Record<string, unknown>; error?: { message: string } };
}

describe("one agent as its own MCP server", () => {
  it("lists the agent as one tool, with the tools to read its answer, and nothing else", async () => {
    const a = paidAgent();
    const init = await rpc(a.agentId, "initialize", { protocolVersion: "2025-06-18" });
    expect(String((init.result as { instructions: string }).instructions)).toContain(a.name);
    const list = await rpc(a.agentId, "tools/list");
    const tools = (list.result as { tools: { name: string; description: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }[] }).tools;
    expect(tools[0].name).toBe(a.agentId);
    expect(tools.slice(1).map((t) => t.name).sort()).toEqual(["get_allowance", "get_receipt", "get_task_result"]);
    expect(tools[0].description).toContain("0.0004 ETH per task");
    expect(tools[0].inputSchema.required).toEqual(["task"]);
    expect(tools[0].inputSchema.properties).not.toHaveProperty("agentId");
  });

  it("calling the agent's tool hires that agent the usual way: a paid agent asks for payment first", async () => {
    const a = paidAgent();
    const res = await rpc(a.agentId, "tools/call", { name: a.agentId, arguments: { task: "research x" } });
    const data = JSON.parse((res.result as { content: { text: string }[] }).content[0].text) as Record<string, unknown>;
    expect(data.status).toBe("payment_required");
    expect(JSON.stringify(data)).toContain("0.0004");
  });

  it("keeps the rest of the marketplace off an agent's own link", async () => {
    const a = paidAgent();
    const res = await rpc(a.agentId, "tools/call", { name: "search_agents", arguments: { query: "x" } });
    expect(res.error?.message).toMatch(/unknown tool/);
    expect((await rpc("no-such-agent-here", "tools/list")).error?.message).toMatch(/no agent/);
  });

  it("describes itself to a person checking the link", async () => {
    const a = paidAgent();
    const r = await agentMcpGET(new NextRequest(`https://axon-agents.com/mcp/agents/${a.agentId}`), ctx(a.agentId));
    const j = (await r.json()) as { endpoint: string; tools: string[] };
    expect(j.endpoint).toBe(`https://axon-agents.com/mcp/agents/${a.agentId}`);
    expect(j.tools[0]).toBe(a.agentId);
    expect((await agentMcpGET(new NextRequest("https://axon-agents.com/mcp/agents/nope"), ctx("nope"))).status).toBe(404);
  });
});

describe("one agent for function calling (ChatGPT, Grok)", () => {
  it("gives the agent's tool in OpenAI's shape, pointing the call at the agent's own link", async () => {
    const a = paidAgent();
    const r = await toolsGET(new NextRequest(`https://axon-agents.com/api/tools?agent=${a.agentId}&format=openai`));
    const j = (await r.json()) as { tools: { type: string; function: { name: string } }[]; call: { url: string } };
    expect(j.tools[0]).toMatchObject({ type: "function", function: { name: a.agentId } });
    expect(j.call.url).toContain(`agent=${a.agentId}`);
  });

  it("the call reaches the agent through its tool name", async () => {
    const a = paidAgent();
    const r = await toolsCallPOST(new NextRequest(`https://axon-agents.com/api/tools/call?agent=${a.agentId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: a.agentId, arguments: { task: "research x" } }) }));
    expect(JSON.stringify(await r.json())).toContain("payment_required");
  });
});

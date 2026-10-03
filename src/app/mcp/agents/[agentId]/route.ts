import { NextRequest, NextResponse } from "next/server";
import { agentToolset } from "@/lib/mcpServer";
import { serveMcp, MCP_CORS_HEADERS } from "@/lib/mcpHttp";

export const runtime = "nodejs";

// /mcp/agents/:agentId: one agent as its own MCP server. Add this URL to Claude, Cursor or any MCP client and that
// agent is a tool there: give it a task, read the answer with get_task_result. Payments, allowance keys and claim tokens
// work exactly as on /mcp, which this shares its handler with.

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: MCP_CORS_HEADERS });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return serveMcp(req, agentId);
}

// GET: what this link is, for a person checking it before pasting it into a config file.
export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const set = agentToolset(agentId);
  if (!set) return NextResponse.json({ error: `No agent '${agentId}' to hire` }, { status: 404, headers: MCP_CORS_HEADERS });
  const origin = req.nextUrl.origin;
  return NextResponse.json(
    {
      name: `axon-${set.toolName}`,
      agent: { agentId: set.agent.agentId, name: set.agent.name, price: set.agent.price ?? null },
      protocol: "mcp",
      transport: "streamable-http",
      endpoint: `${origin}/mcp/agents/${set.agent.agentId}`,
      tools: set.tools.map((t) => t.name),
      functionCalling: `${origin}/api/tools?agent=${encodeURIComponent(set.agent.agentId)}&format=openai`,
      page: `${origin}/agents/${set.agent.agentId}`,
    },
    { headers: { "Cache-Control": "public, max-age=60", ...MCP_CORS_HEADERS } },
  );
}

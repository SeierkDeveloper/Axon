import { NextRequest, NextResponse } from "next/server";
import { MCP_TOOLS } from "@/lib/mcpServer";
import { serveMcp } from "@/lib/mcpHttp";

export const runtime = "nodejs";


// POST /mcp — Axon as an MCP server (Streamable HTTP, JSON-RPC 2.0). Point any
// MCP client at https://axon-agents.com/mcp and the network becomes a toolbox:
// search_agents, get_agent, hire_agent, get_task_result, get_receipt, get_allowance, and for
// anything recurring schedule_agent, list_retainers, get_retainer_runs and manage_retainer.
// No API key needed — discovery and receipts are public, paid hires authorize
// themselves via an on-chain ETH payment (x402 pattern), and task outputs are
// gated by the claim token issued at hire time. An allowance key in the client's
// Authorization header is optional: with one, paid hires pay from the owner's
// on-chain allowance with nobody leaving the chat.
// Permissive CORS so browser-based MCP clients pass preflight; the endpoint is
// public-read anyway (payments authorize themselves, outputs need claim tokens).
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  return serveMcp(req);
}

// GET /mcp — human/agent-friendly description of the endpoint (the protocol
// itself runs over POST).
export async function GET() {
  return NextResponse.json(
    {
      name: "axon",
      protocol: "mcp",
      transport: "streamable-http",
      endpoint: "https://axon-agents.com/mcp",
      tools: MCP_TOOLS.map((t) => t.name),
      // A GET here is almost always a person checking the URL is real before pasting it into a
      // config file. Send them to the page with the config blocks rather than to a text dump
      // written for a model to read.
      docs: "https://axon-agents.com/docs/mcp",
      llmsTxt: "https://axon-agents.com/llms-full.txt",
      // For callers that do function calling rather than MCP: the same tools, their shape.
      functionCalling: "https://axon-agents.com/api/tools?format=openai",
    },
    { headers: { "Cache-Control": "public, max-age=300", ...CORS_HEADERS } },
  );
}

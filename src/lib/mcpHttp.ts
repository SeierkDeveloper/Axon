import { NextRequest, NextResponse } from "next/server";
import { handleMcpMessage, type JsonRpcRequest } from "@/lib/mcpServer";
import { getClientIp, tooManyRequests } from "@/lib/rateLimit";
import { checkTieredRateLimit } from "@/lib/tieredRateLimit";
import { getBearerToken } from "@/lib/identity";

// MCP over HTTP (Streamable HTTP, JSON-RPC 2.0), shared by the whole marketplace at /mcp and by one agent's own link at
// /mcp/agents/:id (scope). One handler, so the two can never disagree about rate limits, errors or payments.

const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

// Permissive CORS so browser-based MCP clients pass preflight; the endpoint is public-read anyway (payments authorize
// themselves, outputs need claim tokens).
export const MCP_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
};

export async function serveMcp(req: NextRequest, scope: string | null = null): Promise<NextResponse> {
  const ip = getClientIp(req);
  // Widened by what the caller holds. Anonymous callers — most traffic here — get the
  // same limit they always had.
  const { result: rl } = await checkTieredRateLimit(req, "mcp", RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) {
    const res = tooManyRequests(rl);
    for (const [k, v] of Object.entries(MCP_CORS_HEADERS)) res.headers.set(k, v);
    return res;
  }

  let msg: JsonRpcRequest;
  try {
    msg = (await req.json()) as JsonRpcRequest;
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: body must be JSON-RPC 2.0" } },
      { status: 400, headers: MCP_CORS_HEADERS },
    );
  }

  // JSON-RPC batching isn't supported — say so instead of silently accepting.
  if (Array.isArray(msg)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests are not supported, send one message per request" } },
      { status: 400, headers: MCP_CORS_HEADERS },
    );
  }
  // A JSON body of null / a bare primitive parses fine but isn't a message.
  if (!msg || typeof msg !== "object") {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request: body must be a JSON-RPC 2.0 message object" } },
      { status: 400, headers: MCP_CORS_HEADERS },
    );
  }

  const response = await handleMcpMessage(msg, ip, getBearerToken(req), scope);
  // Notifications get no body — 202 Accepted per Streamable HTTP.
  if (response === null) return new NextResponse(null, { status: 202, headers: MCP_CORS_HEADERS });
  return NextResponse.json(response, { headers: MCP_CORS_HEADERS });
}

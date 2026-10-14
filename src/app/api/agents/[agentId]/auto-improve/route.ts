import { NextRequest, NextResponse } from "next/server";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { getAgentById } from "@/lib/agents";
import { apiError } from "@/lib/apiError";
import { autoImproveOn, setAutoImprove } from "@/lib/autonomy3Improve";

export const runtime = "nodejs";

// GET/POST /api/agents/:agentId/auto-improve: whether Axon may improve this agent by itself, and the owner switching it.
// On, Autonomy 3 may change the agent's instructions when a new version beats the old one on the same jobs, and changes
// them back if it slips. Off by default; only the agent's owner can switch it. { "on": true | false }
export async function GET(_req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  if (!getAgentById(agentId)) return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  return NextResponse.json({ agentId, on: autoImproveOn(agentId) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const auth = requireApiKey(req);
  if (!auth.ok) return auth.response;
  const { agentId } = await params;
  if (!getAgentById(agentId)) return apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404);
  if (!canAccessIdentity(auth.user, agentId)) return apiError("FORBIDDEN", "You do not own this agent", 403);
  const body = (await req.json().catch(() => ({}))) as { on?: unknown };
  if (typeof body.on !== "boolean") return apiError("VALIDATION_ERROR", 'Send { "on": true } or { "on": false }', 400);
  setAutoImprove(agentId, body.on);
  return NextResponse.json({ agentId, on: body.on });
}

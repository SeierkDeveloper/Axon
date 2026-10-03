import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { apiError } from "@/lib/apiError";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { getInstructions, setInstructions } from "@/lib/agentKnowledge";

export const runtime = "nodejs";

// GET / PUT /api/agents/:agentId/instructions: an agent's own instructions, its system prompt when it is hired.
// The owner's alone: no public read carries them. An agent that runs its own endpoint writes its own prompt, so this is
// for hosted agents only.

async function owned(req: NextRequest, params: Promise<{ agentId: string }>) {
  const auth = requireApiKey(req);
  if (!auth.ok) return { error: auth.response };
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return { error: apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404) };
  if (!canAccessIdentity(auth.user, agentId)) return { error: apiError("FORBIDDEN", "You do not own this agent", 403) };
  return { agent };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  return withRequestContext(req, async () => {
    const o = await owned(req, params);
    if ("error" in o) return o.error;
    return NextResponse.json({ instructions: getInstructions(o.agent.agentId) }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  return withRequestContext(req, async () => {
    const o = await owned(req, params);
    if ("error" in o) return o.error;
    if (o.agent.endpoint) return apiError("VALIDATION_ERROR", "This agent runs its own endpoint and writes its own prompt there", 400);
    const body = (await req.json().catch(() => null)) as { instructions?: unknown } | null;
    if (!body || (body.instructions !== null && typeof body.instructions !== "string")) {
      return apiError("VALIDATION_ERROR", "instructions: a string, or null to go back to the generic prompt", 400);
    }
    const why = setInstructions(o.agent.agentId, body.instructions as string | null);
    if (why) return apiError("VALIDATION_ERROR", why, 400);
    return NextResponse.json({ ok: true, instructions: getInstructions(o.agent.agentId) });
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getAgentById } from "@/lib/agents";
import { apiError } from "@/lib/apiError";
import { requireApiKey, canAccessIdentity } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { listKnowledge, addText, addLink, removeKnowledge } from "@/lib/agentKnowledge";
import { LIMITS } from "@/lib/studioPolicy";

export const runtime = "nodejs";

// /api/agents/:agentId/knowledge: what an agent answers from. GET lists it, POST adds text ({ title, text }) or a public
// page ({ url }), DELETE ?id= removes one. The owner's alone.

async function owned(req: NextRequest, params: Promise<{ agentId: string }>) {
  const auth = requireApiKey(req);
  if (!auth.ok) return { error: auth.response };
  const { agentId } = await params;
  const agent = getAgentById(agentId);
  if (!agent) return { error: apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404) };
  if (!canAccessIdentity(auth.user, agentId)) return { error: apiError("FORBIDDEN", "You do not own this agent", 403) };
  if (agent.endpoint) return { error: apiError("VALIDATION_ERROR", "This agent runs its own endpoint and keeps its own knowledge there", 400) };
  return { agent };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  return withRequestContext(req, async () => {
    const o = await owned(req, params);
    if ("error" in o) return o.error;
    return NextResponse.json({ items: listKnowledge(o.agent.agentId), limits: { items: LIMITS.knowledgeItems, bytes: LIMITS.knowledgeBytes } }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  return withRequestContext(req, async () => {
    const o = await owned(req, params);
    if ("error" in o) return o.error;
    const body = (await req.json().catch(() => null)) as { title?: unknown; text?: unknown; url?: unknown } | null;
    let r;
    if (typeof body?.url === "string") r = await addLink(o.agent.agentId, body.url.trim());
    else if (typeof body?.text === "string") r = await addText(o.agent.agentId, typeof body.title === "string" ? body.title : "", body.text);
    else return apiError("VALIDATION_ERROR", "Send { title, text } or { url }", 400);
    if (typeof r === "string") return apiError("VALIDATION_ERROR", r, 400);
    return NextResponse.json({ ok: true, item: r }, { status: 201 });
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  return withRequestContext(req, async () => {
    const o = await owned(req, params);
    if ("error" in o) return o.error;
    const id = req.nextUrl.searchParams.get("id") ?? "";
    if (!removeKnowledge(o.agent.agentId, id)) return apiError("NOT_FOUND", "No such knowledge item on this agent", 404);
    return NextResponse.json({ ok: true });
  });
}

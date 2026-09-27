// GET /api/agents/:agentId/retainers: the owner's view of the clients keeping this agent on a schedule.

import { NextRequest, NextResponse } from "next/server";
import { requireAgentOwner } from "@/lib/apiAuth";
import { agentRetainersView } from "@/lib/retainerApi";

type Params = { params: Promise<{ agentId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { agentId } = await params;
  const auth = requireAgentOwner(req, agentId);
  if (!auth.ok) return auth.response;
  return NextResponse.json(agentRetainersView(agentId));
}

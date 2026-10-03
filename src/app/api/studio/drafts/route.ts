import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/apiError";
import { requireApiKey } from "@/lib/apiAuth";
import { withRequestContext } from "@/lib/withRequestContext";
import { startDraft } from "@/lib/studioDraft";

export const runtime = "nodejs";
export const maxDuration = 120;

// POST /api/studio/drafts { sentence }: start an Agent Studio build. Axon's writer turns the sentence into a whole draft
// agent (name, description, instructions, model, tools, a suggested price) for the signed-in wallet. Free, within a
// daily limit per wallet that rises with $AXON held.
export async function POST(req: NextRequest) {
  return withRequestContext(req, async () => {
    const auth = requireApiKey(req);
    if (!auth.ok) return auth.response;
    const wallet = auth.user.walletAddress;
    if (!wallet) return apiError("FORBIDDEN", "Sign in with a wallet to build an agent", 403);
    const body = (await req.json().catch(() => null)) as { sentence?: unknown } | null;
    if (typeof body?.sentence !== "string") return apiError("VALIDATION_ERROR", "sentence: describe the agent in one sentence", 400);
    const r = await startDraft(wallet, body.sentence);
    if (typeof r === "string") return apiError("VALIDATION_ERROR", r, 400);
    return NextResponse.json({ build: r }, { status: r.status === "failed" ? 422 : 201 });
  });
}

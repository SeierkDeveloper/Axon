// Whose memory a request is about: the wallet its API key belongs to, or the memory key it carries (X-Memory-Key).
// Shared by the routes under /api/agents/{agentId}/memory.

import { type NextRequest, type NextResponse } from "next/server";
import { apiError } from "./apiError";
import { requireApiKey } from "./apiAuth";
import { getBearerToken } from "./identity";
import { getAgentById } from "./agents";
import { checkRateLimit, getClientIp, tooManyRequests } from "./rateLimit";
import { memoryEnabled, memoryOwnerFor } from "./agentMemory";

const READS_PER_MINUTE = 60;

/** The memory's owner and the agent it is kept by, or the response that turns the caller away. */
export function memoryFor(req: NextRequest, agentId: string): { owner: string; agentId: string } | { response: NextResponse } {
  if (!memoryEnabled()) return { response: apiError("NOT_FOUND", "Not found", 404) };
  const rl = checkRateLimit(`agent-memory:${getClientIp(req)}`, READS_PER_MINUTE, 60_000);
  if (!rl.allowed) return { response: tooManyRequests(rl) };
  if (!getAgentById(agentId)) return { response: apiError("NOT_FOUND", `Agent '${agentId}' not found`, 404) };
  let wallet: string | null = null;
  if (getBearerToken(req) || req.headers.get("x-api-key")) {
    const auth = requireApiKey(req);
    if (!auth.ok) return { response: auth.response };
    wallet = auth.user.walletAddress;
  }
  const owner = memoryOwnerFor({ wallet, key: req.headers.get("x-memory-key") });
  if (!owner) return { response: apiError("AUTH_REQUIRED", "Send your API key, or the memory key your hires used in X-Memory-Key", 401) };
  return { owner, agentId };
}

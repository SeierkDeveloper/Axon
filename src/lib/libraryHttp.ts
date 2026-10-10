// Whose library a request is about: the wallet its API key belongs to, the key it carries (X-Memory-Key, the same
// key a browser keeps for its memory with agents), or both. Shared by the routes under /api/library.

import { type NextRequest, type NextResponse } from "next/server";
import { apiError } from "./apiError";
import { requireApiKey } from "./apiAuth";
import { getBearerToken } from "./identity";
import { checkRateLimit, getClientIp, tooManyRequests } from "./rateLimit";
import { memoryOwnerFor } from "./agentMemory";
import { libraryEnabled } from "./library";

const READS_PER_MINUTE = 60;

/** The marks the caller's library hangs on, or the response that turns the caller away. */
export function libraryFor(req: NextRequest): { owners: string[] } | { response: NextResponse } {
  if (!libraryEnabled()) return { response: apiError("NOT_FOUND", "Not found", 404) };
  const rl = checkRateLimit(`library:${getClientIp(req)}`, READS_PER_MINUTE, 60_000);
  if (!rl.allowed) return { response: tooManyRequests(rl) };
  const byKey = memoryOwnerFor({ key: req.headers.get("x-memory-key") });
  let byWallet: string | null = null;
  if (getBearerToken(req) || req.headers.get("x-api-key")) {
    const auth = requireApiKey(req);
    // an API key that no longer works does not lock a browser out of what its own key reads
    if (auth.ok) byWallet = memoryOwnerFor({ wallet: auth.user.walletAddress });
    else if (!byKey) return { response: auth.response };
  }
  const owners = [byWallet, byKey].filter((o): o is string => Boolean(o));
  if (!owners.length) return { response: apiError("AUTH_REQUIRED", "Send your API key, or the key your hires used in X-Memory-Key", 401) };
  return { owners };
}

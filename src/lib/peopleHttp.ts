// Agents that hire people: what every route under /api/people asks first.

import { createHash } from "node:crypto";
import { type NextRequest, type NextResponse } from "next/server";
import { apiError } from "./apiError";
import { requireApiKey } from "./apiAuth";
import { getBearerToken } from "./identity";
import { normalizeAddress } from "./address";
import { isModerator } from "./moderation";
import { getClientIp } from "./rateLimit";
import { peopleEnabled } from "./peoplePolicy";

export const noStore = { "Cache-Control": "no-store" };

/** Who is asking: a moderator, a signed-in wallet, or a visitor. A key that is presented must be valid. */
export type Caller = { kind: "moderator" } | { kind: "wallet"; wallet: string } | { kind: "visitor" };

export function callerOf(req: NextRequest): { caller: Caller } | { response: NextResponse } {
  if (!peopleEnabled()) return { response: apiError("NOT_FOUND", "Not found", 404) };
  // a moderator's secret travels as a bearer token too, so it is asked about first
  if (process.env.MODERATION_SECRET?.trim() && isModerator(req)) return { caller: { kind: "moderator" } };
  if (!getBearerToken(req)) return { caller: { kind: "visitor" } };
  const auth = requireApiKey(req);
  if (!auth.ok) return { response: auth.response };
  return { caller: { kind: "wallet", wallet: normalizeAddress(auth.user.walletAddress)! } };
}

/** A wallet, or the answer that one is needed. */
export function walletOf(c: Caller): string | null {
  return c.kind === "wallet" ? c.wallet : null;
}

export const signInFirst = () => apiError("AUTH_REQUIRED", "Sign in with your wallet first.", 401);

/** A visitor counted without keeping their address. */
export const visitorKey = (req: NextRequest): string => `ip:${createHash("sha256").update(getClientIp(req)).digest("hex").slice(0, 24)}`;

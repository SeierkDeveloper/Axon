// Who is talking to Mylo: a signed-in wallet (by its API key), or a visitor with none. A key that is presented but not
// valid is refused rather than quietly treated as a visitor, so a broken sign-in never loses someone their history.

import type { NextRequest } from "next/server";
import { requireApiKey } from "./apiAuth";
import { getTier } from "./holderTier";
import { getClientIp } from "./rateLimit";
import { addressKeyOf, limitKeyOf, ownerOf } from "./myloStore";
import type { Speaker } from "./myloPolicy";

export type Caller = { ok: true; owner: string; limitKey: string; addressKey: string; wallet: string | null; speaker: Speaker } | { ok: false; response: Response };

export async function callerOf(req: NextRequest): Promise<Caller> {
  const ip = getClientIp(req), visitor = req.headers.get("x-mylo-visitor");
  const addressKey = addressKeyOf(ip);
  const guest = (): Caller => ({ ok: true, owner: ownerOf(null, ip, visitor), limitKey: limitKeyOf(null, ip), addressKey, wallet: null, speaker: "guest" });
  const presented = Boolean(req.headers.get("authorization") || req.headers.get("x-api-key"));
  if (!presented) return guest();
  const auth = requireApiKey(req);
  if (!auth.ok) return { ok: false, response: auth.response };
  const wallet = auth.user.walletAddress ?? null;
  if (!wallet) return guest();
  const { tier } = await getTier(wallet);
  return { ok: true, owner: ownerOf(wallet, null), limitKey: limitKeyOf(wallet, null), addressKey, wallet: wallet.toLowerCase(), speaker: tier.name };
}

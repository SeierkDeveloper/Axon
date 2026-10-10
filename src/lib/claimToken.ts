// Claim tokens.
//
// A deterministic HMAC over the task id, domain-separated from other SEED_SECRET uses. Stateless: possession of the
// token IS the read permission for that task's output, and what lets its holder act as the job's hirer. Nothing else
// on the network. Kept apart from the tool server so that reading a library or confirming a Mylo hire does not pull
// the whole server in.

import { createHmac, timingSafeEqual } from "crypto";

export function claimTokenFor(taskId: string): string {
  const seed = process.env.SEED_SECRET ?? "";
  // Boot config already blocks production without SEED_SECRET; fail closed here
  // too so tokens can never silently degrade to a publicly-computable derivation.
  if (!seed && process.env.NODE_ENV === "production") {
    throw new Error("SEED_SECRET is required to mint claim tokens");
  }
  return createHmac("sha256", `axon-mcp-claim:${seed}`).update(taskId).digest("hex").slice(0, 32);
}

export function claimTokenValid(taskId: string, token: string): boolean {
  const expected = Buffer.from(claimTokenFor(taskId));
  const given = Buffer.from(String(token));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

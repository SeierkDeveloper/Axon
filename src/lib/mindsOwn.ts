// Agent Minds: bring your own mind.
//
// A creator who would rather not think through Axon runs the mind on their own server. When the mind is woken, Axon
// sends that server what a model would have been sent (the same instructions, the same numbers) and the server answers
// with a thought and, if it wants, one proposal. Which model it asks, and with whose key, is the creator's own business:
// no key of theirs is sent to Axon, asked for by Axon or stored by Axon. The answer goes through exactly the same
// checks as any other mind's: made safe to show, and its proposal put to the rule check.
//
// Two things keep this honest in both directions:
//   - Axon signs every request, so the creator's server can tell a real wake from somebody spending their model
//     credits. The signing secret is Axon's own, worked out from the creator's wallet; nothing is stored for it.
//   - The address is a stranger's, so it is only ever reached over https at a public address, with no redirects
//     followed, a short wait and a small answer (urlSecurity.publicHttpFetch pins the connection to what it checked).

import { createHmac } from "node:crypto";
import { publicHttpFetch, validatePublicHttpUrl } from "./urlSecurity";
import type { Thinker } from "./mindsThinker";

export const OWN_LIMITS = { urlChars: 300, timeoutMs: 25_000, answerBytes: 32_000, testsPerHour: 12 } as const;

/** Whether bringing your own mind is open on this server: it needs the secret requests are signed from. */
export function ownMindsOpen(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.SEED_SECRET?.trim()) || env.NODE_ENV !== "production";
}

/**
 * The secret Axon signs a creator's requests with. Worked out from the wallet each time, never stored: the creator
 * reads it once on the launch screen and puts it on their server.
 */
export function ownSecret(wallet: string, env: Record<string, string | undefined> = process.env): string {
  const seed = env.SEED_SECRET?.trim() ?? "";
  if (!seed && env.NODE_ENV === "production") throw new Error("SEED_SECRET is required to sign requests to a creator's server");
  return createHmac("sha256", `axon-own-mind:${seed}`).update(wallet.toLowerCase()).digest("hex");
}

/** The signature on a request: of its timestamp and its exact body, so neither can be swapped. */
export function signOwn(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** Why this cannot be a mind's address, in words, or null when it can. The network check happens when it is called. */
export function checkOwnUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return "Give the address of your server.";
  const text = raw.trim();
  if (text.length > OWN_LIMITS.urlChars) return "That address is too long.";
  let url: URL;
  try { url = new URL(text); } catch { return "That is not an address."; }
  if (url.protocol !== "https:") return "Your server's address has to start with https://";
  if (url.username || url.password) return "Do not put a name or password in the address.";
  if (url.hash) return "Leave the part after # out of the address.";
  return null;
}

export type Post = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; text: string }>;

/** The real way out: https only, a public address, no redirects, a short wait, a small answer. */
export const publicPost: Post = async (url, body, headers) => {
  const bad = checkOwnUrl(url) ?? (await validatePublicHttpUrl(url));
  if (bad) throw new Error(`the address cannot be used: ${bad}`);
  const res = await publicHttpFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(OWN_LIMITS.timeoutMs), maxResponseBytes: OWN_LIMITS.answerBytes });
  return { status: res.status, text: await res.text() };
};

export interface OwnRequest { token: string | null; symbol: string | null; name: string | null; test: boolean }

/**
 * A thinker that asks a creator's own server. It costs Axon nothing, so it reports no cost. The answer is the server's
 * `{ thought, action }`, or `{ text }` holding a model's raw answer in that same form.
 */
export function ownThinker(url: string, wallet: string, about: OwnRequest, post: Post = publicPost, env: Record<string, string | undefined> = process.env): Thinker {
  return async (_model, system, prompt) => {
    const body = JSON.stringify({ version: 1, test: about.test, token: about.token, symbol: about.symbol, name: about.name, system, prompt });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await post(url, body, { "content-type": "application/json", "user-agent": "Axon-Minds/1", "x-axon-timestamp": timestamp, "x-axon-signature": signOwn(ownSecret(wallet, env), timestamp, body) });
    if (res.status < 200 || res.status >= 300) throw new Error(`the server answered ${res.status}`);
    let answer: unknown;
    try { answer = JSON.parse(res.text); } catch { throw new Error("the server did not answer with JSON"); }
    const a = answer as { text?: unknown; thought?: unknown; action?: unknown };
    const text = typeof a?.text === "string" ? a.text : JSON.stringify({ thought: a?.thought ?? null, action: a?.action ?? null });
    return { text, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  };
}

export { OWN_SERVER_EXAMPLE } from "./mindsOwnExample";

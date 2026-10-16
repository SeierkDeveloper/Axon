// Sealing what an app hands back to sign in with.
//
// An access token for someone's GitHub or Gmail is the most dangerous thing Axon keeps, so it is never kept in the
// clear. It is sealed with AES-256-GCM under a key from the environment (APP_TOKEN_KEY: 32 random bytes, base64) and
// bound to the row and field it belongs to (the additional data), so a sealed token copied into another row does not
// open there.
//
// A sealed value names the key that sealed it: "v1:<key id>:<base64 nonce|ciphertext|tag>". The key id is a short
// hash of the key, never the key. To replace a key, put the new one in APP_TOKEN_KEY and the old one in
// APP_TOKEN_KEYS_OLD (comma separated): old rows still open, and are sealed again under the new key the next time they
// are used, or all at once with resealAll in ./appConnect. When no row names the old key any more, drop it.
//
// Nothing here logs, and no error carries a token or a key.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

type Env = Record<string, string | undefined>;

const VERSION = "v1";
const AAD_DOMAIN = "axon-app-token|";

export class AppTokenKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppTokenKeyError";
  }
}

interface Key { id: string; bytes: Buffer }

/** A key from its base64 text, or null when it is not exactly 32 bytes. */
function readKey(raw: string | undefined): Key | null {
  const text = raw?.trim();
  if (!text) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(text, "base64");
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return { id: keyIdOf(bytes), bytes };
}

/** A short name for a key: enough to find it, nothing about it. */
function keyIdOf(bytes: Buffer): string {
  return createHash("sha256").update("axon-app-token-kid:").update(bytes).digest("hex").slice(0, 12);
}

/** The key new tokens are sealed with, and every key that still opens old ones. */
function keys(env: Env): { current: Key | null; all: Map<string, Key> } {
  const current = readKey(env.APP_TOKEN_KEY);
  const all = new Map<string, Key>();
  if (current) all.set(current.id, current);
  for (const raw of (env.APP_TOKEN_KEYS_OLD ?? "").split(",")) {
    const k = readKey(raw);
    if (k && !all.has(k.id)) all.set(k.id, k);
  }
  return { current, all };
}

/** Whether a usable key is set. Without one no app can be connected. */
export function tokenKeyReady(env: Env = process.env): boolean {
  return keys(env).current !== null;
}

/** The id of the key new tokens are sealed with, or null. */
export function currentKeyId(env: Env = process.env): string | null {
  return keys(env).current?.id ?? null;
}

/** The key id a sealed value names, or null when it is not one of ours. */
export function keyIdOfSealed(sealed: string): string | null {
  const parts = sealed.split(":");
  return parts.length === 3 && parts[0] === VERSION ? parts[1]! : null;
}

/** Seal a token for one place: `context` is the row and field it belongs to, e.g. "<connection id>:access". */
export function sealToken(plaintext: string, context: string, env: Env = process.env): { sealed: string; keyId: string } {
  const key = keys(env).current;
  if (!key) throw new AppTokenKeyError("APP_TOKEN_KEY is missing or is not 32 bytes of base64.");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, nonce);
  cipher.setAAD(Buffer.from(AAD_DOMAIN + context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { sealed: `${VERSION}:${key.id}:${Buffer.concat([nonce, ct, tag]).toString("base64")}`, keyId: key.id };
}

/** Open a sealed token. Throws, without saying anything about the value, when it cannot be opened. */
export function openToken(sealed: string, context: string, env: Env = process.env): string {
  const [version, kid, body] = sealed.split(":");
  if (version !== VERSION || !kid || !body) throw new AppTokenKeyError("A stored token is not in a form this server reads.");
  const key = keys(env).all.get(kid);
  if (!key) throw new AppTokenKeyError(`The key that sealed a stored token (${kid}) is not set. Put it in APP_TOKEN_KEYS_OLD.`);
  const buf = Buffer.from(body, "base64");
  if (buf.length < 29) throw new AppTokenKeyError("A stored token is damaged.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.bytes, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(AAD_DOMAIN + context, "utf8"));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    throw new AppTokenKeyError("A stored token did not open: it is damaged or belongs somewhere else.");
  }
}

/** A key for signing short-lived things (the sign-in state), derived from the token key so it is never the same. */
export function stateSigningKey(env: Env = process.env): Buffer {
  const key = keys(env).current;
  if (!key) throw new AppTokenKeyError("APP_TOKEN_KEY is missing or is not 32 bytes of base64.");
  return createHash("sha256").update("axon-app-oauth-state:").update(key.bytes).digest();
}

// The API key hash cache.
import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import {
  createApiKey,
  authenticateApiKey,
  revokeApiKey,
  revokeApiKeyById,
  listApiKeys,
  apiKeyHashCacheSize,
  clearApiKeyHashCache,
} from "@/lib/identity";

const WALLET = "0x3333333333333333333333333333333333333333";

function reqWith(key: string): NextRequest {
  return new NextRequest("http://localhost/api/x", { headers: { authorization: `Bearer ${key}` } });
}

describe("API key hash cache", () => {
  beforeEach(() => clearApiKeyHashCache());

  it("remembers the derivation of a key that authenticated", () => {
    const { apiKey } = createApiKey(WALLET);
    expect(apiKeyHashCacheSize()).toBe(0);
    expect(authenticateApiKey(reqWith(apiKey))?.walletAddress).toBe(WALLET);
    expect(apiKeyHashCacheSize()).toBe(1);
    expect(authenticateApiKey(reqWith(apiKey))?.walletAddress).toBe(WALLET);
    expect(apiKeyHashCacheSize()).toBe(1);
  });

  it("is much faster the second time", () => {
    const { apiKey } = createApiKey(WALLET);
    let t = performance.now();
    authenticateApiKey(reqWith(apiKey));
    const first = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 10; i++) authenticateApiKey(reqWith(apiKey));
    const each = (performance.now() - t) / 10;
    expect(each).toBeLessThan(first / 5);
  });

  it("never caches a key that was not found", () => {
    authenticateApiKey(reqWith("axon_sk_doesnotexist0000000000000000000000000"));
    expect(apiKeyHashCacheSize()).toBe(0);
  });

  it("a revoked key stops working at once even though its hash was cached", () => {
    const { apiKey, keyId } = createApiKey(WALLET);
    expect(authenticateApiKey(reqWith(apiKey))).not.toBeNull();
    expect(revokeApiKeyById(keyId, WALLET)).toBe(true);
    expect(authenticateApiKey(reqWith(apiKey))).toBeNull();
  });

  it("a key revoked by presenting it stops working at once", () => {
    const { apiKey } = createApiKey(WALLET);
    expect(authenticateApiKey(reqWith(apiKey))).not.toBeNull();
    expect(revokeApiKey(reqWith(apiKey))).toBe(true);
    expect(authenticateApiKey(reqWith(apiKey))).toBeNull();
  });

  it("writes last_used_at on first use, then at most once a minute", () => {
    const { apiKey, keyId } = createApiKey(WALLET);
    authenticateApiKey(reqWith(apiKey));
    const first = listApiKeys(WALLET).find((k) => k.keyId === keyId)?.lastUsedAt;
    expect(first).toBeTruthy();
    getDb().prepare("UPDATE api_keys SET last_used_at = 'sentinel' WHERE key_id = ?").run(keyId);
    authenticateApiKey(reqWith(apiKey));
    expect(listApiKeys(WALLET).find((k) => k.keyId === keyId)?.lastUsedAt).toBe("sentinel");
  });
});

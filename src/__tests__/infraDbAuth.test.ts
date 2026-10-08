// The statement cache, the connection settings and the API key hash cache.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { cacheStatements, applyPragmas, getDb } from "@/lib/db";
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

describe("statement cache", () => {
  it("hands back the same compiled statement for the same SQL", () => {
    const db = cacheStatements(new Database(":memory:"));
    db.exec("CREATE TABLE t (a INTEGER)");
    const a = db.prepare("SELECT a FROM t WHERE a = ?");
    const b = db.prepare("SELECT a FROM t WHERE a = ?");
    expect(a).toBe(b);
    expect(db.prepare("SELECT a FROM t")).not.toBe(a);
  });

  it("returns correct results when a cached statement is reused with new parameters", () => {
    const db = cacheStatements(new Database(":memory:"));
    db.exec("CREATE TABLE t (a INTEGER, b TEXT)");
    const ins = "INSERT INTO t (a, b) VALUES (?, ?)";
    for (let i = 0; i < 5; i++) db.prepare(ins).run(i, `v${i}`);
    expect(db.prepare("SELECT b FROM t WHERE a = ?").get(3)).toEqual({ b: "v3" });
    expect(db.prepare("SELECT b FROM t WHERE a = ?").get(1)).toEqual({ b: "v1" });
    expect(db.prepare("SELECT COUNT(*) n FROM t").get()).toEqual({ n: 5 });
  });

  it("is bounded: the least recently used statement goes first", () => {
    const db = cacheStatements(new Database(":memory:"), 2);
    const s1 = db.prepare("SELECT 1");
    const s2 = db.prepare("SELECT 2");
    db.prepare("SELECT 1"); // touch 1, so 2 is now the oldest
    db.prepare("SELECT 3"); // evicts 2
    expect(db.prepare("SELECT 1")).toBe(s1);
    expect(db.prepare("SELECT 2")).not.toBe(s2);
  });

  it("does not cache SQL that fails to prepare", () => {
    const db = cacheStatements(new Database(":memory:"));
    expect(() => db.prepare("SELECT nope FROM missing")).toThrow();
    db.exec("CREATE TABLE missing (nope INTEGER)");
    expect(db.prepare("SELECT nope FROM missing").all()).toEqual([]);
  });

  it("keeps working inside transactions and after schema changes", () => {
    const db = cacheStatements(new Database(":memory:"));
    db.exec("CREATE TABLE t (a INTEGER)");
    const tx = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) db.prepare("INSERT INTO t (a) VALUES (?)").run(i);
    });
    tx(3);
    db.exec("ALTER TABLE t ADD COLUMN b TEXT");
    expect(db.prepare("SELECT COUNT(*) n FROM t").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT * FROM t WHERE a = ?").get(1)).toEqual({ a: 1, b: null });
  });

  it("the app connection uses it", () => {
    const db = getDb();
    expect(db.prepare("SELECT 1 AS one")).toBe(db.prepare("SELECT 1 AS one"));
  });
});

describe("connection settings", () => {
  it("applies WAL-friendly settings with memory temp storage", () => {
    const db = new Database(":memory:");
    applyPragmas(db);
    expect(db.pragma("synchronous", { simple: true })).toBe(1); // NORMAL
    expect(db.pragma("temp_store", { simple: true })).toBe(2); // MEMORY
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("cache_size", { simple: true })).toBe(-32 * 1024);
  });

  it("takes the cache size from the environment", () => {
    const before = process.env.AXON_SQLITE_CACHE_MB;
    process.env.AXON_SQLITE_CACHE_MB = "8";
    try {
      const db = new Database(":memory:");
      applyPragmas(db);
      expect(db.pragma("cache_size", { simple: true })).toBe(-8 * 1024);
    } finally {
      if (before === undefined) delete process.env.AXON_SQLITE_CACHE_MB;
      else process.env.AXON_SQLITE_CACHE_MB = before;
    }
  });
});

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

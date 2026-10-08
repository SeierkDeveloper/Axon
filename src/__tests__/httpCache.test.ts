// Compressed, validated public reads: the bytes a client decodes are exactly what NextResponse.json sent.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { publicJson, publicBody, etagMatches, acceptsGzip, memoFor, clearHttpCaches, COMPRESS_MIN_BYTES } from "@/lib/httpCache";
import { GET as agentsGET } from "@/app/api/agents/route";
import { GET as agentGET } from "@/app/api/agents/[agentId]/route";
import { GET as openapiGET } from "@/app/api/openapi/route";
import { GET as capabilitiesGET } from "@/app/api/capabilities/route";
import { GET as workerMetricsGET } from "@/app/api/worker-metrics/route";
import { seedBuiltinAgents } from "@/lib/agentSeed";
import { getDb } from "@/lib/db";

function req(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost${url}`, { headers });
}

async function bodyText(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  return res.headers.get("content-encoding") === "gzip" ? gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `agent number ${i}` })) };

beforeEach(() => clearHttpCaches());

describe("publicJson", () => {
  it("sends the same JSON NextResponse.json would, with the same content type", async () => {
    const plain = NextResponse.json(big);
    const mine = publicJson(req("/x"), big);
    expect(await bodyText(mine)).toBe(await plain.text());
    expect(mine.headers.get("content-type")).toBe(plain.headers.get("content-type"));
    expect(mine.status).toBe(200);
  });

  it("gzips a large body only when the client accepts gzip", async () => {
    const gz = publicJson(req("/x", { "accept-encoding": "gzip, deflate, br" }), big);
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gz.headers.get("vary")).toMatch(/Accept-Encoding/i);
    const raw = Buffer.from(await gz.arrayBuffer());
    expect(raw.byteLength).toBeLessThan(JSON.stringify(big).length / 3);
    expect(JSON.parse(gunzipSync(raw).toString())).toEqual(big);

    const plain = publicJson(req("/x"), big);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(await plain.text())).toEqual(big);
  });

  it("leaves a small body uncompressed", () => {
    const small = { ok: true };
    expect(JSON.stringify(small).length).toBeLessThan(COMPRESS_MIN_BYTES);
    expect(publicJson(req("/x", { "accept-encoding": "gzip" }), small).headers.get("content-encoding")).toBeNull();
  });

  it("answers 304 with no body when the client already has this version", async () => {
    const first = publicJson(req("/x"), big);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\/".+"$/);
    const again = publicJson(req("/x", { "if-none-match": etag }), big);
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    // a changed body is a new version
    const changed = publicJson(req("/x", { "if-none-match": etag }), { ...big, more: 1 });
    expect(changed.status).toBe(200);
  });

  it("never turns an error into a 304", () => {
    const err = { error: "nope" };
    const etag = publicJson(req("/x"), err, { status: 404 }).headers.get("etag")!;
    expect(publicJson(req("/x", { "if-none-match": etag }), err, { status: 404 }).status).toBe(404);
  });

  it("keeps the headers it was given", () => {
    const res = publicJson(req("/x"), big, { headers: { "Cache-Control": "public, max-age=10", "X-RateLimit-Limit": "60" } });
    expect(res.headers.get("cache-control")).toBe("public, max-age=10");
    expect(res.headers.get("x-ratelimit-limit")).toBe("60");
  });

  it("publicBody keeps a custom content type", async () => {
    const res = publicBody(req("/x"), "a".repeat(10), "text/plain; charset=utf-8");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("aaaaaaaaaa");
  });
});

describe("header parsing", () => {
  it("matches weak and strong forms and lists", () => {
    expect(etagMatches('W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"x", W/"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches("*", 'W/"abc"')).toBe(true);
    expect(etagMatches('"other"', 'W/"abc"')).toBe(false);
    expect(etagMatches(null, 'W/"abc"')).toBe(false);
  });

  it("respects q=0", () => {
    expect(acceptsGzip("gzip")).toBe(true);
    expect(acceptsGzip("br, gzip;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });
});

describe("memoFor", () => {
  it("computes once per window", () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const f = () => ++n;
      expect(memoFor("k", 1000, f)).toBe(1);
      expect(memoFor("k", 1000, f)).toBe(1);
      vi.advanceTimersByTime(1001);
      expect(memoFor("k", 1000, f)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("public routes", () => {
  beforeEach(() => seedBuiltinAgents(getDb()));

  it("GET /api/agents decodes to the same agents with or without gzip", async () => {
    const plain = await agentsGET(req("/api/agents?limit=200"));
    const gz = await agentsGET(req("/api/agents?limit=200", { "accept-encoding": "gzip" }));
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    const a = JSON.parse(await bodyText(plain));
    expect(a.agents.length).toBeGreaterThan(0);
    expect(JSON.parse(await bodyText(gz))).toEqual(a);
  });

  it("GET /api/agents/:id gives an ETag and a 304", async () => {
    const params = { params: Promise.resolve({ agentId: "research-agent" }) };
    const first = await agentGET(req("/api/agents/research-agent"), params);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag")!;
    const again = await agentGET(req("/api/agents/research-agent", { "if-none-match": etag }), {
      params: Promise.resolve({ agentId: "research-agent" }),
    });
    expect(again.status).toBe(304);
    const missing = await agentGET(req("/api/agents/nope-zz"), { params: Promise.resolve({ agentId: "nope-zz" }) });
    expect(missing.status).toBe(404);
  });

  it("GET /api/openapi keeps its download header and compresses", async () => {
    const res = await openapiGET(req("/api/openapi", { "accept-encoding": "gzip" }));
    expect(res.headers.get("content-disposition")).toContain("axon-openapi.json");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const spec = JSON.parse(await bodyText(res));
    expect(spec.openapi).toBe("3.1.0");
  });

  it("GET /api/capabilities still answers the same shape", async () => {
    const res = await capabilitiesGET(req("/api/capabilities"));
    const body = JSON.parse(await bodyText(res));
    expect(Array.isArray(body.capabilities)).toBe(true);
    expect(body.total).toBe(body.capabilities.length);
  });

  it("GET /api/worker-metrics is computed at most once per window", async () => {
    const a = JSON.parse(await bodyText(await workerMetricsGET(req("/api/worker-metrics"))));
    const b = JSON.parse(await bodyText(await workerMetricsGET(req("/api/worker-metrics"))));
    expect(b.updatedAt).toBe(a.updatedAt);
    expect(a.worker).toBeDefined();
    expect(a.latency).toBeDefined();
  });
});

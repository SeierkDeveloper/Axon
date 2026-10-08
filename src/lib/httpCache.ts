// Public read responses: compressed when the client asks, with an ETag so a client that already has
// the body gets a 304 instead of it again.
//
// Next compresses pages but not route handlers, so every JSON answer from /api went out at full size:
// the agents list at 25 KB, the OpenAPI document at 170 KB. The bytes a client receives after
// decoding are exactly what NextResponse.json would have sent; only the transfer changes, and only
// for a client that sent Accept-Encoding: gzip (every HTTP library does, curl without --compressed
// does not and still gets plain JSON).

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { NextResponse } from "next/server";

/** Below this a compressed body is not worth the CPU or the header bytes. */
export const COMPRESS_MIN_BYTES = 1024;

// The same body is asked for again and again (the agents list, the OpenAPI document), so the gzip of
// the last few bodies is kept by ETag rather than compressed per request.
const GZ_CACHE_MAX = 64;
const gzCache = new Map<string, Buffer>();

function gzipFor(etag: string, body: string): Buffer {
  const hit = gzCache.get(etag);
  if (hit) return hit;
  const gz = gzipSync(body, { level: 6 });
  gzCache.set(etag, gz);
  if (gzCache.size > GZ_CACHE_MAX) gzCache.delete(gzCache.keys().next().value as string);
  return gz;
}

/** A weak validator for a body: the same bytes always give the same tag. */
export function etagOf(body: string | Buffer): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

/** Does If-None-Match name this tag? Weak comparison, as RFC 9110 asks for GET. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  const mine = bare(etag);
  return ifNoneMatch.split(",").some((t) => bare(t) === mine);
}

export function acceptsGzip(acceptEncoding: string | null): boolean {
  if (!acceptEncoding) return false;
  return acceptEncoding.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

interface PublicInit {
  status?: number;
  headers?: Record<string, string>;
}

/**
 * NextResponse.json, for a public read: same body, same status, same headers, plus an ETag, a 304
 * when the client already has it, and gzip when the client accepts it and the body is big enough.
 */
export function publicJson(req: Request, data: unknown, init: PublicInit = {}): NextResponse {
  const body = JSON.stringify(data);
  return publicBody(req, body, "application/json", init);
}

/** The same for a body that is already a string (text, markdown, a pre-serialized document). */
export function publicBody(req: Request, body: string, contentType: string, init: PublicInit = {}): NextResponse {
  const status = init.status ?? 200;
  const etag = etagOf(body);
  const headers = new Headers(init.headers);
  headers.set("ETag", etag);
  headers.append("Vary", "Accept-Encoding");

  if (status === 200 && etagMatches(req.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }

  headers.set("Content-Type", contentType);
  if (Buffer.byteLength(body) >= COMPRESS_MIN_BYTES && acceptsGzip(req.headers.get("accept-encoding"))) {
    const gz = gzipFor(etag, body);
    headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", String(gz.byteLength));
    return new NextResponse(new Uint8Array(gz), { status, headers });
  }
  return new NextResponse(body, { status, headers });
}

// ── Short memo for expensive reads ─────────────────────────────────────────────
//
// For a read that is the same for every caller and costs real time to compute: computed at most once
// per `ttlMs`, however many people ask. Synchronous, because the database is.
const memos = new Map<string, { at: number; value: unknown }>();

export function memoFor<T>(key: string, ttlMs: number, compute: () => T): T {
  const now = Date.now();
  const hit = memos.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as T;
  const value = compute();
  memos.set(key, { at: now, value });
  return value;
}

/** Test seam. */
export function clearHttpCaches(): void {
  gzCache.clear();
  memos.clear();
}

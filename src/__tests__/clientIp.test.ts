// The address a request is counted under. Every per-address limit rests on it, so a caller must not be able to choose it.
import { describe, it, expect, afterEach } from "vitest";
import { getClientIp } from "@/lib/rateLimit";

const saved = { proxy: process.env.TRUST_PROXY_HEADERS, cf: process.env.TRUST_CLOUDFLARE_HEADERS };
afterEach(() => {
  if (saved.proxy === undefined) delete process.env.TRUST_PROXY_HEADERS; else process.env.TRUST_PROXY_HEADERS = saved.proxy;
  if (saved.cf === undefined) delete process.env.TRUST_CLOUDFLARE_HEADERS; else process.env.TRUST_CLOUDFLARE_HEADERS = saved.cf;
});
const req = (headers: Record<string, string>) => new Request("http://x/", { headers });

describe("the address a request is counted under", () => {
  it("ignores every header unless the deployment says a proxy sets them", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    expect(getClientIp(req({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2", "cf-connecting-ip": "3.3.3.3" }))).toBe("direct");
  });

  it("does not take Cloudflare's header from a caller when Cloudflare is not in front", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    delete process.env.TRUST_CLOUDFLARE_HEADERS;
    // the proxy's own headers say who it is; the header the caller typed is not read
    expect(getClientIp(req({ "cf-connecting-ip": "10.99.1.2", "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(getClientIp(req({ "cf-connecting-ip": "10.99.1.2", "x-forwarded-for": "203.0.113.8, 10.0.0.1" }))).toBe("203.0.113.8");
    expect(getClientIp(req({ "cf-connecting-ip": "10.99.1.2" }))).toBe("direct");
  });

  it("takes Cloudflare's header only where the deployment says Cloudflare is in front", () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    process.env.TRUST_CLOUDFLARE_HEADERS = "true";
    expect(getClientIp(req({ "cf-connecting-ip": "198.51.100.4", "x-real-ip": "203.0.113.7" }))).toBe("198.51.100.4");
  });
});

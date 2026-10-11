// Which addresses count as the public web. The check stands between agents (their browser, their page fetches,
// the webhooks they call) and everything that is not public: it must refuse every private range, and it must not
// refuse public ones, or ordinary sites cannot be opened.
import { describe, it, expect } from "vitest";
import { resolvePublicHost } from "@/lib/urlSecurity";

const opened = async (ip: string) => typeof (await resolvePublicHost(ip)) !== "string";

describe("addresses on the public web", () => {
  it.each([
    "192.0.43.8",       // iana.org: found refused by the real test of the browser
    "192.0.32.8", "192.0.1.1", "192.0.3.1", "192.0.255.1",
    "93.184.216.34", "104.18.24.232", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1",
    "198.17.0.1", "198.20.0.1", "198.51.99.1", "203.0.112.1", "169.253.0.1", "192.167.0.1", "192.169.0.1",
  ])("%s is opened", async (ip) => { expect(await opened(ip)).toBe(true); });

  it.each([
    "192.0.0.1", "192.0.0.170",   // set aside for protocols
    "192.0.2.1",                  // documentation
    "0.0.0.0", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.8.8.8", "100.64.0.1", "100.127.255.255",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255",
    "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "255.255.255.255",
  ])("%s is refused", async (ip) => { expect(await opened(ip)).toBe(false); });

  it.each(["::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.0.0.1", "fe80::1", "fc00::1", "fd12:3456::1"])("%s is refused", async (ip) => {
    expect(await opened(ip)).toBe(false);
  });

  it("a public address written the long way round is still judged by what it is", async () => {
    expect(await opened("::ffff:192.0.43.8")).toBe(true);
  });
});

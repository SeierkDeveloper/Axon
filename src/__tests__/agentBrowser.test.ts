// Agents that use the internet, phase 1: the groundwork. The switch, the limits, what may be opened and typed into,
// the guard that stands between a browser and this server's network, and (where this machine has a Chrome) a real
// browser started behind that guard. No model is called anywhere here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";

import { browserEnabled, browserLimits, checkBrowserUrl, fieldRefusal, browserUserAgent } from "@/lib/agentBrowser";
import { startGuard, type Guard, type Resolve } from "@/lib/browserGuard";
import { resolvePublicHost } from "@/lib/urlSecurity";
import { openBrowser, findChromium, browserStatus, browserLoad, BrowserPipe, type BrowserSession } from "@/lib/browserSession";
import { PassThrough } from "node:stream";

const listen = (server: http.Server | net.Server): Promise<number> => new Promise((ok) => server.listen(0, "127.0.0.1", () => ok((server.address() as net.AddressInfo).port)));
const shut = (server: http.Server | net.Server): Promise<void> => new Promise((ok) => { (server as http.Server).closeAllConnections?.(); server.close(() => ok()); });

// ── a small public site and a private service, both on this machine ───────────
// "public.test" stands for a site on the public web; the tests' resolver sends that one name to the local site.
// Everything else is resolved by the real rule, so this machine's own addresses are refused exactly as on a server.
let site: http.Server, secret: http.Server, sitePort = 0, secretPort = 0, secretHits = 0;
const resolve: Resolve = async (host) => (host === "public.test" ? { address: "127.0.0.1", family: 4, port: sitePort } : resolvePublicHost(host));

beforeAll(async () => {
  secret = http.createServer((_q, r) => { secretHits++; r.end("the database password"); });
  secretPort = await listen(secret);
  site = http.createServer((q, r) => {
    if (q.url === "/redirect") { r.writeHead(302, { location: "http://127.0.0.1/secret" }).end(); return; }
    if (q.url === "/big") { r.writeHead(200, { "content-type": "application/octet-stream" }); const chunk = Buffer.alloc(256 * 1024, 7); let n = 0; const more = () => { if (n++ >= 16 || r.destroyed) { r.end(); return; } r.write(chunk, more); }; more(); return; }
    if (q.url === "/popup") { r.writeHead(200, { "content-type": "text/html" }).end(`<title>Popup</title><script>window.open("http://public.test/");alert("hello from the page")</script><p>opened</p>`); return; }
    r.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Public page</title><h1>Welcome</h1><p id="out">waiting</p>
      <script>
        // what a hostile page would try: this machine, the private network, the hosting provider's own address.
        // A page cannot read the answer either way, so the proof is on the other side: the private service is
        // never asked, and the guard has each attempt on its list.
        const tries = ["http://127.0.0.1:${secretPort}/", "http://127.0.0.1/", "http://localhost/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.1/", "https://127.0.0.1/", "wss://localhost/"];
        const ask = (u) => u.startsWith("ws") ? new Promise((done) => { try { const w = new WebSocket(u); w.onopen = w.onerror = w.onclose = () => done(); } catch { done(); } }) : fetch(u, { mode: "no-cors" }).then(() => 0, () => 0);
        Promise.all(tries.map(ask)).then(() => { document.getElementById("out").textContent = "tried"; });
      </script>`);
  });
  sitePort = await listen(site);
});
afterAll(async () => { await shut(site); await shut(secret); });

describe("the switch and the limits", () => {
  it("is off unless AGENT_BROWSER says on", () => {
    expect(browserEnabled({})).toBe(false);
    expect(browserEnabled({ AGENT_BROWSER: "off" })).toBe(false);
    expect(browserEnabled({ AGENT_BROWSER: "yes" })).toBe(false);
    expect(browserEnabled({ AGENT_BROWSER: " ON " })).toBe(true);
  });

  it("gives a job a number of steps, an amount of time and an amount of data", () => {
    const l = browserLimits({});
    expect(l).toMatchObject({ steps: 25, seconds: 300, pageSeconds: 25, megabytes: 60, atOnce: 2, width: 1280, height: 800 });
    expect(browserLimits({ AXON_BROWSER_MAX_STEPS: "40", AXON_BROWSER_AT_ONCE: "1" })).toMatchObject({ steps: 40, atOnce: 1 });
  });

  it("ignores a limit that is out of range, so a typo cannot open the gates", () => {
    expect(browserLimits({ AXON_BROWSER_MAX_STEPS: "100000", AXON_BROWSER_MAX_SECONDS: "-1", AXON_BROWSER_MAX_MB: "lots", AXON_BROWSER_AT_ONCE: "" })).toMatchObject({ steps: 25, seconds: 300, megabytes: 60, atOnce: 2 });
  });

  it("an opened browser is refused while the switch is off, and nothing is started", async () => {
    const r = await openBrowser({ env: {} });
    expect(r).toMatchObject({ ok: false, refused: "off" });
    expect(browserLoad().open).toBe(0);
  });

  it("says so when the server has no browser", async () => {
    const r = await openBrowser({ env: { AGENT_BROWSER: "on", AXON_CHROMIUM_PATH: "/nowhere/chromium" } });
    expect(r).toMatchObject({ ok: false, refused: "missing" });
    expect(browserStatus({ AGENT_BROWSER: "on", AXON_CHROMIUM_PATH: "/nowhere/chromium" })).toMatchObject({ enabled: true, installed: false });
    expect(browserLoad().open).toBe(0);
  });
});

describe("what may be opened", () => {
  it("opens web addresses, and reads a bare name as https", () => {
    expect(checkBrowserUrl("https://example.com/a?b=1")).toEqual({ ok: true, url: "https://example.com/a?b=1" });
    expect(checkBrowserUrl("example.com")).toEqual({ ok: true, url: "https://example.com/" });
    expect(checkBrowserUrl("  http://example.com:80/x ")).toMatchObject({ ok: true });
  });

  it.each([
    ["file:///etc/passwd", "scheme"], ["javascript:alert(1)", "scheme"], ["data:text/html,<h1>x</h1>", "scheme"], ["chrome://settings", "scheme"],
    ["view-source:https://example.com", "scheme"], ["ftp://example.com/x", "scheme"], ["about:blank", "scheme"],
    ["https://user:pass@example.com/", "credentials"], ["https://user@example.com/", "credentials"],
    ["https://example.com:8443/", "port"], ["http://example.com:3000/", "port"], ["localhost:3000", "port"],
    ["http://localhost/", "host"], ["https://db.internal/", "host"], ["https://printer.local/", "host"], ["http://intranet/", "host"], ["https://axon.railway.internal/api/health", "host"],
    ["", "not_a_url"], ["not a url", "not_a_url"], ["https://", "not_a_url"],
  ])("refuses %s (%s)", (raw, why) => {
    expect(checkBrowserUrl(raw)).toMatchObject({ ok: false, refused: why });
  });

  it("refuses an address longer than any real one", () => {
    expect(checkBrowserUrl(`https://example.com/${"a".repeat(2100)}`)).toMatchObject({ ok: false, refused: "not_a_url" });
  });
});

describe("what is never typed into", () => {
  it.each([
    [{ type: "password" }], [{ type: "text", autocomplete: "current-password" }], [{ autocomplete: "one-time-code" }], [{ name: "passwd" }],
    [{ id: "login_password" }], [{ label: "Verification code" }], [{ placeholder: "Enter your PIN" }], [{ name: "otp" }],
  ])("a sign-in field: %j", (f) => {
    expect(fieldRefusal(f)).toMatch(/signs in nowhere/);
  });

  it.each([
    [{ autocomplete: "cc-number" }], [{ name: "cardNumber" }], [{ label: "CVV" }], [{ name: "iban" }], [{ placeholder: "Card number" }],
    [{ label: "Expiry date" }], [{ name: "seed_phrase" }], [{ label: "Private key" }],
  ])("a payment or secret-key field: %j", (f) => {
    expect(fieldRefusal(f)).toMatch(/pays nowhere/);
  });

  it("a file field, since nothing is handed to a page from here", () => {
    expect(fieldRefusal({ type: "file" })).toMatch(/file/);
  });

  it.each([
    [{ type: "search", name: "q" }], [{ type: "text", label: "City" }], [{ type: "email", name: "email", autocomplete: "email" }],
    [{ name: "first_name" }], [{ type: "number", label: "Quantity" }], [{ label: "Postcode", autocomplete: "postal-code" }], [{ name: "company", placeholder: "Company" }],
  ])("but an ordinary field is fine: %j", (f) => {
    expect(fieldRefusal(f)).toBeNull();
  });
});

describe("the name it gives itself", () => {
  it("is an ordinary Chrome that also says who is driving", () => {
    const ua = browserUserAgent("126.0.6478.126", {});
    expect(ua).toContain("Chrome/126.0.6478.126");
    expect(ua).toContain("AxonAgent/1.0");
    expect(ua).not.toMatch(/Headless/i);
  });
  it("falls back to a plain version when the browser's own cannot be read", () => {
    expect(browserUserAgent("weird", {})).toContain("Chrome/126.0.0.0");
  });
});

// ── the guard, without a browser: what a page could ask for, asked directly ───
describe("the guard", () => {
  let guard: Guard;
  beforeAll(async () => { guard = await startGuard({ maxBytes: 1024 * 1024, resolve }); });
  afterAll(async () => { await guard.close(); });

  /** A plain http request sent through the guard, as the browser sends it. */
  const through = (url: string): Promise<{ status: number; body: string; guard?: string }> => new Promise((ok, fail) => {
    const q = http.request({ host: "127.0.0.1", port: guard.port, method: "GET", path: url, headers: { host: new URL(url).host } }, (r) => {
      let body = ""; r.on("data", (c) => { body += c; }); r.on("end", () => ok({ status: r.statusCode ?? 0, body, guard: r.headers["x-axon-guard"] as string | undefined })); r.on("error", fail);
    });
    q.on("error", fail); q.end();
  });
  /** A tunnel asked of the guard, as the browser asks for an https page. Gives the first line of the answer. */
  const tunnel = (target: string): Promise<string> => new Promise((ok, fail) => {
    const s = net.connect(guard.port, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let said = "";
    s.once("data", (d) => { said = d.toString().split("\r\n")[0]; ok(said); s.destroy(); });
    s.once("close", () => { if (!said) ok("closed without an answer"); });
    s.on("error", fail);
  });

  it("lets a public site through", async () => {
    const r = await through("http://public.test/");
    expect(r.status).toBe(200);
    expect(r.body).toContain("Public page");
  });

  it.each([
    "http://127.0.0.1/", "http://localhost/", "http://0.0.0.0/", "http://10.1.2.3/", "http://192.168.1.1/", "http://172.16.0.9/",
    "http://169.254.169.254/latest/meta-data/", "http://100.64.0.1/", "http://[::1]/", "http://[fd12:3456::1]/", "http://[::ffff:127.0.0.1]/",
    "http://db.railway.internal/", "http://printer.local/", "http://2130706433/",
  ])("refuses %s", async (url) => {
    const before = secretHits;
    const r = await through(url);
    expect(r.status).toBe(403);
    expect(r.guard).toBe("refused");
    expect(secretHits).toBe(before);
  });

  it("refuses a port that is not a web port, on any host", async () => {
    const before = secretHits;
    expect((await through(`http://127.0.0.1:${secretPort}/`)).status).toBe(403);
    expect((await through("http://public.test:8080/")).status).toBe(403);
    expect(secretHits).toBe(before);
  });

  it("refuses the same things when asked for a tunnel", async () => {
    expect(await tunnel("127.0.0.1:443")).toMatch(/403/);
    expect(await tunnel("localhost:443")).toMatch(/403/);
    expect(await tunnel("169.254.169.254:80")).toMatch(/403/);
    expect(await tunnel("[::1]:443")).toMatch(/403/);
    expect(await tunnel(`127.0.0.1:${secretPort}`)).toMatch(/403/);
    expect(await tunnel("public.test:22")).toMatch(/403/);
    expect(await tunnel("not a target")).toMatch(/400|closed without an answer/);
  });

  it("opens a tunnel to a public site", async () => {
    expect(await tunnel("public.test:80")).toMatch(/200/);
  });

  it("remembers what it refused and why", () => {
    expect(guard.whyRefused("localhost")).toBeTruthy();
    expect(guard.whyRefused("public.test")).toBe("port");
    expect(guard.whyRefused("example.org")).toBeNull();
    expect(guard.refused().length).toBeGreaterThan(10);
  });

  it("connects to the address it checked, not to a second answer for the same name", async () => {
    // a name that is public the first time it is asked and private ever after: the guard asks once per connection
    let asked = 0;
    const flip: Resolve = async (host) => (host === "flip.test" ? (asked++ === 0 ? { address: "127.0.0.1", family: 4, port: sitePort } : "endpoint host resolves to a private or reserved address") : resolvePublicHost(host));
    const g = await startGuard({ maxBytes: 1024 * 1024, resolve: flip });
    const get = (): Promise<number> => new Promise((ok) => { http.request({ host: "127.0.0.1", port: g.port, path: "http://flip.test/", headers: { host: "flip.test" } }, (r) => { r.resume(); r.on("end", () => ok(r.statusCode ?? 0)); }).end(); });
    expect(await get()).toBe(200);
    expect(await get()).toBe(403);
    expect(asked).toBe(2);
    await g.close();
  });

  it("stops everything once the job has pulled down more than it may", async () => {
    const g = await startGuard({ maxBytes: 600 * 1024, resolve });
    const got = await new Promise<number>((ok) => {
      let n = 0;
      const q = http.request({ host: "127.0.0.1", port: g.port, path: "http://public.test/big", headers: { host: "public.test" } }, (r) => { r.on("data", (c) => { n += c.length; }); r.on("close", () => ok(n)); r.on("error", () => ok(n)); });
      q.on("error", () => ok(n)); q.end();
    });
    expect(g.spent()).toBe(true);
    expect(got).toBeLessThan(4 * 1024 * 1024);
    const after = await new Promise<number>((ok) => { http.request({ host: "127.0.0.1", port: g.port, path: "http://public.test/", headers: { host: "public.test" } }, (r) => { r.resume(); ok(r.statusCode ?? 0); }).end(); });
    expect(after).toBe(403);
    await g.close();
  });
});

describe("the pipe to the browser", () => {
  it("matches answers to commands, hands events to listeners and survives a message split across chunks", async () => {
    const toBrowser = new PassThrough(), fromBrowser = new PassThrough();
    const pipe = new BrowserPipe(toBrowser, fromBrowser);
    const sent: string[] = [];
    toBrowser.on("data", (d: Buffer) => sent.push(d.toString()));
    const events: unknown[] = [];
    pipe.on("Page.loadEventFired", (p, sid) => events.push([p, sid]));
    const a = pipe.send("Browser.getVersion");
    const b = pipe.send("Page.navigate", { url: "https://example.com" }, "S1");
    await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(sent.join("").split("\0")[1])).toMatchObject({ id: 2, method: "Page.navigate", sessionId: "S1" });
    const reply = `${JSON.stringify({ id: 2, result: { frameId: "F" } })}\0${JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "S1" })}\0${JSON.stringify({ id: 1, result: { product: "Chrome/1.2.3.4" } })}\0`;
    fromBrowser.write(Buffer.from(reply.slice(0, 20))); fromBrowser.write(Buffer.from(reply.slice(20)));
    expect(await a).toEqual({ product: "Chrome/1.2.3.4" });
    expect(await b).toEqual({ frameId: "F" });
    expect(events).toEqual([[{ timestamp: 1 }, "S1"]]);
  });

  it("fails what is waiting when the browser goes away, and everything after", async () => {
    const toBrowser = new PassThrough(), fromBrowser = new PassThrough();
    const pipe = new BrowserPipe(toBrowser, fromBrowser);
    const waiting = pipe.send("Page.enable");
    pipe.end(new Error("the browser closed"));
    await expect(waiting).rejects.toThrow(/closed/);
    await expect(pipe.send("Page.enable")).rejects.toThrow(/closed/);
  });

  it("passes on the browser's own refusal of a command", async () => {
    const toBrowser = new PassThrough(), fromBrowser = new PassThrough();
    const pipe = new BrowserPipe(toBrowser, fromBrowser);
    const p = pipe.send("Nope.nothing");
    fromBrowser.write(`${JSON.stringify({ id: 1, error: { code: -32601, message: "'Nope.nothing' wasn't found" } })}\0`);
    await expect(p).rejects.toThrow(/wasn't found/);
  });
});

// ── a real browser behind the guard, where this machine has one ──────────────
const chrome = findChromium({});
const env = { AGENT_BROWSER: "on", PATH: process.env.PATH };
describe.skipIf(!chrome)("a real browser behind the guard", () => {
  let s: BrowserSession;
  beforeAll(async () => {
    const r = await openBrowser({ env, resolve, limits: { ...browserLimits({}), steps: 6, pageSeconds: 15 } });
    if (!r.ok) throw new Error(r.reason);
    s = r.session;
  }, 60_000);
  afterAll(async () => { await s?.close(); });

  it("opens a public page and can see it", async () => {
    const r = await s.goto("http://public.test/");
    expect(r).toMatchObject({ ok: true, title: "Public page", status: 200 });
    expect(await s.text()).toContain("Welcome");
    const shot = await s.screenshot();
    expect(shot.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(shot.length).toBeGreaterThan(2_000);
    expect(browserLoad().open).toBe(1);
  }, 60_000);

  it("a script on that page cannot reach this machine or the private network", async () => {
    const before = secretHits;
    let out = "";
    for (let i = 0; i < 80 && out !== "tried"; i++) { out = String((await s.command("Runtime.evaluate", { expression: "document.getElementById('out').textContent", returnByValue: true }) as { result?: { value?: string } }).result?.value ?? ""); await new Promise((r) => setTimeout(r, 250)); }
    expect(out).toBe("tried");
    expect(secretHits).toBe(before);
    expect(s.notes().refused.map((r) => r.host)).toEqual(expect.arrayContaining(["127.0.0.1", "localhost", "169.254.169.254", "::1", "10.0.0.1"]));
  }, 60_000);

  it("is not sent to this machine, to a file or to a page that leads there", async () => {
    const before = secretHits;
    expect(await s.goto("http://127.0.0.1/")).toMatchObject({ ok: false });
    expect(await s.goto("file:///etc/passwd")).toMatchObject({ ok: false, reason: expect.stringMatching(/http and https/) });
    expect(await s.goto("http://localhost/")).toMatchObject({ ok: false });
    const led = await s.goto("http://public.test/redirect");
    expect(led).toMatchObject({ ok: false });
    expect(secretHits).toBe(before);
    expect((await s.where()).url).not.toMatch(/127\.0\.0\.1|localhost|^file:/);
  }, 60_000);

  it("a page that opens a second window is taken there in the one it has, and its dialog is dismissed", async () => {
    const r = await s.goto("http://public.test/popup");
    expect(r).toMatchObject({ ok: true });
    await new Promise((res) => setTimeout(res, 1200));
    expect(s.notes().dialogs).toContain("hello from the page");
    expect((await s.where()).title).toBe("Public page");
    const targets = (await s.command("Target.getTargets") as { targetInfos: { type: string }[] }).targetInfos.filter((t) => t.type === "page");
    expect(targets.length).toBe(1);
  }, 60_000);

  it("stops when the job's steps are used up", async () => {
    expect(s.left().steps).toBe(2); // four were taken; the two refused as written (the file, localhost) cost nothing
    expect(await s.goto("http://public.test/")).toMatchObject({ ok: true });
    expect(await s.goto("http://public.test/")).toMatchObject({ ok: true });
    expect(await s.goto("http://public.test/")).toMatchObject({ ok: false, reason: expect.stringMatching(/all 6/) });
  }, 60_000);

  it("leaves nothing behind when it is closed", async () => {
    await s.close();
    expect(browserLoad().open).toBe(0);
    await expect(s.screenshot()).rejects.toThrow(/closed/);
    expect(s.step()).toMatchObject({ ok: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.home.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(s.home)).toBe(false);
  }, 60_000);

  it("gives a second job an empty browser: no cookie from the first", async () => {
    const a = await openBrowser({ env, resolve });
    if (!a.ok) throw new Error(a.reason);
    await a.session.goto("http://public.test/");
    await a.session.command("Runtime.evaluate", { expression: "document.cookie = 'seen=1; max-age=3600'; localStorage.setItem('seen', '1')" });
    await a.session.close();
    const b = await openBrowser({ env, resolve });
    if (!b.ok) throw new Error(b.reason);
    await b.session.goto("http://public.test/");
    const kept = (await b.session.command("Runtime.evaluate", { expression: "document.cookie + '|' + (localStorage.getItem('seen') ?? '')", returnByValue: true }) as { result: { value: string } }).result.value;
    await b.session.close();
    expect(kept).toBe("|");
  }, 90_000);

  it("is closed for the job when it pulls down more than it may", async () => {
    const r = await openBrowser({ env, resolve, limits: { ...browserLimits({}), megabytes: 1 } });
    if (!r.ok) throw new Error(r.reason);
    await r.session.goto("http://public.test/");
    await r.session.command("Runtime.evaluate", { expression: "fetch('http://public.test/big').then((x) => x.arrayBuffer()).catch(() => 0)", awaitPromise: true }).catch(() => undefined);
    expect(r.session.step()).toMatchObject({ ok: false, reason: expect.stringMatching(/data/) });
    expect(await r.session.goto("http://public.test/")).toMatchObject({ ok: false });
    await r.session.close();
  }, 90_000);

  it("closes itself when the job's time is up", async () => {
    const r = await openBrowser({ env, resolve, limits: { ...browserLimits({}), seconds: 10 } });
    if (!r.ok) throw new Error(r.reason);
    expect(r.session.left().seconds).toBeGreaterThan(5);
    await new Promise((res) => setTimeout(res, 11_500));
    expect(r.session.step()).toMatchObject({ ok: false });
    expect(browserLoad().open).toBe(0);
  }, 60_000);

  it("runs only so many at once: the next job waits, and is told when none comes free", async () => {
    const limits = { ...browserLimits({}), atOnce: 1, waitSeconds: 2 };
    const first = await openBrowser({ env, resolve, limits });
    if (!first.ok) throw new Error(first.reason);
    const second = await openBrowser({ env, resolve, limits });
    expect(second).toMatchObject({ ok: false, refused: "busy" });
    const third = openBrowser({ env, resolve, limits: { ...limits, waitSeconds: 30 } });
    await new Promise((r) => setTimeout(r, 300));
    expect(browserLoad()).toMatchObject({ open: 1, waiting: 1 });
    await first.session.close();
    const got = await third;
    expect(got.ok).toBe(true);
    if (got.ok) await got.session.close();
    expect(browserLoad()).toEqual({ open: 0, waiting: 0 });
  }, 90_000);
});

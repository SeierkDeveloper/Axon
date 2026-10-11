// A browser's own check of itself, run on the server it will work on.
//
// The tests prove the rules on a developer's machine. This proves them where it counts: it starts the server's real
// browser, opens a public page, and then tries, from outside the page and from inside it, to reach what a browser
// must never reach from here: this server itself, the private network it sits in, and the hosting provider's own
// address. Every one of those must fail. It calls no model and costs nothing but a few seconds.

import { browserLeftovers, browserLoad, browserStatus, openBrowser } from "./browserSession";

type Env = Record<string, string | undefined>;
export interface Check { name: string; ok: boolean; detail?: string }
export interface SelfTest { ok: boolean; ms: number; status: ReturnType<typeof browserStatus>; version?: string; sandboxed?: boolean; page?: { url: string; title: string; status: number | null; words: number; shotBytes: number }; checks: Check[]; shot?: Buffer }

/** The addresses that must stay out of reach: this machine, the private network, the provider's own. */
function forbidden(env: Env): string[] {
  const own = [env.RAILWAY_PRIVATE_DOMAIN, env.RAILWAY_SERVICE_NAME ? `${env.RAILWAY_SERVICE_NAME.toLowerCase()}.railway.internal` : ""].filter((h): h is string => Boolean(h && /^[a-z0-9.-]+$/i.test(h)));
  return ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.0.1/", "https://127.0.0.1/", ...own.map((h) => `http://${h}/api/health`)];
}

export async function browserSelfTest(o: { url?: string; env?: Env } = {}): Promise<SelfTest> {
  const env = o.env ?? process.env;
  const r = await runChecks(o);
  // after it is closed: nothing of it may be left on the machine
  await new Promise((done) => setTimeout(done, 400));
  const left = browserLeftovers(env);
  r.checks.push({ name: "its place is free again", ok: browserLoad().open === 0, detail: `${browserLoad().open} open` });
  if (left !== null) r.checks.push({ name: "it leaves no process behind", ok: left === 0, detail: `${left} left` });
  return { ...r, ok: r.checks.every((c) => c.ok), status: browserStatus(env) };
}

async function runChecks(o: { url?: string; env?: Env }): Promise<SelfTest> {
  const env = o.env ?? process.env, t0 = Date.now(), checks: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, ...(detail ? { detail: detail.slice(0, 300) } : {}) }); };
  const done = (extra: Partial<SelfTest> = {}): SelfTest => ({ ok: checks.length > 0 && checks.every((c) => c.ok), ms: Date.now() - t0, status: browserStatus(env), checks, ...extra });

  const opened = await openBrowser({ env, taskId: "self-test" });
  add("a browser starts", opened.ok, opened.ok ? undefined : opened.reason);
  if (!opened.ok) return done();
  const s = opened.session;
  try {
    // 1. the public web is there
    const url = o.url ?? "https://example.com/";
    const page = await s.goto(url);
    add("a public page opens", page.ok, page.ok ? `${page.title} (${page.status ?? "?"})` : page.reason);
    let shot: Buffer | undefined, words = 0;
    if (page.ok) {
      const text = await s.text(5_000);
      words = text.split(/\s+/).filter(Boolean).length;
      add("its words can be read", words > 0, `${words} words`);
      shot = await s.screenshot(70);
      add("it can be photographed", shot.length > 1_000 && shot[0] === 0xff && shot[1] === 0xd8, `${shot.length} bytes`);
      const ua = String((await s.command("Runtime.evaluate", { expression: "navigator.userAgent", returnByValue: true }) as { result?: { value?: string } }).result?.value ?? "");
      add("it says who is driving", /AxonAgent/.test(ua) && !/Headless/i.test(ua), ua);

      // 2. from inside a page: what a hostile script would try. Asked from an empty page, so that no rule of the
      // site just visited stops the attempts before they leave the browser: the guard is what has to stop them.
      await s.command("Page.navigate", { url: "about:blank" });
      const port = Number(env.PORT) || 3000;
      const tries = [...new Set([...forbidden(env), ...forbidden(env).map((u) => u.replace(/^http:/, "https:"))]), `http://127.0.0.1:${port}/api/health`, `https://localhost:${port}/api/health`];
      await s.command("Runtime.evaluate", {
        expression: `Promise.all(${JSON.stringify(tries)}.map((u) => fetch(u, { mode: "no-cors" }).then(() => 0, () => 0))).then(() => new Promise((r) => { try { const w = new WebSocket("wss://127.0.0.1:${port}/"); w.onopen = w.onerror = w.onclose = () => r(0); } catch { r(0); } }))`,
        awaitPromise: true,
      }, 40_000).catch(() => undefined);
      const seen = new Set(s.notes().refused.map((r) => r.host));
      const hosts = [...new Set(tries.map((u) => new URL(u).hostname.replace(/^\[|\]$/g, "")))];
      const missed = hosts.filter((h) => !seen.has(h));
      add("a script on a page cannot reach this server or its network", missed.length === 0, missed.length ? `not stopped by the guard: ${missed.join(", ")}` : `${hosts.length} addresses tried, all refused`);
    }

    // 3. from outside the page: being sent there
    for (const target of [...forbidden(env), "file:///etc/passwd", "chrome://version", `http://127.0.0.1:${Number(env.PORT) || 3000}/api/health`]) {
      if (s.left().steps < 2) break;
      const r = await s.goto(target);
      add(`it is not sent to ${target}`, !r.ok, r.ok ? `OPENED: ${r.title}` : r.reason);
    }
    const at = await s.where();
    add("and it is left on no such page", !/127\.0\.0\.1|localhost|169\.254|railway\.internal|^file:|^chrome:/.test(at.url), at.url || "(blank)");
    const pageInfo = page.ok && shot ? { url: page.url, title: page.title, status: page.status, words, shotBytes: shot.length } : undefined;
    return done({ version: s.version, sandboxed: s.sandboxed, ...(pageInfo ? { page: pageInfo } : {}), ...(shot ? { shot } : {}) });
  } catch (err) {
    add("the check ran to its end", false, (err as Error).message);
    return done({ version: s.version, sandboxed: s.sandboxed });
  } finally {
    await s.close();
  }
}

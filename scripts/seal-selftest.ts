// The seal, proved in a real browser.   npx tsx scripts/seal-selftest.ts
//
// src/lib/siteSeal.ts says what a built page may do: run its own script and nothing else. This starts a real Chrome
// and a small server that stands in for Axon (the same page policy, a cookie and a stored value that are "the
// visitor's sign-in"), puts a page inside the seal that tries everything a hostile built page would try, and counts
// what got out. Nothing may. The same hostile page is then shown WITHOUT the seal, where it must get out: that is
// what proves the count can see a leak at all.
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
import { seal, SEAL_HOLDER_POLICY, SEAL_SANDBOX } from "../src/lib/siteSeal";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Axon's own policy for its pages (next.config.ts): what the frame's document would inherit if it had no seal.
// The page that holds a sealed frame adds its part of the seal in front.
const AXON_POLICY = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https: blob:", "font-src 'self'", "worker-src 'self' blob:", "connect-src 'self' ws: wss:", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'"].join("; ");
const HOLDER_POLICY = `${SEAL_HOLDER_POLICY}; ${AXON_POLICY}`;

// Everything a hostile built page would try. Each try says what happened to the page around it.
const hostile = (origin: string): string => `<!doctype html><html><head><title>hostile</title></head><body>
<form id="f1" method="post" action="${origin}/hit?what=form"><input name="a" value="1"></form>
<a id="a1" href="${origin}/hit?what=link-top" target="_top">x</a>
<script>
const say = (what, value) => { try { parent.postMessage({ what, value: String(value).slice(0, 200) }, "*"); } catch (e) {} };
const attempt = (what, fn) => { try { const v = fn(); say(what, v === undefined ? "ran" : v); } catch (e) { say(what, "refused: " + e.name); } };
attempt("read the page's cookie", () => parent.document.cookie);
attempt("read the page's storage", () => parent.localStorage.getItem("signin"));
attempt("read its own cookie", () => document.cookie || "(empty)");
attempt("read its own storage", () => localStorage.getItem("signin"));
attempt("fetch", () => { fetch("${origin}/hit?what=fetch").catch(() => {}); });
attempt("fetch, no-cors", () => { fetch("${origin}/hit?what=fetch-nocors", { mode: "no-cors" }).catch(() => {}); });
attempt("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", "${origin}/hit?what=xhr"); x.send(); });
attempt("beacon", () => navigator.sendBeacon("${origin}/hit?what=beacon", "d"));
attempt("picture", () => { new Image().src = "${origin}/hit?what=img"; });
attempt("socket", () => { new WebSocket("${origin.replace("http", "ws")}/hit?what=socket"); });
attempt("event source", () => { new EventSource("${origin}/hit?what=eventsource"); });
attempt("script from outside", () => { const s = document.createElement("script"); s.src = "${origin}/hit?what=script"; document.head.appendChild(s); });
attempt("style from outside", () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "${origin}/hit?what=css"; document.head.appendChild(l); });
attempt("frame", () => { const i = document.createElement("iframe"); i.src = "${origin}/hit?what=frame"; document.body.appendChild(i); });
attempt("refresh tag", () => { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=${origin}/hit?what=refresh"; document.head.appendChild(m); });
attempt("send a form", () => { document.getElementById("f1").submit(); });
attempt("open a window", () => { const w = window.open("${origin}/hit?what=open"); return w ? "opened" : "no window"; });
attempt("click a link to the top", () => { document.getElementById("a1").click(); });
attempt("move the page", () => { top.location = "${origin}/hit?what=top"; });
say("done", "done");
// last, because it would take the frame itself somewhere else, with whatever it wants to carry in the address
setTimeout(() => { try { location.href = "${origin}/hit?what=move-itself"; } catch (e) {} }, 400);
</script></body></html>`;

interface Run { hits: string[]; said: Record<string, string>; href: string }

async function run(sealed: boolean, pagePolicy = sealed ? HOLDER_POLICY : AXON_POLICY): Promise<Run> {
  const hits: string[] = [];
  let doc = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/hit") {
      hits.push(url.searchParams.get("what") ?? "?");
      res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
      return res.end("ok");
    }
    // the page around the frame: Axon's policy, a cookie and a stored value standing in for the visitor's sign-in
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": pagePolicy, "set-cookie": "signin=PARENT-COOKIE; Path=/" });
    res.end(`<!doctype html><html><body><iframe id="f"></iframe><script>
localStorage.setItem("signin", "PARENT-STORAGE");
window.__said = {};
addEventListener("message", (e) => { if (e.data && e.data.what) window.__said[e.data.what] = e.data.value; });
const f = document.getElementById("f");
f.setAttribute("sandbox", ${JSON.stringify(sealed ? SEAL_SANDBOX : "allow-scripts allow-same-origin allow-forms allow-popups")});
f.srcdoc = ${JSON.stringify(doc).replace(/</g, "\\u003c")};
</script></body></html>`);
  });
  server.on("upgrade", (req, socket) => { hits.push(new URL(req.url ?? "/", "http://x").searchParams.get("what") ?? "socket"); socket.destroy(); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  doc = sealed ? seal(hostile(origin)) : hostile(origin);

  const profile = mkdtempSync(join(tmpdir(), "seal-selftest-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  try {
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 100 && !target; i++) {
      try { target = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === "page"); } catch { await sleep(150); }
    }
    if (!target) throw new Error(`Chrome did not start (${CHROME}). Set CHROME_PATH to a Chrome or Chromium.`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.on("open", r));
    let id = 0;
    const waiting = new Map<number, (v: { result?: { result?: { value?: unknown } } }) => void>();
    ws.on("message", (m) => { const x = JSON.parse(String(m)); if (x.id && waiting.has(x.id)) { waiting.get(x.id)!(x); waiting.delete(x.id); } });
    const send = (method: string, params: object = {}) => new Promise<{ result?: { result?: { value?: unknown } } }>((r) => { const n = ++id; waiting.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result?.result?.value;
    await send("Page.enable");
    await send("Page.navigate", { url: `${origin}/` });
    await sleep(3500);
    const href = String(await evaluate("location.href"));
    const said = JSON.parse(String((await evaluate("JSON.stringify(window.__said || {})")) ?? "{}")) as Record<string, string>;
    ws.close();
    return { hits: [...new Set(hits)].sort(), said, href: href.replace(origin, "") };
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
const inside = await run(true);
console.log("\nInside the seal:");
check("the hostile page ran (the seal lets a built page run its own script)", inside.said.done === "done");
check("nothing it tried reached a server: no request, no socket, no form, no window", inside.hits.length === 0, inside.hits.length ? `got out: ${inside.hits.join(", ")}` : "0 requests");
check("it could not read the page's cookie", !String(inside.said["read the page's cookie"]).includes("PARENT"), inside.said["read the page's cookie"]);
check("it could not read the page's storage", !String(inside.said["read the page's storage"]).includes("PARENT"), inside.said["read the page's storage"]);
check("its own cookie and storage are not the visitor's", !String(inside.said["read its own cookie"]).includes("PARENT") && !String(inside.said["read its own storage"]).includes("PARENT"), `${inside.said["read its own cookie"]} / ${inside.said["read its own storage"]}`);
check("it could not move the page around it", inside.href === "/", inside.href);
check("it could not open a window", inside.said["open a window"] !== "opened", inside.said["open a window"]);

const halfway = await run(true, AXON_POLICY);
console.log("\nSealed, but on a page that does not send its part of the seal:");
check("the frame can then send itself somewhere else (which is why the page around it must send frame-src 'none')", halfway.hits.includes("refresh") || halfway.hits.includes("move-itself"), halfway.hits.join(", ") || "nothing got out");

const outside = await run(false);
console.log("\nThe same page with no seal (it must get out, or the count above proves nothing):");
check("without the seal it reads the visitor's cookie and storage", String(outside.said["read the page's cookie"]).includes("PARENT-COOKIE") && String(outside.said["read the page's storage"]).includes("PARENT-STORAGE"));
check("without the seal its requests arrive", ["fetch", "img", "xhr"].every((w) => outside.hits.includes(w)), outside.hits.join(", "));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed${failed.length ? `. FAILED: ${failed.map((c) => c.name).join("; ")}` : "."}`);
process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

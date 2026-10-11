// One job's browser.
//
// A real Chromium, started empty for one job and thrown away after it. This file starts it, talks to it, keeps it
// inside its limits and cleans up. What it may reach is not decided here: the browser has one way out, the guard
// (./browserGuard), and it is started so that it can find no other.
//
// How it is kept apart from the server it runs on:
//
//   Its only road to the network is the guard. It is told to resolve no name itself and to send everything, this
//   machine's own addresses included, through the guard.
//
//   It is driven over a private pipe, not over a port, so nothing on the machine and no page can reach its controls.
//
//   It is started with an empty environment: none of the server's keys are handed to it. Where the server runs as
//   root (the container), the browser runs as its own user with no rights, and the folder holding the database is
//   closed to everybody but root first.
//
//   Its profile is a fresh folder that is deleted when the job ends. A second window is closed as soon as it opens,
//   and a page that pops up a dialog has it dismissed. A file a page offers is refused unless the job's tool asks
//   for that one file: then it is taken into a folder of the browser's own, up to a size, and read from there.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { browserEnabled, browserLimits, browserUserAgent, checkBrowserUrl, type BrowserLimits } from "./agentBrowser";
import { startGuard, type Guard, type Resolve } from "./browserGuard";
import { logger } from "./logger";

type Env = Record<string, string | undefined>;

const CANDIDATES = [
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/lib/chromium/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** The Chromium this server has, or null. AXON_CHROMIUM_PATH names one outright. */
export function findChromium(env: Env = process.env): string | null {
  const named = env.AXON_CHROMIUM_PATH?.trim();
  if (named) return fs.existsSync(named) ? named : null;
  return CANDIDATES.find((p) => fs.existsSync(p)) ?? null;
}

/** The user the browser runs as, when the server itself is root and one was made for it. */
function runAs(env: Env): { uid: number; gid: number } | null {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return null;
  const uid = Number(env.AXON_BROWSER_UID), gid = Number(env.AXON_BROWSER_GID ?? env.AXON_BROWSER_UID);
  return Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0 ? { uid, gid } : null;
}

/** Close the folder that holds the database and the stored files to everybody but root. Root still reads it. */
function closeDataFolder(env: Env): void {
  const db = env.DATABASE_PATH?.trim();
  if (!db) return;
  try { fs.chmodSync(path.dirname(db), 0o700); } catch (err) { logger.warn("browser.data_folder", "The data folder could not be closed to other users", { err }); }
}

// ── the pipe to the browser ──────────────────────────────────────────────────

interface Pending { ok: (v: Record<string, unknown>) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }
type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

/** Commands to the browser and what it says back, over the two pipes it was started with. One message per NUL. */
export class BrowserPipe {
  private seq = 0;
  private buf: Buffer[] = [];
  private readonly waiting = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private dead: Error | null = null;

  constructor(private readonly toBrowser: Writable, fromBrowser: Readable) {
    fromBrowser.on("data", (chunk: Buffer) => this.read(chunk));
    fromBrowser.on("error", () => this.end(new Error("the browser stopped answering")));
    fromBrowser.on("close", () => this.end(new Error("the browser closed")));
    toBrowser.on("error", () => this.end(new Error("the browser stopped listening")));
  }

  private read(chunk: Buffer): void {
    let from = 0;
    for (let i = chunk.indexOf(0); i !== -1; i = chunk.indexOf(0, from)) {
      this.buf.push(chunk.subarray(from, i));
      const text = Buffer.concat(this.buf).toString("utf8");
      this.buf = []; from = i + 1;
      try { this.take(JSON.parse(text) as Record<string, unknown>); } catch { /* not a message: skipped */ }
    }
    if (from < chunk.length) this.buf.push(chunk.subarray(from));
  }

  private take(m: Record<string, unknown>): void {
    if (typeof m.id === "number") {
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id); clearTimeout(w.timer);
      if (m.error) w.fail(new Error(String((m.error as { message?: string }).message ?? "the browser refused a command")));
      else w.ok((m.result ?? {}) as Record<string, unknown>);
      return;
    }
    if (typeof m.method === "string") for (const fn of this.listeners.get(m.method) ?? []) {
      try { fn((m.params ?? {}) as Record<string, unknown>, m.sessionId as string | undefined); } catch { /* a listener's own fault */ }
    }
  }

  end(why: Error): void {
    if (this.dead) return;
    this.dead = why;
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.fail(why); }
    this.waiting.clear();
  }

  on(event: string, fn: Listener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { this.waiting.delete(id); fail(new Error(`the browser did not answer (${method})`)); }, timeoutMs);
      this.waiting.set(id, { ok, fail, timer });
      this.toBrowser.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }
}

// ── how many at once ─────────────────────────────────────────────────────────

let running = 0;
const queue: Array<() => void> = [];

/** A place among the browsers this server runs at once. Resolves to false when none came free in time. */
function takeTurn(limits: BrowserLimits): Promise<boolean> {
  if (running < limits.atOnce) { running++; return Promise.resolve(true); }
  return new Promise((done) => {
    const go = () => { clearTimeout(timer); running++; done(true); };
    const timer = setTimeout(() => { const i = queue.indexOf(go); if (i !== -1) queue.splice(i, 1); done(false); }, limits.waitSeconds * 1000);
    queue.push(go);
  });
}
function giveTurn(): void {
  running = Math.max(0, running - 1);
  queue.shift()?.();
}

/** How many browsers are open and how many jobs wait for one. */
export const browserLoad = (): { open: number; waiting: number } => ({ open: running, waiting: queue.length });

// ── starting it ──────────────────────────────────────────────────────────────

/** Whether this server's Chromium runs inside its own sandbox. Found out on the first start, then remembered. */
let sandboxWorks: boolean | null = null;

function flags(o: { profile: string; guardPort: number; limits: BrowserLimits; sandbox: boolean }): string[] {
  return [
    "--headless=new",
    "--remote-debugging-pipe",
    `--user-data-dir=${o.profile}`,
    `--window-size=${o.limits.width},${o.limits.height}`,
    // the one way out, for every address, this machine's own included; and no name is resolved in the browser itself
    `--proxy-server=http://127.0.0.1:${o.guardPort}`,
    "--proxy-bypass-list=<-loopback>",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    // nothing that travels outside the proxy
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--dns-prefetch-disable",
    "--no-pings",
    // nothing the browser does on its own
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--disable-component-update",
    "--disable-default-apps", "--disable-extensions", "--disable-component-extensions-with-background-pages", "--disable-domain-reliability", "--disable-client-side-phishing-detection",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater",
    "--metrics-recording-only", "--password-store=basic", "--use-mock-keychain", "--disable-breakpad", "--disable-crash-reporter",
    // a small footprint on a server
    "--disable-gpu", "--disable-dev-shm-usage", "--mute-audio", "--hide-scrollbars", "--force-color-profile=srgb", "--js-flags=--max-old-space-size=256",
    ...(o.sandbox ? [] : ["--no-sandbox"]),
    "about:blank",
  ];
}

interface Started { proc: ChildProcess; pipe: BrowserPipe; product: string }

async function start(bin: string, profile: string, guardPort: number, limits: BrowserLimits, env: Env, sandbox: boolean): Promise<Started> {
  const as = runAs(env);
  const proc = spawn(bin, flags({ profile, guardPort, limits, sandbox }), {
    // 3 is what the browser reads its commands from, 4 is where it writes its answers
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    // none of the server's own environment: its keys stay with the server
    env: { PATH: env.PATH ?? "/usr/bin:/bin", HOME: profile, TMPDIR: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile, LANG: "en_US.UTF-8", TZ: "UTC" } as unknown as NodeJS.ProcessEnv,
    ...(as ?? {}),
    // its own process group, so the browser and everything it started can be ended together
    detached: true,
  });
  const pipe = new BrowserPipe(proc.stdio[3] as Writable, proc.stdio[4] as Readable);
  proc.once("exit", () => pipe.end(new Error("the browser closed")));
  proc.once("error", (err) => pipe.end(err));
  try {
    const v = await pipe.send("Browser.getVersion", {}, undefined, 20_000);
    return { proc, pipe, product: String(v.product ?? "") };
  } catch (err) {
    endAll(proc);
    throw err;
  }
}

/** End the browser and every process it started. */
function endAll(proc: ChildProcess): void {
  try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch { /* already gone */ }
  try { proc.kill("SIGKILL"); } catch { /* already gone */ }
}

// ── one job's browser ────────────────────────────────────────────────────────

/** The guard's reason, in the words an agent and its hirer are told. */
function plainWhy(why: string): string {
  if (/could not be resolved/.test(why)) return "no site answers at that name";
  if (/port/.test(why)) return "it is not on a web port";
  if (/used up its data/.test(why)) return "this job has used up its data";
  if (/closed/.test(why)) return "the browser is closed";
  return "it is not on the public web";
}

export type OpenRefusal = "off" | "missing" | "busy" | "failed";
export interface Opened { ok: true; url: string; title: string; status: number | null; slow: boolean }
export interface NotOpened { ok: false; reason: string }

export interface BrowserSession {
  /** Send the browser to an address. Counts as a step. */
  goto(rawUrl: string): Promise<Opened | NotOpened>;
  /** What the window shows now, as a JPEG. */
  screenshot(quality?: number): Promise<Buffer>;
  /** The words on the page, as a reader would see them. */
  text(most?: number): Promise<string>;
  /** Where the browser is. */
  where(): Promise<{ url: string; title: string }>;
  /** One more action taken; false when the job has none left, has run out of time or data, or the browser is gone. */
  step(): { ok: true } | { ok: false; reason: string };
  /** Send a command of the browser's own. For the tools built on this session. */
  command(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Hear what the job's window reports (a page starting to load, a request ending). For the tools built on this. */
  listen(event: string, fn: (params: Record<string, unknown>) => void): void;
  /** The status the page now in the window was answered with, where it is known. */
  lastStatus(): number | null;
  /** Why the guard refused this host, in plain words, or null if it did not. */
  whyRefused(host: string): string | null;
  /** The files pages have offered so far (each a download the browser did not take), oldest first. */
  offered(): { url: string; name: string }[];
  /**
   * Take the one file that `start` makes the page offer (a click on a button, say): downloads are let through for
   * just that long. The file is read and removed; one larger than `maxBytes` is stopped and refused.
   */
  download(start: () => Promise<void>, maxBytes: number): Promise<{ ok: true; name: string; url: string; bytes: Buffer } | { ok: false; reason: string }>;
  /** The name the browser gives itself to the sites it visits. */
  readonly userAgent: string;
  left(): { steps: number; seconds: number; megabytes: number };
  /** What the pages said in dialogs, and what the guard refused. */
  notes(): { dialogs: string[]; refused: { host: string; why: string }[] };
  readonly sandboxed: boolean;
  readonly version: string;
  /** The folder this browser keeps its own things in. Deleted when it is closed. */
  readonly home: string;
  close(): Promise<void>;
}

export interface OpenOptions { env?: Env; limits?: BrowserLimits; resolve?: Resolve; taskId?: string }

/**
 * Start a browser for one job. It must be closed by whoever opened it; it also closes itself when its time is up.
 * Refused, with the reason, when browsers are off, when this server has none, or when all are busy.
 */
export async function openBrowser(o: OpenOptions = {}): Promise<{ ok: true; session: BrowserSession } | { ok: false; refused: OpenRefusal; reason: string }> {
  const env = o.env ?? process.env, limits = o.limits ?? browserLimits(env);
  if (!browserEnabled(env)) return { ok: false, refused: "off", reason: "Browsers are not switched on here." };
  const bin = findChromium(env);
  if (!bin) return { ok: false, refused: "missing", reason: "This server has no browser installed." };
  if (!(await takeTurn(limits))) return { ok: false, refused: "busy", reason: "Every browser is busy right now. Try again in a minute." };

  let guard: Guard | null = null, profile = "", started: Started | null = null, turnHeld = true;
  const cleanup = async () => {
    if (started) endAll(started.proc);
    await guard?.close().catch(() => undefined);
    if (profile) fs.rm(profile, { recursive: true, force: true }, () => undefined);
    if (turnHeld) { turnHeld = false; giveTurn(); }
  };

  try {
    guard = await startGuard({ maxBytes: limits.megabytes * 1024 * 1024, resolve: o.resolve });
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "axon-browser-"));
    const as = runAs(env);
    if (as) { closeDataFolder(env); fs.chownSync(profile, as.uid, as.gid); }
    fs.chmodSync(profile, 0o700);

    // Inside its own sandbox where the server allows that; without it where it does not (most containers).
    const wanted = (env.AXON_BROWSER_SANDBOX ?? "auto").trim().toLowerCase();
    let sandbox = wanted === "on" ? true : wanted === "off" ? false : sandboxWorks ?? true;
    try {
      started = await start(bin, profile, guard.port, limits, env, sandbox);
    } catch (err) {
      if (!sandbox || wanted === "on") throw err;
      sandbox = false;
      started = await start(bin, profile, guard.port, limits, env, false);
    }
    if (wanted !== "on" && wanted !== "off") sandboxWorks = sandbox;

    const { pipe, proc, product } = started;
    const version = /\/([\d.]+)/.exec(product)?.[1] ?? "";
    const t0 = Date.now();
    let steps = 0, closed = false, mainStatus: number | null = null, mainFrame = "";
    const dialogs: string[] = [];

    // A file a page offers is not taken, but the offer is heard, so the agent can be told there was one.
    const downloads = path.join(profile, "downloads");
    fs.mkdirSync(downloads, { recursive: true });
    const asUser = runAs(env);
    if (asUser) fs.chownSync(downloads, asUser.uid, asUser.gid);
    await pipe.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
    const offers: { url: string; name: string; guid: string }[] = [];
    const progress = new Map<string, { state: string; received: number; total: number }>();
    pipe.on("Browser.downloadWillBegin", (p) => { if (offers.length < 50) offers.push({ url: String(p.url ?? ""), name: String(p.suggestedFilename ?? "").slice(0, 200), guid: String(p.guid ?? "") }); });
    pipe.on("Browser.downloadProgress", (p) => { progress.set(String(p.guid ?? ""), { state: String(p.state ?? ""), received: Number(p.receivedBytes) || 0, total: Number(p.totalBytes) || 0 }); });
    await pipe.send("Target.setDiscoverTargets", { discover: true });
    // the one window the browser started with is the job's window
    const there = ((await pipe.send("Target.getTargets")).targetInfos as { targetId: string; type: string }[] | undefined)?.find((t) => t.type === "page");
    const targetId = there?.targetId ?? String((await pipe.send("Target.createTarget", { url: "about:blank" })).targetId);
    const { sessionId } = await pipe.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    const page = (method: string, params: Record<string, unknown> = {}, timeoutMs?: number) => pipe.send(method, params, sessionId, timeoutMs);

    // one window: whatever a page opens besides it is closed again
    pipe.on("Target.targetCreated", (p) => {
      const t = p.targetInfo as { targetId?: string; type?: string } | undefined;
      if (t?.targetId && t.targetId !== targetId && t.type === "page") void pipe.send("Target.closeTarget", { targetId: t.targetId }).catch(() => undefined);
    });
    pipe.on("Page.javascriptDialogOpening", (p, sid) => {
      if (sid !== sessionId) return;
      if (dialogs.length < 20) dialogs.push(String(p.message ?? "").slice(0, 300));
      void page("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined);
    });
    let onLoad: (() => void) | null = null;
    pipe.on("Page.loadEventFired", (_p, sid) => { if (sid === sessionId) onLoad?.(); });
    pipe.on("Network.responseReceived", (p, sid) => {
      if (sid !== sessionId || p.type !== "Document" || p.frameId !== mainFrame) return;
      mainStatus = Number((p.response as { status?: number } | undefined)?.status ?? 0) || null;
    });
    // a page that would open a second window is taken there in the one it has: a second window is closed on sight
    await page("Page.addScriptToEvaluateOnNewDocument", { source: `window.open = (u) => { try { if (u) location.assign(u); } catch {} return null; };` }).catch(() => undefined);
    await page("Page.setInterceptFileChooserDialog", { enabled: true }).catch(() => undefined);

    await page("Page.enable");
    await page("Network.enable");
    await page("Emulation.setDeviceMetricsOverride", { width: limits.width, height: limits.height, deviceScaleFactor: 1, mobile: false });
    await page("Emulation.setUserAgentOverride", { userAgent: browserUserAgent(version, env) });
    mainFrame = String(((await page("Page.getFrameTree")).frameTree as { frame?: { id?: string } } | undefined)?.frame?.id ?? "");

    const close = async () => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      // asked to close, and given a moment to: a browser that ends by itself takes its own processes with it
      const gone = new Promise<void>((done) => { if (proc.exitCode !== null || proc.signalCode !== null) done(); else proc.once("exit", () => done()); });
      await pipe.send("Browser.close", {}, undefined, 2_000).catch(() => undefined);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3_000))]);
      await cleanup();
      logger.info("browser.closed", "A job's browser was closed", { taskId: o.taskId, steps, ms: Date.now() - t0, bytes: guard?.bytes() ?? 0, sandbox });
    };
    const deadline = setTimeout(() => void close(), limits.seconds * 1000);
    deadline.unref?.();
    proc.once("exit", () => { if (!closed) void close(); });

    const left = () => ({
      steps: Math.max(0, limits.steps - steps),
      seconds: Math.max(0, Math.round(limits.seconds - (Date.now() - t0) / 1000)),
      megabytes: Math.max(0, Math.round((limits.megabytes * 1024 * 1024 - (guard?.bytes() ?? 0)) / (1024 * 1024))),
    });
    const usable = (): string | null =>
      closed ? "The browser is closed." : guard!.spent() ? `This job has used up its data (${limits.megabytes} MB).` : Date.now() - t0 > limits.seconds * 1000 ? "This job has used up its time in the browser." : null;
    const step = (): { ok: true } | { ok: false; reason: string } => {
      const gone = usable();
      if (gone) return { ok: false, reason: gone };
      if (steps >= limits.steps) return { ok: false, reason: `This job has used all ${limits.steps} of its browser steps.` };
      steps++;
      return { ok: true };
    };
    const evaluate = async (expression: string): Promise<unknown> => {
      const r = await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, 15_000);
      return (r.result as { value?: unknown } | undefined)?.value;
    };
    const where = async () => {
      const v = (await evaluate("({ url: location.href, title: document.title })").catch(() => null)) as { url?: string; title?: string } | null;
      return { url: String(v?.url ?? ""), title: String(v?.title ?? "").slice(0, 300) };
    };

    const session: BrowserSession = {
      sandboxed: sandbox,
      version,
      home: profile,
      step,
      left,
      where,
      command: (method, params, timeoutMs) => (usable() ? Promise.reject(new Error(usable()!)) : page(method, params, timeoutMs)),
      listen: (event, fn) => pipe.on(event, (p, sid) => { if (sid === sessionId) fn(p); }),
      lastStatus: () => mainStatus,
      whyRefused: (host) => { const why = guard!.whyRefused(host); return why ? plainWhy(why) : null; },
      offered: () => offers.map((o) => ({ url: o.url, name: o.name })),
      userAgent: browserUserAgent(version, env),
      async download(start, maxBytes) {
        const gone = usable();
        if (gone) return { ok: false, reason: gone };
        const before = offers.length;
        const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
        try {
          await pipe.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
          await start();
          // the offer, then the file itself: each is waited for only so long
          for (let i = 0; i < 80 && offers.length === before; i++) await wait(100);
          const offer = offers[before];
          if (!offer) return { ok: false, reason: "No file came of that. It may open a page, not offer a file." };
          const t0 = Date.now();
          for (;;) {
            const p = progress.get(offer.guid);
            if (p && (p.received > maxBytes || p.total > maxBytes)) {
              await pipe.send("Browser.cancelDownload", { guid: offer.guid }).catch(() => undefined);
              return { ok: false, reason: `The file is larger than can be taken here (at most ${Math.round(maxBytes / (1024 * 1024))} MB).` };
            }
            if (p?.state === "completed") break;
            if (p?.state === "canceled") return { ok: false, reason: "The site stopped the download before it finished." };
            if (Date.now() - t0 > 45_000 || usable()) { await pipe.send("Browser.cancelDownload", { guid: offer.guid }).catch(() => undefined); return { ok: false, reason: "The download did not finish in time." }; }
            await wait(150);
          }
          const file = path.join(downloads, offer.guid);
          const size = fs.statSync(file).size;
          if (size > maxBytes) return { ok: false, reason: `The file is larger than can be taken here (at most ${Math.round(maxBytes / (1024 * 1024))} MB).` };
          return { ok: true, name: offer.name, url: offer.url, bytes: fs.readFileSync(file) };
        } catch (err) {
          return { ok: false, reason: `The file could not be taken: ${(err as Error).message}.` };
        } finally {
          await pipe.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true }).catch(() => undefined);
          for (const o of offers.slice(before)) fs.rm(path.join(downloads, o.guid), { force: true }, () => undefined);
        }
      },
      notes: () => ({ dialogs: [...dialogs], refused: guard!.refused().map((r) => ({ host: r.host, why: plainWhy(r.why) })) }),
      async goto(rawUrl) {
        const checked = checkBrowserUrl(rawUrl);
        if (!checked.ok) return { ok: false, reason: checked.reason };
        const turn = step();
        if (!turn.ok) return { ok: false, reason: turn.reason };
        mainStatus = null;
        const host = new URL(checked.url).hostname;
        const refusedBefore = guard!.refused().length;
        const loaded = new Promise<boolean>((done) => {
          const timer = setTimeout(() => { onLoad = null; done(false); }, limits.pageSeconds * 1000);
          onLoad = () => { onLoad = null; clearTimeout(timer); done(true); };
        });
        // why the guard stopped this page, if it did: the address itself, or one it led on to
        const stopped = (): string | null => {
          const own = guard!.whyRefused(host);
          if (own) return plainWhy(own);
          const since = guard!.refused().slice(refusedBefore);
          return since.length ? `it leads to ${since[since.length - 1].host}, and ${plainWhy(since[since.length - 1].why)}` : null;
        };
        let nav: Record<string, unknown>;
        try { nav = await page("Page.navigate", { url: checked.url }, (limits.pageSeconds + 5) * 1000); }
        catch (err) { return { ok: false, reason: usable() ?? `The page did not open: ${(err as Error).message}.` }; }
        if (nav.errorText) {
          onLoad = null;
          await page("Page.navigate", { url: "about:blank" }).catch(() => undefined);
          const why = stopped();
          return { ok: false, reason: why ? `That address is not opened: ${why}.` : `The page did not open (${String(nav.errorText).replace(/^net::/, "")}).` };
        }
        const done = await loaded;
        const at = await where();
        // a page may only ever be a web page: anything else the browser ended up on is left at once
        if (!/^https?:/i.test(at.url)) {
          await page("Page.navigate", { url: "about:blank" }).catch(() => undefined);
          const why = stopped();
          return { ok: false, reason: why ? `That address is not opened: ${why}.` : "The page did not open." };
        }
        // a plain http page the guard refused comes back as the guard's own "not opened" answer: that is not a page
        const refusedHere = mainStatus === 403 ? guard!.whyRefused(new URL(at.url).hostname) : null;
        if (refusedHere) {
          await page("Page.navigate", { url: "about:blank" }).catch(() => undefined);
          return { ok: false, reason: `That address is not opened: ${at.url === checked.url ? plainWhy(refusedHere) : `it leads to ${new URL(at.url).hostname}, and ${plainWhy(refusedHere)}`}.` };
        }
        return { ok: true, url: at.url, title: at.title, status: mainStatus, slow: !done };
      },
      async screenshot(quality = 70) {
        const gone = usable();
        if (gone) throw new Error(gone);
        const r = await page("Page.captureScreenshot", { format: "jpeg", quality: Math.max(20, Math.min(90, Math.round(quality))), captureBeyondViewport: false }, 20_000);
        return Buffer.from(String(r.data ?? ""), "base64");
      },
      async text(most = 20_000) {
        const gone = usable();
        if (gone) throw new Error(gone);
        const t = await evaluate(`(document.body ? document.body.innerText : "").slice(0, ${Math.max(100, Math.min(200_000, Math.floor(most)))})`);
        return String(t ?? "");
      },
      close,
    };
    logger.info("browser.opened", "A browser was started for a job", { taskId: o.taskId, version, sandbox, ms: Date.now() - t0 });
    return { ok: true, session };
  } catch (err) {
    await cleanup();
    logger.error("browser.start_failed", "A browser could not be started", { taskId: o.taskId, err });
    return { ok: false, refused: "failed", reason: "The browser could not be started." };
  }
}

/**
 * Processes of the browser's own user that are still on this machine, running or dead but not cleared away. Null
 * where that cannot be told (no such user here, or not Linux). After a job this should be none.
 */
export function browserLeftovers(env: Env = process.env): number | null {
  const uid = Number(env.AXON_BROWSER_UID);
  if (process.platform !== "linux" || !Number.isInteger(uid) || uid <= 0) return null;
  try {
    let n = 0;
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try { if (fs.statSync(`/proc/${d}`).uid === uid) n++; } catch { /* gone in between */ }
    }
    return n;
  } catch { return null; }
}

/** What this server can say about its browser without starting one. */
export function browserStatus(env: Env = process.env): { enabled: boolean; installed: boolean; path: string | null; ownUser: boolean; load: { open: number; waiting: number }; leftovers: number | null; limits: BrowserLimits; sandbox: boolean | null } {
  const bin = findChromium(env);
  return { enabled: browserEnabled(env), installed: Boolean(bin), path: bin, ownUser: Boolean(runAs(env)), load: browserLoad(), leftovers: browserLeftovers(env), limits: browserLimits(env), sandbox: sandboxWorks };
}

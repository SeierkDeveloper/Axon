// The wall around an agent's browser.
//
// A browser on a server is a way into that server's network unless something stands between the two. A page can ask
// for anything: the address the agent typed is the least of it, there are redirects, scripts, pictures, frames and
// sockets, and a name that answers with a public address now can answer with a private one a second later. Checking
// the address the agent gave is therefore not enough, and checking it in the browser is too late.
//
// So the browser is given exactly one way out: this guard, a small proxy on this machine. Every connection the
// browser makes arrives here as "connect me to this name and port". The guard looks the name up itself, refuses
// anything that is not a public address on a web port, and connects to the very address it checked. The browser is
// started so that it can resolve no name and reach no address on its own (see ./browserSession), which leaves
// nothing that goes around.
//
// One guard serves one job's browser and is closed with it. It also keeps count: how much the job has pulled down,
// and what was refused, so the agent can be told why a page did not open.

import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import { resolvePublicHost } from "./urlSecurity";
import { BROWSER_PORTS } from "./agentBrowser";

/** A name to the address to connect to, or the reason it is refused. `port` is for tests, which have no port 80. */
export interface Target { address: string; family: 4 | 6; port?: number }
export type Resolve = (host: string) => Promise<Target | string>;

export interface GuardOptions {
  /** the most this job's browser may pull down, in bytes */
  maxBytes: number;
  /** how a name becomes the address to connect to. The default refuses everything that is not public. */
  resolve?: Resolve;
  /** the ports a page may be fetched from */
  ports?: readonly number[];
  /** seconds a connection may sit idle before it is closed */
  idleSeconds?: number;
}

export interface Refused { host: string; port: number; why: string }

export interface Guard {
  /** where the browser is pointed: 127.0.0.1 and the port the guard listens on */
  port: number;
  /** bytes sent to the browser so far */
  bytes(): number;
  /** true once the job has pulled down more than it may; every connection is closed and no new one is made */
  spent(): boolean;
  /** what was refused, newest last */
  refused(): Refused[];
  /** why this host was refused, if it was */
  whyRefused(host: string): string | null;
  close(): Promise<void>;
}

const parseTarget = (raw: string, fallbackPort: number): { host: string; port: number } | null => {
  const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(raw) ?? /^([^:\s/@]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : fallbackPort;
  return Number.isInteger(port) && port > 0 && port < 65536 ? { host: m[1].toLowerCase(), port } : null;
};

/** A host as it is compared and reported: lower case, an IPv6 address without its brackets, no trailing dot. */
const bare = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");

// What the browser sends that is meant for a proxy and must not travel on to the site.
const HOP = new Set(["proxy-connection", "proxy-authorization", "proxy-authenticate", "connection", "keep-alive", "te", "trailer", "upgrade", "transfer-encoding"]);

export async function startGuard(o: GuardOptions): Promise<Guard> {
  const resolve = o.resolve ?? resolvePublicHost, ports = o.ports ?? BROWSER_PORTS, idleMs = (o.idleSeconds ?? 60) * 1000;
  const refused: Refused[] = [], open = new Set<Duplex>();
  let bytes = 0, spent = false, closed = false;

  const note = (host: string, port: number, why: string) => { if (refused.length < 200) refused.push({ host, port, why }); };
  const track = <T extends Duplex>(s: T): T => { open.add(s); s.once("close", () => open.delete(s)); return s; };
  const count = (n: number) => {
    bytes += n;
    if (!spent && bytes > o.maxBytes) { spent = true; for (const s of open) s.destroy(); }
  };

  /** The address this name and port may be connected to, or why not. */
  const allow = async (rawHost: string, port: number): Promise<Target | string> => {
    const host = bare(rawHost);
    if (closed) return "the browser is closed";
    if (spent) return "this job has used up its data";
    if (!ports.includes(port)) { note(host, port, "port"); return "that port is not a web port"; }
    const to = await resolve(host);
    if (typeof to === "string") { note(host, port, to); return to; }
    return to;
  };

  const server = http.createServer((req, res) => {
    // A plain http page: the browser sends the whole address, and the guard fetches it from the address it checked.
    void (async () => {
      let url: URL;
      try { url = new URL(req.url ?? ""); } catch { res.writeHead(400).end(); return; }
      if (url.protocol !== "http:") { res.writeHead(400).end(); return; }
      const port = url.port ? Number(url.port) : 80;
      const to = await allow(url.hostname, port);
      if (typeof to === "string") { res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "x-axon-guard": "refused" }).end(`Not opened: ${to}.`); return; }
      const headers: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v;
      headers.host = url.host;
      headers.connection = "close";
      const out = http.request({ host: to.address, family: to.family, port: to.port ?? port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: idleMs }, (back) => {
        const h = { ...back.headers }; delete h["proxy-authenticate"]; h.connection = "close";
        res.writeHead(back.statusCode ?? 502, back.statusMessage, h);
        back.on("data", (c: Buffer) => count(c.length));
        back.pipe(res);
      });
      track(out as unknown as Duplex);
      out.on("timeout", () => out.destroy());
      out.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(out);
    })().catch(() => { try { res.destroy(); } catch { /* already gone */ } });
  });

  // An https page, and every socket: the browser asks for a tunnel to a name and port.
  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    void (async () => {
      const target = parseTarget(req.url ?? "", 443);
      if (!target) { client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
      const to = await allow(target.host, target.port);
      if (typeof to === "string") { client.end("HTTP/1.1 403 Forbidden\r\nX-Axon-Guard: refused\r\n\r\n"); return; }
      const up = track(net.connect({ host: to.address, family: to.family, port: to.port ?? target.port }));
      up.setTimeout(idleMs, () => up.destroy());
      let linked = false;
      up.once("connect", () => {
        linked = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.on("data", (c: Buffer) => count(c.length));
        up.pipe(client); client.pipe(up);
      });
      up.on("error", () => { if (linked) client.destroy(); else client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); });
      up.once("close", () => client.destroy());
      client.once("close", () => up.destroy());
    })().catch(() => client.destroy());
  });
  server.on("clientError", (_e, socket) => socket.destroy());
  server.on("connection", (s) => track(s));

  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", ok); });
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    bytes: () => bytes,
    spent: () => spent,
    refused: () => [...refused],
    whyRefused: (host) => { const h = bare(host); for (let i = refused.length - 1; i >= 0; i--) if (refused[i].host === h) return refused[i].why; return null; },
    close: () => new Promise<void>((done) => {
      closed = true;
      for (const s of open) s.destroy();
      server.close(() => done());
    }),
  };
}

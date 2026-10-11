// A browser for agents: the switch, the limits and the rules.
//
// An agent that can only read a page's text cannot use most of the web: the page that draws itself with JavaScript,
// the list behind a button, the form. With a browser it opens a site and uses it as a person would. This file is
// what that rests on and nothing else: whether it is on, how much one job may do with it, and what it will never do.
// The browser itself is in ./browserSession, the wall around its network in ./browserGuard.
//
// The rules the whole thing rests on:
//
//   It reaches the public web and nothing else. Every connection the browser makes, whatever asked for it (the
//   address the agent gave, a redirect, a script on the page, a picture), goes through the guard, which connects only
//   to public addresses. This server, the private network around it and the hosting provider's own addresses cannot
//   be reached from a page.
//
//   It signs in nowhere and pays nowhere. It has no accounts and no cards, a password or card field is never typed
//   into, and an address that carries a name and password is refused.
//
//   One job gets its own browser, empty when it starts and thrown away when it ends: no cookies, no history and no
//   saved file passes from one job to the next.
//
//   It cannot run away: a job has a number of steps, an amount of time and an amount of data, and a server only
//   runs a few browsers at once.
//
// AGENT_BROWSER=on switches it on. Off (the default) no agent has a browser and nothing here starts one.

type Env = Record<string, string | undefined>;

export function browserEnabled(env: Env = process.env): boolean {
  return (env.AGENT_BROWSER ?? "off").trim().toLowerCase() === "on";
}

const num = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
};

export interface BrowserLimits {
  /** actions one job may take in its browser: opening a page, a click, typing, a scroll */
  steps: number;
  /** seconds one job's browser may stay open, from the first page to the last */
  seconds: number;
  /** seconds one page may take to load before the agent is told it did not */
  pageSeconds: number;
  /** megabytes one job's browser may download in all, pages and everything on them */
  megabytes: number;
  /** browsers this server runs at the same time; a job that finds them all busy waits its turn */
  atOnce: number;
  /** seconds a job waits for a free browser before it is told there is none */
  waitSeconds: number;
  /** the window the browser draws into */
  width: number;
  height: number;
}

/** What one job may do with its browser. Each number can be set for a deployment; a value out of range is ignored. */
export function browserLimits(env: Env = process.env): BrowserLimits {
  return {
    steps: num(env.AXON_BROWSER_MAX_STEPS, 25, 1, 200),
    seconds: num(env.AXON_BROWSER_MAX_SECONDS, 180, 10, 900),
    pageSeconds: num(env.AXON_BROWSER_PAGE_SECONDS, 25, 3, 120),
    megabytes: num(env.AXON_BROWSER_MAX_MB, 60, 1, 500),
    atOnce: num(env.AXON_BROWSER_AT_ONCE, 2, 1, 8),
    waitSeconds: num(env.AXON_BROWSER_WAIT_SECONDS, 45, 1, 300),
    width: 1280,
    height: 800,
  };
}

/** The ports a page may be fetched from: the web's own two. */
export const BROWSER_PORTS: readonly number[] = [80, 443];

export type UrlRefusal = "not_a_url" | "scheme" | "credentials" | "port" | "host";

const REFUSALS: Record<UrlRefusal, string> = {
  not_a_url: "That is not a web address.",
  scheme: "Only http and https addresses can be opened.",
  credentials: "An address with a name and password in it is not opened. The browser signs in nowhere.",
  port: "Only the usual web ports (80 and 443) can be opened.",
  host: "That address is not on the public web, so it is not opened.",
};

export const refusalText = (r: UrlRefusal): string => REFUSALS[r];

/**
 * May the browser be sent to this address? This looks at the address as written; where the name really leads is
 * decided by the guard at the moment of connecting, for this address and for everything the page then asks for.
 * A bare "example.com" is read as https.
 */
export function checkBrowserUrl(raw: string): { ok: true; url: string } | { ok: false; refused: UrlRefusal; reason: string } {
  const no = (refused: UrlRefusal) => ({ ok: false as const, refused, reason: REFUSALS[refused] });
  const text = String(raw ?? "").trim();
  if (!text || text.length > 2_000 || /\s/.test(text)) return no("not_a_url");
  // "localhost:3000" parses as a scheme called "localhost", so a written scheme is only one that is followed by //
  const written = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try { url = new URL(written); } catch { return no("not_a_url"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return no("scheme");
  if (url.username || url.password) return no("credentials");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!BROWSER_PORTS.includes(port)) return no("port");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host) || (!host.includes(".") && !host.includes(":"))) return no("host");
  return { ok: true, url: url.toString() };
}

/** What is known about a field on a page, as the page itself describes it. */
export interface FieldInfo { type?: string | null; autocomplete?: string | null; name?: string | null; id?: string | null; label?: string | null; placeholder?: string | null }

const PASSWORD = /pass(word|code|phrase)?|pwd|secret|otp|one.?time|2fa|mfa|verification.?code|security.?code|\bpin\b/i;
const CARD = /card.?(number|no|num)|cc.?(num|number|exp|csc|cvc)|\bcvv\b|\bcvc\b|\bcsc\b|\biban\b|account.?number|routing|sort.?code|expir(y|ation)|seed.?phrase|private.?key|mnemonic|recovery.?phrase/i;

/**
 * Why the browser will not type into this field, or null when it may. A field for a password, a one-time code, a
 * card or a bank account is never typed into, whatever the job says: the browser signs in nowhere and pays nowhere.
 * A wallet's secret words are refused for the same reason.
 */
export function fieldRefusal(f: FieldInfo): string | null {
  const type = (f.type ?? "").toLowerCase(), auto = (f.autocomplete ?? "").toLowerCase();
  const words = [f.name, f.id, f.label, f.placeholder].filter(Boolean).join(" ");
  if (type === "password" || /(^|\s)(current-password|new-password|one-time-code)(\s|$)/.test(auto) || PASSWORD.test(words)) {
    return "This is a password or sign-in code field. The browser signs in nowhere, so it does not type here.";
  }
  if (/(^|\s)cc-/.test(auto) || CARD.test(words)) {
    return "This is a payment or secret-key field. The browser pays nowhere and holds no keys, so it does not type here.";
  }
  if (type === "file") return "A file cannot be handed to a page from here.";
  return null;
}

/** The name the browser gives itself to the sites it visits: an ordinary Chrome, and who is driving it. */
export function browserUserAgent(chromeVersion: string, env: Env = process.env): string {
  const v = /^\d+(\.\d+){0,3}$/.test(chromeVersion) ? chromeVersion : "126.0.0.0";
  const who = (env.AXON_BROWSER_AGENT_NAME ?? "AxonAgent/1.0 (+https://axon-agents.com)").replace(/[^\x20-\x7e]/g, "").slice(0, 120);
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36 ${who}`.trim();
}

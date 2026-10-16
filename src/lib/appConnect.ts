// Connecting an app, keeping it connected, and letting go of it.
//
// Signing in is OAuth 2.0's authorization code flow with PKCE (S256):
//
//   start   The signed-in owner asks to connect an app. A state row is kept for ten minutes with a sealed PKCE
//           verifier and the hash of a random value that goes to the owner's browser as a cookie. The state handed to
//           the app is signed (HMAC with a key derived from APP_TOKEN_KEY), says which owner and app it is for, and
//           when it stops being good.
//   finish  The app sends the browser back with a code and the state. The signature, the time, the app, the owner
//           and the browser's cookie must all agree, and the state row is used up on the way. The code is exchanged
//           with the verifier, and what comes back is sealed before anything else happens to it.
//
// A token that is about to stop working is refreshed when it is used. An app that refuses a refresh leaves the
// connection marked as needing to be connected again; nothing is retried in a loop.
//
// Disconnecting removes the tokens here first, then tells the app where it has a way to be told. If the app cannot be
// reached the tokens are gone from Axon all the same, and the owner is told to remove Axon in the app's settings.
//
// No function here logs a token, returns one to a route, or lets one into an error message.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "./db";
import { logger } from "./logger";
import { normalizeAddress } from "./address";
import { appClient, appsEnabled, getApp, listApps, scopesFor, scopeWords, ACTIONS, standardToken, type AppDef, type TokenSet } from "./appRegistry";
import { currentKeyId, keyIdOfSealed, openToken, sealToken, stateSigningKey, tokenKeyReady } from "./appTokens";

type Env = Record<string, string | undefined>;

export const STATE_TTL_MS = 10 * 60_000;
/** A token this close to its end is refreshed before it is used. */
export const REFRESH_EARLY_MS = 60_000;
const HTTP_TIMEOUT_MS = 15_000;
/** Sign-ins one owner may have open at once. */
const MAX_OPEN_STATES = 10;

export class AppError extends Error {
  /** a short word for where the owner is sent back to: expired, browser, soon, failed */
  constructor(message: string, public status: number, public reason: "expired" | "browser" | "soon" | "failed" = "failed") {
    super(message);
    this.name = "AppError";
  }
}

export interface Connection {
  connectionId: string;
  ownerWallet: string;
  appId: string;
  accountLabel: string | null;
  scopes: string[];
  expiresAt: string | null;
  needsReconnect: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ConnectionRow {
  connection_id: string;
  owner_wallet: string;
  app_id: string;
  account_label: string | null;
  scopes: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  key_id: string | null;
  expires_at: string | null;
  needs_reconnect: number;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// The only way a row leaves this file: named fields, never the sealed ones.
const toConnection = (r: ConnectionRow): Connection => ({
  connectionId: r.connection_id,
  ownerWallet: r.owner_wallet,
  appId: r.app_id,
  accountLabel: r.account_label,
  scopes: r.scopes ? r.scopes.split(" ").filter(Boolean) : [],
  expiresAt: r.expires_at,
  needsReconnect: r.needs_reconnect === 1,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

const owner = (wallet: string): string => {
  const w = normalizeAddress(wallet);
  if (!w) throw new AppError("That is not a wallet address.", 400);
  return w.toLowerCase();
};
const b64url = (buf: Buffer): string => buf.toString("base64url");
const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();
const iso = (ms: number): string => new Date(ms).toISOString();

/** An app can be started when it exists, Axon has a client at it, and there is a key to seal its tokens with. */
export function appAvailable(app: AppDef, env: Env = process.env): boolean {
  return appClient(app, env) !== null && tokenKeyReady(env);
}

function liveRow(ownerWallet: string, appId: string): ConnectionRow | null {
  return (getDb().prepare("SELECT * FROM app_connections WHERE owner_wallet = ? AND app_id = ? AND revoked_at IS NULL").get(owner(ownerWallet), appId) as ConnectionRow | undefined) ?? null;
}

export function getConnection(ownerWallet: string, appId: string): Connection | null {
  const r = liveRow(ownerWallet, appId);
  return r ? toConnection(r) : null;
}

export function listConnections(ownerWallet: string): Connection[] {
  return (getDb().prepare("SELECT * FROM app_connections WHERE owner_wallet = ? AND revoked_at IS NULL ORDER BY created_at").all(owner(ownerWallet)) as ConnectionRow[]).map(toConnection);
}

// ── The signed state ─────────────────────────────────────────────────────────

interface StatePayload { s: string; o: string; a: string; e: number }

export function signState(p: StatePayload, env: Env = process.env): string {
  const body = b64url(Buffer.from(JSON.stringify(p), "utf8"));
  const mac = b64url(createHmac("sha256", stateSigningKey(env)).update(body).digest());
  return `${body}.${mac}`;
}

/** The state's contents when its signature holds and it has not run out; null otherwise. */
export function readState(token: string, now = Date.now(), env: Env = process.env): StatePayload | null {
  const [body, mac, more] = String(token ?? "").split(".");
  if (!body || !mac || more !== undefined) return null;
  const want = createHmac("sha256", stateSigningKey(env)).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    if (typeof p.s !== "string" || typeof p.o !== "string" || typeof p.a !== "string" || typeof p.e !== "number") return null;
    return p.e > now ? p : null;
  } catch {
    return null;
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

/** The cookie that ties a sign-in to the browser that started it. One per app, so two tabs do not trip each other. */
export const browserCookieName = (appId: string): string => `axon_app_${appId.replace(/[^a-z0-9]/gi, "")}`;

export interface Started {
  /** where to send the owner's browser */
  url: string;
  /** the value of the browser cookie; httpOnly, for the callback path, ten minutes */
  browser: string;
  expiresAt: string;
}

export function startConnect(opts: { ownerWallet: string; appId: string; redirectUri: string; now?: number; env?: Env }): Started {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const app = getApp(opts.appId);
  if (!app) throw new AppError("There is no such app.", 404);
  const client = appClient(app, env);
  if (!client || !tokenKeyReady(env)) throw new AppError(`${app.name} is coming soon.`, 409);
  const who = owner(opts.ownerWallet);
  const db = getDb();
  db.prepare("DELETE FROM app_oauth_states WHERE expires_at <= ?").run(iso(now));
  const open = (db.prepare("SELECT COUNT(*) AS n FROM app_oauth_states WHERE owner_wallet = ?").get(who) as { n: number }).n;
  if (open >= MAX_OPEN_STATES) throw new AppError("Too many sign-ins started at once. Finish one or wait ten minutes.", 429);

  const stateId = b64url(randomBytes(18));
  const verifier = b64url(randomBytes(32));
  const browser = b64url(randomBytes(24));
  const expires = now + STATE_TTL_MS;
  db.prepare("INSERT INTO app_oauth_states (state_id, owner_wallet, app_id, verifier_enc, browser_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    stateId, who, app.id, sealToken(verifier, `state:${stateId}`, env).sealed, sha256(browser).toString("hex"), iso(now), iso(expires),
  );

  const url = new URL(app.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  const scopes = scopesFor(app);
  if (scopes.length) url.searchParams.set(app.scopeParam, scopes.join(app.scopeSeparator));
  url.searchParams.set("state", signState({ s: stateId, o: who, a: app.id, e: expires }, env));
  if (app.pkce) {
    url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(app.authorizeParams ?? {})) url.searchParams.set(k, v);
  return { url: url.toString(), browser, expiresAt: iso(expires) };
}

// ── Talking to an app's token endpoint ───────────────────────────────────────

/** A short, safe reason from an app's error answer: its `error` code if it looks like one, never the body. */
const reasonOf = (body: Record<string, unknown>): string => {
  const e = typeof body.error === "string" ? body.error : "";
  return /^[a-z0-9_.-]{1,64}$/i.test(e) ? e : "refused";
};

async function tokenRequest(app: AppDef, client: { clientId: string; clientSecret: string }, params: Record<string, string>): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const fields: Record<string, string> = { ...params };
  const headers: Record<string, string> = { Accept: "application/json" };
  if (app.tokenAuth === "basic") headers.Authorization = `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`;
  else Object.assign(fields, { client_id: client.clientId, client_secret: client.clientSecret });
  let body: string;
  if (app.tokenBody === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(fields);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(fields).toString();
  }
  let res: Response;
  try {
    res = await fetch(app.tokenUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });
  } catch {
    throw new AppError(`${app.name} could not be reached. Try again in a minute.`, 502);
  }
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, status: res.status, body: parsed && typeof parsed === "object" ? parsed : {} };
}

async function accountLabel(app: AppDef, tokens: TokenSet): Promise<string | null> {
  if (tokens.label) return tokens.label.slice(0, 120);
  if (!app.userinfo) return null;
  try {
    const res = await fetch(app.userinfo.url, {
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json", "User-Agent": "Axon" },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) return null;
    const label = app.userinfo.label(((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>);
    return label ? label.slice(0, 120) : null;
  } catch {
    return null;
  }
}

// ── Finish ───────────────────────────────────────────────────────────────────

interface StateRow { state_id: string; owner_wallet: string; app_id: string; verifier_enc: string; browser_hash: string; expires_at: string }

export async function finishConnect(opts: { appId: string; code: string; state: string; browser: string | null | undefined; redirectUri: string; now?: number; env?: Env }): Promise<Connection> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const app = getApp(opts.appId);
  if (!app) throw new AppError("There is no such app.", 404);
  const client = appClient(app, env);
  if (!client || !tokenKeyReady(env)) throw new AppError(`${app.name} is coming soon.`, 409, "soon");

  const p = readState(opts.state, now, env);
  if (!p || p.a !== app.id) throw new AppError("This sign-in has run out or is not one Axon started. Start again from your dashboard.", 400, "expired");
  // used up whatever happens next: a state works once
  const row = getDb().prepare("DELETE FROM app_oauth_states WHERE state_id = ? RETURNING *").get(p.s) as StateRow | undefined;
  if (!row || row.app_id !== app.id || row.owner_wallet !== p.o || row.expires_at <= iso(now)) {
    throw new AppError("This sign-in has run out or was already used. Start again from your dashboard.", 400, "expired");
  }
  const want = Buffer.from(row.browser_hash, "hex");
  const got = sha256(String(opts.browser ?? ""));
  if (!opts.browser || want.length !== got.length || !timingSafeEqual(want, got)) {
    throw new AppError("This sign-in was started in another browser. Start it again from your dashboard in this one.", 400, "browser");
  }
  if (!opts.code || opts.code.length > 2048) throw new AppError(`${app.name} did not send a code back.`, 400);

  const verifier = openToken(row.verifier_enc, `state:${row.state_id}`, env);
  const answer = await tokenRequest(app, client, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    ...(app.pkce ? { code_verifier: verifier } : {}),
  });
  const tokens = answer.ok ? app.parseToken(answer.body) : null;
  if (!tokens) throw new AppError(`${app.name} did not hand back a way in (${answer.ok ? "no token" : reasonOf(answer.body)}). Try connecting again.`, 502);

  const label = await accountLabel(app, tokens);
  return saveConnection(row.owner_wallet, app, tokens, label, now, env);
}

function saveConnection(ownerWallet: string, app: AppDef, tokens: TokenSet, label: string | null, now: number, env: Env): Connection {
  const db = getDb();
  const id = `appc_${randomUUID()}`;
  const access = sealToken(tokens.accessToken, `${id}:access`, env);
  const refresh = tokens.refreshToken ? sealToken(tokens.refreshToken, `${id}:refresh`, env).sealed : null;
  const scopes = (tokens.scopes ?? scopesFor(app)).join(" ");
  db.transaction(() => {
    // connecting again replaces the old connection here; the app itself is not told, since for some apps that would
    // withdraw the grant the new connection rests on
    db.prepare("UPDATE app_connections SET access_token_enc = NULL, refresh_token_enc = NULL, revoked_at = ?, updated_at = ? WHERE owner_wallet = ? AND app_id = ? AND revoked_at IS NULL").run(iso(now), iso(now), ownerWallet, app.id);
    db.prepare(
      `INSERT INTO app_connections (connection_id, owner_wallet, app_id, account_label, scopes, access_token_enc, refresh_token_enc, key_id, expires_at, needs_reconnect, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(id, ownerWallet, app.id, label, scopes, access.sealed, refresh, access.keyId, tokens.expiresIn ? iso(now + tokens.expiresIn * 1000) : null, iso(now), iso(now));
  })();
  logger.info("apps.connected", "An app was connected", { app: app.id, connectionId: id });
  return toConnection(db.prepare("SELECT * FROM app_connections WHERE connection_id = ?").get(id) as ConnectionRow);
}

// ── Using a connection ───────────────────────────────────────────────────────

const refreshing = new Map<string, Promise<void>>();

async function refreshConnection(row: ConnectionRow, app: AppDef, env: Env, now: number): Promise<void> {
  const client = appClient(app, env);
  if (!row.refresh_token_enc || !client) {
    markReconnect(row.connection_id, now);
    throw new AppError(`${app.name} needs to be connected again.`, 409);
  }
  const refreshToken = openToken(row.refresh_token_enc, `${row.connection_id}:refresh`, env);
  const answer = await tokenRequest(app, client, { grant_type: "refresh_token", refresh_token: refreshToken });
  const tokens = answer.ok ? (app.parseToken(answer.body) ?? standardToken(answer.body)) : null;
  if (!tokens) {
    // the app said no (a withdrawn grant, an expired refresh token): only connecting again helps. A server error or a
    // timeout is not a no, so the connection is left as it was for the next try.
    if (answer.status >= 400 && answer.status < 500) markReconnect(row.connection_id, now);
    throw new AppError(`${app.name} did not renew the connection (${answer.ok ? "no token" : reasonOf(answer.body)}).`, answer.status >= 500 ? 502 : 409);
  }
  const access = sealToken(tokens.accessToken, `${row.connection_id}:access`, env);
  // an app that does not send a new refresh token keeps the old one working; sealed again under the current key
  const refresh = sealToken(tokens.refreshToken ?? refreshToken, `${row.connection_id}:refresh`, env).sealed;
  getDb()
    .prepare("UPDATE app_connections SET access_token_enc = ?, refresh_token_enc = ?, key_id = ?, expires_at = ?, needs_reconnect = 0, updated_at = ? WHERE connection_id = ? AND revoked_at IS NULL")
    .run(access.sealed, refresh, access.keyId, tokens.expiresIn ? iso(now + tokens.expiresIn * 1000) : null, iso(now), row.connection_id);
  logger.info("apps.refreshed", "An app connection was renewed", { app: app.id, connectionId: row.connection_id });
}

function markReconnect(connectionId: string, now: number): void {
  getDb().prepare("UPDATE app_connections SET needs_reconnect = 1, updated_at = ? WHERE connection_id = ?").run(iso(now), connectionId);
}

/** Seal a row's tokens again under the current key, when an older one sealed them. */
function reseal(row: ConnectionRow, env: Env): void {
  const current = currentKeyId(env);
  if (!current || !row.access_token_enc) return;
  const stale = [row.access_token_enc, row.refresh_token_enc].some((s) => s && keyIdOfSealed(s) !== current);
  if (!stale) return;
  const access = sealToken(openToken(row.access_token_enc, `${row.connection_id}:access`, env), `${row.connection_id}:access`, env);
  const refresh = row.refresh_token_enc ? sealToken(openToken(row.refresh_token_enc, `${row.connection_id}:refresh`, env), `${row.connection_id}:refresh`, env).sealed : null;
  getDb().prepare("UPDATE app_connections SET access_token_enc = ?, refresh_token_enc = ?, key_id = ? WHERE connection_id = ? AND revoked_at IS NULL").run(access.sealed, refresh, access.keyId, row.connection_id);
}

/** Seal every live connection again under the current key. Returns how many were moved. */
export function resealAll(env: Env = process.env): number {
  const current = currentKeyId(env);
  if (!current) return 0;
  const rows = getDb().prepare("SELECT * FROM app_connections WHERE revoked_at IS NULL AND access_token_enc IS NOT NULL AND (key_id IS NULL OR key_id != ?)").all(current) as ConnectionRow[];
  for (const r of rows) reseal(r, env);
  return rows.length;
}

/** Cut a token out of a message, wherever it appears. */
const without = (text: string, secret: string): string => (secret.length >= 4 ? text.split(secret).join("[REDACTED:app-token]") : text);

/**
 * Run `fn` with the owner's access token for an app. The token is opened here, handed to `fn`, and goes nowhere else:
 * it is not returned, not logged, and cut out of any error `fn` throws. A token about to run out is renewed first.
 */
export async function withAppToken<T>(ownerWallet: string, appId: string, fn: (accessToken: string) => Promise<T> | T, opts: { env?: Env; now?: number } = {}): Promise<T> {
  const env = opts.env ?? process.env;
  if (!appsEnabled(env)) throw new AppError("Apps are not switched on here.", 404);
  const app = getApp(appId);
  if (!app) throw new AppError("There is no such app.", 404);
  let row = liveRow(ownerWallet, app.id);
  if (!row || !row.access_token_enc) throw new AppError(`${app.name} is not connected.`, 409);
  if (row.needs_reconnect === 1) throw new AppError(`${app.name} needs to be connected again.`, 409);

  const now = opts.now ?? Date.now();
  if (row.expires_at && Date.parse(row.expires_at) - now < REFRESH_EARLY_MS) {
    // one renewal at a time for a connection; whoever comes while it runs waits for it
    const id = row.connection_id;
    let pending = refreshing.get(id);
    if (!pending) {
      pending = refreshConnection(row, app, env, now).finally(() => refreshing.delete(id));
      refreshing.set(id, pending);
    }
    await pending;
    row = liveRow(ownerWallet, app.id);
    if (!row || !row.access_token_enc) throw new AppError(`${app.name} is not connected.`, 409);
  } else {
    reseal(row, env);
    row = liveRow(ownerWallet, app.id) ?? row;
  }

  const token = openToken(row.access_token_enc!, `${row.connection_id}:access`, env);
  getDb().prepare("UPDATE app_connections SET last_used_at = ? WHERE connection_id = ?").run(iso(now), row.connection_id);
  try {
    return await fn(token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const clean = without(message, token);
    if (err instanceof Error && clean === message) throw err;
    throw new AppError(clean, err instanceof AppError ? err.status : 502);
  }
}

// ── Disconnect ───────────────────────────────────────────────────────────────

async function tellApp(app: AppDef, client: { clientId: string; clientSecret: string } | null, token: string): Promise<boolean> {
  if (!app.revoke) return false;
  const basic = client ? `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}` : null;
  let req: { url: string; init: RequestInit };
  switch (app.revoke.style) {
    case "github":
      if (!client || !basic) return false;
      req = { url: app.revoke.url.replace("{client_id}", encodeURIComponent(client.clientId)), init: { method: "DELETE", headers: { Authorization: basic, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "Axon" }, body: JSON.stringify({ access_token: token }) } };
      break;
    case "slack":
      req = { url: app.revoke.url, init: { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "" } };
      break;
    case "notion":
      if (!basic) return false;
      req = { url: app.revoke.url, init: { method: "POST", headers: { Authorization: basic, "Content-Type": "application/json" }, body: JSON.stringify({ token }) } };
      break;
    default:
      req = {
        url: app.revoke.url,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...(basic ? { Authorization: basic } : {}) },
          body: new URLSearchParams({ token }).toString(),
        },
      };
  }
  try {
    const res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), redirect: "error" });
    if (!res.ok) return false;
    if (app.revoke.style === "slack") return ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok === true;
    return true;
  } catch {
    return false;
  }
}

/**
 * Disconnect an app: its tokens are removed here at once, what was waiting to go out to it is cancelled, and then the
 * app is told where it can be. `appTold` says whether that last part worked.
 */
export async function disconnect(ownerWallet: string, appId: string, opts: { env?: Env; now?: number } = {}): Promise<{ appTold: boolean; appHasRevoke: boolean }> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const app = getApp(appId);
  if (!app) throw new AppError("There is no such app.", 404);
  const row = liveRow(ownerWallet, app.id);
  if (!row) throw new AppError(`${app.name} is not connected.`, 404);

  // open what is needed to tell the app before the row loses it; a token that cannot be opened is still removed
  let token: string | null = null;
  try {
    if (row.access_token_enc) token = openToken(row.access_token_enc, `${row.connection_id}:access`, env);
  } catch {
    token = null;
  }
  const db = getDb();
  db.prepare("UPDATE app_connections SET access_token_enc = NULL, refresh_token_enc = NULL, revoked_at = ?, updated_at = ? WHERE connection_id = ?").run(iso(now), iso(now), row.connection_id);
  // anything waiting to go out through this app cannot go now
  const { cancelForApp } = await import("./appPermissions");
  cancelForApp(row.owner_wallet, app.id, now);
  const appTold = token ? await tellApp(app, appClient(app, env), token) : false;
  logger.info("apps.disconnected", "An app was disconnected", { app: app.id, connectionId: row.connection_id, appTold });
  return { appTold, appHasRevoke: app.revoke !== null };
}

// ── What the dashboard shows ─────────────────────────────────────────────────

export interface AppView {
  appId: string;
  name: string;
  blurb: string;
  available: boolean;
  actions: { action: string; label: string }[];
  /** what connecting asks the app for, in plain words */
  asks: string[];
  connection: (Omit<Connection, "ownerWallet" | "scopes"> & { scopes: string[] }) | null;
}

export function appsFor(ownerWallet: string, env: Env = process.env): AppView[] {
  const mine = new Map(listConnections(ownerWallet).map((c) => [c.appId, c]));
  return listApps().map((app) => {
    const c = mine.get(String(app.id));
    return {
      appId: String(app.id),
      name: app.name,
      blurb: app.blurb,
      available: appAvailable(app, env),
      actions: ACTIONS.map((a) => ({ action: a, label: app.actions[a].label })),
      asks: scopeWords(app, scopesFor(app)),
      connection: c
        ? { connectionId: c.connectionId, appId: c.appId, accountLabel: c.accountLabel, scopes: scopeWords(app, c.scopes), expiresAt: c.expiresAt, needsReconnect: c.needsReconnect, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt }
        : null,
    };
  });
}

/** Remove sign-ins that were started and never finished. */
export function purgeStates(now = Date.now()): number {
  return getDb().prepare("DELETE FROM app_oauth_states WHERE expires_at <= ?").run(iso(now)).changes;
}

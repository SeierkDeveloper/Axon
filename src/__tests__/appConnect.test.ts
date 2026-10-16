// Connecting an app, end to end, against a fake OAuth provider: a real HTTP server on this machine that plays the
// app's sign-in page, token endpoint, account endpoint and revoke endpoint. No real app is ever reached.
//
// What is held: PKCE is sent and checked, the state is signed, used once, bound to the owner and to the browser, the
// token is sealed at rest and refreshed when it runs out, disconnecting removes it here and tells the app, and no
// token ever comes back from a route or reaches a log line, an error log row or a receipt.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import { addAppForTests, standardToken, listApps, getApp, appClient, type AppDef } from "@/lib/appRegistry";
import { withAppToken, getConnection, disconnect, resealAll, signState, readState, startConnect, AppError } from "@/lib/appConnect";
import { canDo } from "@/lib/appPermissions";
import { GET as appsRoute } from "@/app/api/apps/route";
import { POST as connectRoute } from "@/app/api/apps/[appId]/connect/route";
import { GET as callbackRoute } from "@/app/api/apps/[appId]/callback/route";
import { DELETE as disconnectRoute } from "@/app/api/apps/[appId]/route";

const PORT = 3731;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:3730";
const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

// ── the fake provider ────────────────────────────────────────────────────────
const fake = {
  codes: new Map<string, { challenge: string; redirect: string; used: boolean }>(),
  live: new Set<string>(),
  refresh: new Set<string>(),
  revoked: [] as string[],
  grants: [] as string[],
  refuseRefresh: false,
  expiresIn: 3600,
  lastAuthorize: null as URLSearchParams | null,
  issued: [] as string[],
};
const tokenOf = (prefix: string) => {
  const t = `${prefix}_${randomBytes(18).toString("hex")}`;
  fake.issued.push(t);
  return t;
};
const b64url = (b: Buffer) => b.toString("base64url");
let server: http.Server;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => resolve(s)); });
}
const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", BASE);
    if (url.pathname === "/authorize") {
      fake.lastAuthorize = url.searchParams;
      const redirect = url.searchParams.get("redirect_uri")!;
      if (url.searchParams.get("client_id") !== "fake-client") return json(res, 400, { error: "bad_client" });
      const code = b64url(randomBytes(12));
      fake.codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirect, used: false });
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${encodeURIComponent(url.searchParams.get("state") ?? "")}` });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const p = new URLSearchParams(await readBody(req));
      if (p.get("client_id") !== "fake-client" || p.get("client_secret") !== "fake-secret") return json(res, 401, { error: "invalid_client" });
      fake.grants.push(p.get("grant_type") ?? "");
      if (p.get("grant_type") === "authorization_code") {
        const c = fake.codes.get(p.get("code") ?? "");
        if (!c || c.used || c.redirect !== p.get("redirect_uri")) return json(res, 400, { error: "invalid_grant" });
        const challenge = b64url(createHash("sha256").update(p.get("code_verifier") ?? "").digest());
        if (challenge !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        c.used = true;
        const at = tokenOf("fakeAT"), rt = tokenOf("fakeRT");
        fake.live.add(at); fake.refresh.add(rt);
        return json(res, 200, { access_token: at, refresh_token: rt, expires_in: fake.expiresIn, scope: "read write" });
      }
      if (p.get("grant_type") === "refresh_token") {
        const rt = p.get("refresh_token") ?? "";
        if (fake.refuseRefresh || !fake.refresh.has(rt)) return json(res, 400, { error: "invalid_grant", error_description: `refresh token ${rt} is not good` });
        const at = tokenOf("fakeAT");
        fake.live.add(at);
        return json(res, 200, { access_token: at, expires_in: fake.expiresIn });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/userinfo") {
      const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      return fake.live.has(t) ? json(res, 200, { email: "owner@fake.test" }) : json(res, 401, { error: "invalid_token" });
    }
    if (url.pathname === "/revoke" && req.method === "POST") {
      const t = new URLSearchParams(await readBody(req)).get("token") ?? "";
      fake.revoked.push(t);
      fake.live.delete(t);
      return json(res, 200, {});
    }
    if (url.pathname === "/api/thing") {
      const t = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      return fake.live.has(t) ? json(res, 200, { ok: true }) : json(res, 401, { error: "invalid_token" });
    }
    json(res, 404, {});
  });
  await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", () => r()));
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const FAKE: AppDef = {
  id: "fake",
  name: "Fake App",
  blurb: "A stand-in for tests.",
  authorizeUrl: `${BASE}/authorize`,
  tokenUrl: `${BASE}/token`,
  scopeSeparator: " ",
  scopeParam: "scope",
  tokenAuth: "body",
  tokenBody: "form",
  pkce: true,
  actions: { read: { label: "Read", scopes: ["read"] }, draft: { label: "Draft", scopes: ["write"] }, publish: { label: "Publish", scopes: ["write"] } },
  baseScopes: [],
  scopeWords: { read: "Read your things", write: "Write your things" },
  revoke: { style: "rfc7009", url: `${BASE}/revoke` },
  userinfo: { url: `${BASE}/userinfo`, label: (b) => (typeof b.email === "string" ? b.email : null) },
  parseToken: standardToken,
  env: { clientId: "FAKE_APP_CLIENT_ID", clientSecret: "FAKE_APP_CLIENT_SECRET" },
};

// ── everything written anywhere, to look for tokens in ───────────────────────
let written: string[] = [];
const spies: ReturnType<typeof vi.spyOn>[] = [];
const saved = { ...process.env };
let removeFake: () => void = () => {};
let n = 0;
const wallet = () => `0x${(++n + 7_100_000).toString(16).padStart(40, "0")}`;

beforeEach(() => {
  Object.assign(process.env, { AGENT_APPS: "on", APP_TOKEN_KEY: KEY_A, FAKE_APP_CLIENT_ID: "fake-client", FAKE_APP_CLIENT_SECRET: "fake-secret", LOG_LEVEL: "info" });
  delete process.env.APP_TOKEN_KEYS_OLD;
  getDb().exec("DELETE FROM app_connections; DELETE FROM app_oauth_states; DELETE FROM app_permissions; DELETE FROM app_approvals; DELETE FROM rate_limit_windows; DELETE FROM api_keys;");
  removeFake = addAppForTests(FAKE);
  Object.assign(fake, { refuseRefresh: false, expiresIn: 3600, revoked: [], grants: [], lastAuthorize: null });
  written = [];
  for (const m of ["log", "warn", "error", "info"] as const) spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { written.push(args.map(String).join(" ")); }));
});
afterEach(() => {
  removeFake();
  while (spies.length) spies.pop()!.mockRestore();
  // after every test: no token the fake app issued is in anything written to the console
  for (const t of fake.issued) expect(written.join("\n")).not.toContain(t);
});
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const req = (path: string, init: { method?: string; key?: string; cookie?: string; body?: unknown } = {}) =>
  new NextRequest(new URL(path, ORIGIN), {
    method: init.method ?? "GET",
    headers: { host: "localhost:3730", ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

/** Sign in as a new owner and connect the fake app all the way. */
async function connectFake(owner = wallet()) {
  const { apiKey } = createApiKey(owner);
  const started = await connectRoute(req("/api/apps/fake/connect", { method: "POST", key: apiKey }), params({ appId: "fake" }));
  expect(started.status).toBe(200);
  const { url } = (await started.json()) as { url: string };
  const cookie = started.cookies.get("axon_app_fake")!;
  // the browser goes to the app, and the app sends it back
  const atApp = await fetch(url, { redirect: "manual" });
  expect(atApp.status).toBe(302);
  const back = new URL(atApp.headers.get("location")!);
  const done = await callbackRoute(req(`${back.pathname}${back.search}`, { cookie: `axon_app_fake=${cookie.value}` }), params({ appId: "fake" }));
  return { owner, apiKey, url, back, cookie, done };
}

function everythingStored(): string {
  const db = getDb();
  const dump = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return [dump("SELECT * FROM app_connections"), dump("SELECT * FROM app_oauth_states"), dump("SELECT * FROM error_log"), dump("SELECT * FROM trace_events")].join("\n");
}
const noTokenIn = (text: string) => { for (const t of fake.issued) expect(text).not.toContain(t); };

describe("the five apps", () => {
  it("are GitHub, Notion, Slack, Google Docs and Gmail, each with its own client id and secret names", () => {
    const real = listApps().filter((a) => a.id !== "fake");
    expect(real.map((a) => a.id)).toEqual(["github", "notion", "slack", "gdocs", "gmail"]);
    expect(real.map((a) => a.env)).toEqual([
      { clientId: "GITHUB_APP_CLIENT_ID", clientSecret: "GITHUB_APP_CLIENT_SECRET" },
      { clientId: "NOTION_APP_CLIENT_ID", clientSecret: "NOTION_APP_CLIENT_SECRET" },
      { clientId: "SLACK_APP_CLIENT_ID", clientSecret: "SLACK_APP_CLIENT_SECRET" },
      { clientId: "GOOGLE_APP_CLIENT_ID", clientSecret: "GOOGLE_APP_CLIENT_SECRET" },
      { clientId: "GOOGLE_APP_CLIENT_ID", clientSecret: "GOOGLE_APP_CLIENT_SECRET" },
    ]);
    for (const a of real) {
      expect(a.authorizeUrl).toMatch(/^https:\/\//);
      expect(a.tokenUrl).toMatch(/^https:\/\//);
      expect(appClient(a, {})).toBeNull();
    }
  });

  it("show as coming soon with no client configured, and cannot be started", async () => {
    const { apiKey } = createApiKey(wallet());
    const res = await appsRoute(req("/api/apps", { key: apiKey }));
    const body = (await res.json()) as { apps: { appId: string; available: boolean; connection: unknown; callbackUrl: string }[]; defaults: string[] };
    const real = body.apps.filter((a) => a.appId !== "fake");
    expect(real).toHaveLength(5);
    expect(real.every((a) => !a.available && a.connection === null)).toBe(true);
    expect(body.apps.find((a) => a.appId === "github")!.callbackUrl).toBe(`${ORIGIN}/api/apps/github/callback`);
    expect(body.defaults).toEqual(["read", "draft"]);
    const start = await connectRoute(req("/api/apps/github/connect", { method: "POST", key: apiKey }), params({ appId: "github" }));
    expect(start.status).toBe(409);
    expect(((await start.json()) as { error: string }).error).toMatch(/coming soon/);
  });

  it("are not available without a key to seal tokens with, even with a client", async () => {
    delete process.env.APP_TOKEN_KEY;
    const { apiKey } = createApiKey(wallet());
    const body = (await (await appsRoute(req("/api/apps", { key: apiKey }))).json()) as { apps: { appId: string; available: boolean }[] };
    expect(body.apps.find((a) => a.appId === "fake")!.available).toBe(false);
    process.env.APP_TOKEN_KEY = "dG9vIHNob3J0"; // not 32 bytes
    const again = (await (await appsRoute(req("/api/apps", { key: apiKey }))).json()) as { apps: { appId: string; available: boolean }[] };
    expect(again.apps.find((a) => a.appId === "fake")!.available).toBe(false);
  });

  it("answer as if they did not exist while the switch is off", async () => {
    process.env.AGENT_APPS = "off";
    const { apiKey } = createApiKey(wallet());
    expect((await appsRoute(req("/api/apps", { key: apiKey }))).status).toBe(404);
    expect((await connectRoute(req("/api/apps/fake/connect", { method: "POST", key: apiKey }), params({ appId: "fake" }))).status).toBe(404);
    expect((await callbackRoute(req("/api/apps/fake/callback?code=x&state=y"), params({ appId: "fake" }))).status).toBe(404);
    expect((await disconnectRoute(req("/api/apps/fake", { method: "DELETE", key: apiKey }), params({ appId: "fake" }))).status).toBe(404);
    await expect(withAppToken("0x" + "1".repeat(40), "fake", () => "x")).rejects.toThrow(/not switched on/);
  });

  it("need a signed-in owner to start", async () => {
    expect((await connectRoute(req("/api/apps/fake/connect", { method: "POST" }), params({ appId: "fake" }))).status).toBe(401);
    expect((await appsRoute(req("/api/apps"))).status).toBe(401);
  });
});

describe("connecting, end to end", () => {
  it("sends the owner to the app with PKCE and a signed state, and comes back connected", async () => {
    const { owner, apiKey, url, cookie, done } = await connectFake();
    const sent = new URL(url);
    expect(sent.origin + sent.pathname).toBe(`${BASE}/authorize`);
    expect(sent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(sent.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/apps/fake/callback`);
    expect(sent.searchParams.get("scope")).toBe("read write");
    expect(sent.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // the browser cookie: httpOnly, only for the callback, ten minutes
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.path).toBe("/api/apps/fake/callback");
    expect(cookie.maxAge).toBe(600);
    expect(String(cookie.sameSite).toLowerCase()).toBe("lax");

    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/dashboard?app=fake&apps=connected#apps`);
    const c = getConnection(owner, "fake")!;
    expect(c).toMatchObject({ appId: "fake", accountLabel: "owner@fake.test", scopes: ["read", "write"], needsReconnect: false });
    // the state was used up
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM app_oauth_states").get()).toEqual({ n: 0 });

    // the dashboard sees the connection, in plain words, and no token
    const view = await appsRoute(req("/api/apps", { key: apiKey }));
    const text = await view.text();
    const body = JSON.parse(text) as { apps: { appId: string; available: boolean; connection: { accountLabel: string; scopes: string[] } | null }[] };
    const mine = body.apps.find((a) => a.appId === "fake")!;
    expect(mine.available).toBe(true);
    expect(mine.connection).toMatchObject({ accountLabel: "owner@fake.test", scopes: ["Read your things", "Write your things"] });
    noTokenIn(text);
    expect(text).not.toMatch(/fake-secret|token_enc|sealed|v1:/);
  });

  it("keeps the token sealed at rest, never in the clear", async () => {
    const { owner } = await connectFake();
    const row = getDb().prepare("SELECT * FROM app_connections WHERE owner_wallet = ?").get(owner.toLowerCase()) as { access_token_enc: string; refresh_token_enc: string; key_id: string };
    expect(row.access_token_enc).toMatch(/^v1:[0-9a-f]{12}:/);
    expect(row.refresh_token_enc).toMatch(/^v1:[0-9a-f]{12}:/);
    noTokenIn(everythingStored());
  });

  it("lets the token out only inside withAppToken, which works against the app", async () => {
    const { owner } = await connectFake();
    const got = await withAppToken(owner, "fake", async (token) => {
      expect(fake.live.has(token)).toBe(true);
      const r = await fetch(`${BASE}/api/thing`, { headers: { authorization: `Bearer ${token}` } });
      return r.status;
    });
    expect(got).toBe(200);
    expect(getConnection(owner, "fake")!.lastUsedAt).not.toBeNull();
  });

  it("cuts the token out of an error thrown inside withAppToken", async () => {
    const { owner } = await connectFake();
    let seen = "";
    const err = await withAppToken(owner, "fake", (token) => { seen = token; throw new Error(`the app said no to ${token} today`); }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as Error).message).toBe("the app said no to [REDACTED:app-token] today");
    expect((err as Error).message).not.toContain(seen);
  });

  it("renews a token that is about to run out, and uses the new one", async () => {
    fake.expiresIn = 30; // less than the minute early it is renewed
    const { owner } = await connectFake();
    const original = fake.issued.at(-2)!; // the access token of the sign-in (the refresh token came after it)
    fake.expiresIn = 3600;
    let first = "";
    await withAppToken(owner, "fake", (t) => { first = t; });
    expect(fake.grants).toContain("refresh_token");
    expect(first).not.toBe(original);
    expect(fake.live.has(first)).toBe(true);
    let second = "";
    await withAppToken(owner, "fake", (t) => { second = t; });
    expect(second).toBe(first); // renewed once, then good for an hour
    expect(fake.grants.filter((g) => g === "refresh_token")).toHaveLength(1);
    noTokenIn(everythingStored());
  });

  it("renews once when two calls want a renewed token at the same moment", async () => {
    const { owner } = await connectFake();
    const later = Date.now() + 2 * 3600_000;
    const tokens = await Promise.all([withAppToken(owner, "fake", (t) => t, { now: later }), withAppToken(owner, "fake", (t) => t, { now: later })]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(fake.grants.filter((g) => g === "refresh_token")).toHaveLength(1);
  });

  it("marks a connection the app will not renew as needing to be connected again", async () => {
    const { owner } = await connectFake();
    fake.refuseRefresh = true;
    await expect(withAppToken(owner, "fake", (t) => t, { now: Date.now() + 2 * 3600_000 })).rejects.toThrow(/did not renew the connection \(invalid_grant\)/);
    expect(getConnection(owner, "fake")!.needsReconnect).toBe(true);
    expect(canDo(owner, "any-agent", "fake", "read")).toBe(false);
    await expect(withAppToken(owner, "fake", (t) => t)).rejects.toThrow(/connected again/);
    // the app's error said the refresh token out loud; none of it reached a log
    noTokenIn(written.join("\n"));
    noTokenIn(everythingStored());
  });

  it("disconnects: tokens gone here at once, the app told, nothing works after", async () => {
    const { owner, apiKey } = await connectFake();
    let token = "";
    await withAppToken(owner, "fake", (t) => { token = t; });
    const res = await disconnectRoute(req("/api/apps/fake", { method: "DELETE", key: apiKey }), params({ appId: "fake" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ disconnected: true, appTold: true, appHasRevoke: true });
    noTokenIn(text);
    expect(fake.revoked).toEqual([token]);
    const row = getDb().prepare("SELECT access_token_enc, refresh_token_enc, revoked_at FROM app_connections WHERE owner_wallet = ?").get(owner.toLowerCase()) as Record<string, string | null>;
    expect(row.access_token_enc).toBeNull();
    expect(row.refresh_token_enc).toBeNull();
    expect(row.revoked_at).not.toBeNull();
    expect(getConnection(owner, "fake")).toBeNull();
    await expect(withAppToken(owner, "fake", (t) => t)).rejects.toThrow(/not connected/);
    expect((await disconnectRoute(req("/api/apps/fake", { method: "DELETE", key: apiKey }), params({ appId: "fake" }))).status).toBe(404);
  });

  it("disconnects here even when the app cannot be reached, and says so", async () => {
    const { owner } = await connectFake();
    const away = addAppForTests({ ...FAKE, id: "fake-away", revoke: { style: "rfc7009", url: "http://127.0.0.1:3739/revoke" } });
    try {
      // move the connection over to an app whose revoke endpoint does not answer
      getDb().prepare("UPDATE app_connections SET app_id = 'fake-away' WHERE owner_wallet = ?").run(owner.toLowerCase());
      // a sealed token is bound to its row and field, not to the app, so it still opens after the move
      const r = await disconnect(owner, "fake-away");
      expect(r).toEqual({ appTold: false, appHasRevoke: true });
      expect(getConnection(owner, "fake-away")).toBeNull();
    } finally {
      away();
    }
  });

  it("connecting again replaces the old connection", async () => {
    const { owner } = await connectFake();
    const first = getConnection(owner, "fake")!.connectionId;
    await connectFake(owner);
    const second = getConnection(owner, "fake")!;
    expect(second.connectionId).not.toBe(first);
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM app_connections WHERE owner_wallet = ? AND revoked_at IS NULL").get(owner.toLowerCase()) as { n: number }).n).toBe(1);
  });

  it("says nothing the app sent when the owner says no on the app's page", async () => {
    const res = await callbackRoute(req("/api/apps/fake/callback?error=access_denied&error_description=%3Cscript%3E"), params({ appId: "fake" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/dashboard?app=fake&apps=declined#apps`);
  });

  it("logs that it connected, without the token", async () => {
    await connectFake();
    const lines = written.join("\n");
    expect(lines).toContain("apps.connected");
    noTokenIn(lines);
    noTokenIn(everythingStored());
  });
});

describe("the state", () => {
  it("works once", async () => {
    const { back, cookie } = await connectFake();
    const again = await callbackRoute(req(`${back.pathname}${back.search}`, { cookie: `axon_app_fake=${cookie.value}` }), params({ appId: "fake" }));
    expect(again.headers.get("location")).toContain("apps=expired");
  });

  it("only finishes in the browser that started it", async () => {
    const owner = wallet();
    const { apiKey } = createApiKey(owner);
    const started = await connectRoute(req("/api/apps/fake/connect", { method: "POST", key: apiKey }), params({ appId: "fake" }));
    const { url } = (await started.json()) as { url: string };
    const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    // an attacker sends their own sign-in link to someone else: that browser has no cookie, or another one
    for (const cookie of [undefined, "axon_app_fake=someone-elses"]) {
      const res = await callbackRoute(req(`${back.pathname}${back.search}`, { cookie }), params({ appId: "fake" }));
      expect(res.headers.get("location")).toContain("apps=");
      expect(getConnection(owner, "fake")).toBeNull();
    }
  });

  it("is refused when changed, run out, or for another app", async () => {
    const now = Date.now();
    const good = signState({ s: "abc", o: "0x" + "2".repeat(40), a: "fake", e: now + 60_000 });
    expect(readState(good, now)).toMatchObject({ s: "abc", a: "fake" });
    const [body, mac] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ s: "abc", o: "0x" + "3".repeat(40), a: "fake", e: now + 60_000 })).toString("base64url");
    expect(readState(`${forged}.${mac}`, now)).toBeNull();
    expect(readState(`${body}.${mac}x`, now)).toBeNull();
    expect(readState(good, now + 61_000)).toBeNull();
    // signed under another key
    process.env.APP_TOKEN_KEY = KEY_B;
    expect(readState(good, now)).toBeNull();
    process.env.APP_TOKEN_KEY = KEY_A;

    const { apiKey } = createApiKey(wallet());
    const started = await connectRoute(req("/api/apps/fake/connect", { method: "POST", key: apiKey }), params({ appId: "fake" }));
    const { url } = (await started.json()) as { url: string };
    const cookie = started.cookies.get("axon_app_fake")!.value;
    const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    const other = addAppForTests({ ...FAKE, id: "fake2" });
    try {
      const res = await callbackRoute(req(`/api/apps/fake2/callback${back.search}`, { cookie: `axon_app_fake2=${cookie}` }), params({ appId: "fake2" }));
      expect(res.headers.get("location")).toContain("apps=expired");
    } finally {
      other();
    }
  });

  it("is checked by the app with PKCE: a code without the right verifier gets no token", async () => {
    const owner = wallet();
    const started = startConnect({ ownerWallet: owner, appId: "fake", redirectUri: `${ORIGIN}/api/apps/fake/callback` });
    const back = new URL((await fetch(started.url, { redirect: "manual" })).headers.get("location")!);
    // swap the verifier kept for this sign-in for another one
    const { sealToken } = await import("@/lib/appTokens");
    const row = getDb().prepare("SELECT state_id FROM app_oauth_states").get() as { state_id: string };
    getDb().prepare("UPDATE app_oauth_states SET verifier_enc = ?").run(sealToken("not-the-verifier", `state:${row.state_id}`).sealed);
    const res = await callbackRoute(req(`${back.pathname}${back.search}`, { cookie: `axon_app_fake=${started.browser}` }), params({ appId: "fake" }));
    expect(res.headers.get("location")).toContain("apps=failed");
    expect(getConnection(owner, "fake")).toBeNull();
  });

  it("cannot be started too many times at once", () => {
    const owner = wallet();
    for (let i = 0; i < 10; i++) startConnect({ ownerWallet: owner, appId: "fake", redirectUri: `${ORIGIN}/cb` });
    expect(() => startConnect({ ownerWallet: owner, appId: "fake", redirectUri: `${ORIGIN}/cb` })).toThrow(/Too many/);
  });
});

describe("replacing the key", () => {
  it("opens rows sealed under the old key and seals them again under the new one", async () => {
    const { owner } = await connectFake();
    let before = "";
    await withAppToken(owner, "fake", (t) => { before = t; });
    process.env.APP_TOKEN_KEY = KEY_B;
    // without the old key the row cannot be opened, and the message says which key is missing, not the token
    await expect(withAppToken(owner, "fake", (t) => t)).rejects.toThrow(/APP_TOKEN_KEYS_OLD/);
    process.env.APP_TOKEN_KEYS_OLD = `${KEY_A}`;
    expect(resealAll()).toBe(1);
    delete process.env.APP_TOKEN_KEYS_OLD;
    let after = "";
    await withAppToken(owner, "fake", (t) => { after = t; });
    expect(after).toBe(before);
  });

  it("seals a row again the first time it is used under the new key", async () => {
    const { owner } = await connectFake();
    process.env.APP_TOKEN_KEY = KEY_B;
    process.env.APP_TOKEN_KEYS_OLD = KEY_A;
    await withAppToken(owner, "fake", (t) => t);
    const { currentKeyId } = await import("@/lib/appTokens");
    const row = getDb().prepare("SELECT key_id, access_token_enc, refresh_token_enc FROM app_connections WHERE owner_wallet = ? AND revoked_at IS NULL").get(owner.toLowerCase()) as Record<string, string>;
    expect(row.key_id).toBe(currentKeyId());
    expect(row.access_token_enc.split(":")[1]).toBe(currentKeyId());
    expect(row.refresh_token_enc.split(":")[1]).toBe(currentKeyId());
  });
});

describe("the real apps' token answers", () => {
  it("read Slack's user token and Notion's workspace", () => {
    const slack = getApp("slack")!.parseToken({ ok: true, team: { name: "Acme" }, authed_user: { access_token: "xoxp-1", refresh_token: "xoxe-1", expires_in: 43200, scope: "channels:read,chat:write" } });
    expect(slack).toEqual({ accessToken: "xoxp-1", refreshToken: "xoxe-1", expiresIn: 43200, scopes: ["channels:read", "chat:write"], label: "Acme" });
    expect(getApp("slack")!.parseToken({ ok: false, error: "invalid_code" })).toBeNull();
    const notion = getApp("notion")!.parseToken({ access_token: "secret_x", workspace_name: "Team space", owner: { user: { name: "Ada" } } });
    expect(notion).toMatchObject({ accessToken: "secret_x", label: "Team space" });
    expect(getApp("github")!.parseToken({ error: "bad_verification_code" })).toBeNull();
  });
});

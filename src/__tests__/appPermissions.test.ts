// What an agent may do in its owner's apps, and the owner's OK for anything that goes out: the defaults, who may set
// them, that nothing is published without an approval, that an approval is carried out once and runs out in 24
// hours, and that every request and decision is on the job's receipt without what would be sent.
// Also: sealing tokens, and the scrubber knowing the apps' token shapes.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("@/lib/embeddings", async (orig) => ({ ...(await orig<typeof import("@/lib/embeddings")>()), generateEmbedding: async () => null, scheduleAgentEmbedding: () => {} }));
vi.mock("@/lib/agentDescription", async (orig) => ({ ...(await orig<typeof import("@/lib/agentDescription")>()), scheduleAgentDescription: () => {} }));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { createTask } from "@/lib/tasks";
import { createApiKey } from "@/lib/identity";
import { getTraceEvents, traceIdForTask, sha256hex } from "@/lib/traceEvents";
import { addAppForTests, standardToken, type AppDef } from "@/lib/appRegistry";
import { sealToken, openToken, tokenKeyReady, keyIdOfSealed } from "@/lib/appTokens";
import { canDo, requestApproval, takeApproved, approvalStatus, withAppToken, appsEnabled } from "@/lib/agentApps";
import { allowedActions, setPermission, resetPermission, decideApproval, expireApprovals, listApprovals, APPROVAL_TTL_MS } from "@/lib/appPermissions";
import { disconnect } from "@/lib/appConnect";
import { scrubSecrets } from "@/lib/scrubSecrets";
import { GET as approvalsRoute } from "@/app/api/apps/approvals/route";
import { POST as decideRoute } from "@/app/api/apps/approvals/[approvalId]/route";
import { GET as permsGet, PUT as permsPut, DELETE as permsDelete } from "@/app/api/apps/permissions/route";
import type { Agent } from "@/sdk/types";

const KEY = randomBytes(32).toString("base64");
const FAKE: AppDef = {
  id: "fake",
  name: "Fake App",
  blurb: "A stand-in for tests.",
  authorizeUrl: "http://127.0.0.1:3739/authorize",
  tokenUrl: "http://127.0.0.1:3739/token",
  scopeSeparator: " ",
  scopeParam: "scope",
  tokenAuth: "body",
  tokenBody: "form",
  pkce: true,
  actions: { read: { label: "Read", scopes: [] }, draft: { label: "Draft", scopes: [] }, publish: { label: "Publish", scopes: [] } },
  baseScopes: [],
  scopeWords: {},
  revoke: null,
  userinfo: null,
  parseToken: standardToken,
  env: { clientId: "FAKE_APP_CLIENT_ID", clientSecret: "FAKE_APP_CLIENT_SECRET" },
};
const saved = { ...process.env };
let removeFake: () => void = () => {};
let n = 0;
const wallet = () => `0x${(++n + 8_200_000).toString(16).padStart(40, "0")}`;
function agent(id: string): Agent {
  const a: Agent = { agentId: id, name: `Agent ${id}`, capabilities: ["writing"], publicKey: `pk-${id}`, walletAddress: wallet(), provider: "anthropic", reputation: 5, createdAt: new Date().toISOString() };
  createAgent(a, { describe: false });
  return a;
}
/** A connection made by hand, the way the callback stores one. */
function connect(owner: string, appId = "fake", token = `tok_${randomBytes(12).toString("hex")}`): string {
  const id = `appc_${randomBytes(6).toString("hex")}`;
  const now = new Date().toISOString();
  const access = sealToken(token, `${id}:access`);
  getDb()
    .prepare("INSERT INTO app_connections (connection_id, owner_wallet, app_id, scopes, access_token_enc, key_id, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?)")
    .run(id, owner.toLowerCase(), appId, access.sealed, access.keyId, now, now);
  return token;
}
const job = (agentId: string) => createTask({ fromAgent: "client", toAgent: agentId, task: "Write the weekly update and post it." });
const req = (path: string, init: { method?: string; key?: string; body?: unknown } = {}) =>
  new NextRequest(new URL(path, "http://localhost:3730"), {
    method: init.method ?? "GET",
    headers: { host: "localhost:3730", ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
const appEvents = (taskId: string) => getTraceEvents(traceIdForTask(taskId)).filter((e) => e.kind === "app.approval");
const ask = (owner: string, agentId: string, taskId: string, over: Partial<Parameters<typeof requestApproval>[0]> = {}) =>
  requestApproval({ ownerWallet: owner, agentId, taskId, appId: "fake", title: "Post the weekly update in #team", preview: "Hello team,\nThis week we shipped apps.", payload: { channel: "#team", text: "Hello team,\nThis week we shipped apps." }, ...over });

beforeEach(() => {
  Object.assign(process.env, { AGENT_APPS: "on", APP_TOKEN_KEY: KEY, FAKE_APP_CLIENT_ID: "c", FAKE_APP_CLIENT_SECRET: "s" });
  delete process.env.APP_TOKEN_KEYS_OLD;
  getDb().exec("DELETE FROM app_connections; DELETE FROM app_permissions; DELETE FROM app_approvals; DELETE FROM rate_limit_windows; DELETE FROM api_keys; DELETE FROM trace_events; DELETE FROM tasks; DELETE FROM agent_capabilities; DELETE FROM agents;");
  removeFake = addAppForTests(FAKE);
});
afterEach(() => removeFake());
afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("the switch", () => {
  it("is on only when it says on", () => {
    expect(appsEnabled({})).toBe(false);
    expect(appsEnabled({ AGENT_APPS: "off" })).toBe(false);
    expect(appsEnabled({ AGENT_APPS: " ON " })).toBe(true);
  });

  it("off, nothing may be done and every route is not there", async () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    expect(canDo(owner, "w1", "fake", "read")).toBe(true);
    process.env.AGENT_APPS = "off";
    expect(canDo(owner, "w1", "fake", "read")).toBe(false);
    const { apiKey } = createApiKey(owner);
    expect((await approvalsRoute(req("/api/apps/approvals", { key: apiKey }))).status).toBe(404);
    expect((await permsGet(req("/api/apps/permissions", { key: apiKey }))).status).toBe(404);
    expect((await decideRoute(req("/api/apps/approvals/x", { method: "POST", key: apiKey, body: { decision: "approve" } }), { params: Promise.resolve({ approvalId: "x" }) })).status).toBe(404);
  });
});

describe("permissions", () => {
  it("default to read and draft, only in a connected app", () => {
    const owner = wallet();
    agent("w1");
    expect(allowedActions(owner, "w1", "fake")).toEqual(["read", "draft"]);
    expect(canDo(owner, "w1", "fake", "read")).toBe(false); // not connected yet
    connect(owner);
    expect(canDo(owner, "w1", "fake", "read")).toBe(true);
    expect(canDo(owner, "w1", "fake", "draft")).toBe(true);
    expect(canDo(owner, "w1", "fake", "publish")).toBe(false);
    expect(canDo(owner, "w1", "nope", "read")).toBe(false);
    expect(canDo(owner, "w1", "fake", "delete" as never)).toBe(false);
  });

  it("are the owner's to set per agent and per app, and to put back", () => {
    const owner = wallet();
    agent("w1");
    agent("w2");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    expect(canDo(owner, "w1", "fake", "publish")).toBe(true);
    expect(canDo(owner, "w2", "fake", "publish")).toBe(false);
    // another owner's setting changes nothing here
    setPermission(wallet(), "w2", "fake", ["read", "draft", "publish"]);
    expect(canDo(owner, "w2", "fake", "publish")).toBe(false);
    // nothing at all is a choice too, not the defaults
    setPermission(owner, "w2", "fake", []);
    expect(canDo(owner, "w2", "fake", "read")).toBe(false);
    expect(resetPermission(owner, "w2", "fake")).toBe(true);
    expect(canDo(owner, "w2", "fake", "read")).toBe(true);
  });

  it("refuse what does not make sense", () => {
    const owner = wallet();
    agent("w1");
    expect(() => setPermission(owner, "w1", "fake", ["publish"])).toThrow(/drafts too/);
    expect(() => setPermission(owner, "w1", "fake", ["read", "delete"])).toThrow(/read, draft and publish/);
    expect(() => setPermission(owner, "ghost", "fake", ["read"])).toThrow(/no such agent/);
    expect(() => setPermission(owner, "w1", "nope", ["read"])).toThrow(/no such app/);
  });

  it("are set over HTTP by the signed-in owner only", async () => {
    const owner = wallet();
    agent("w1");
    const { apiKey } = createApiKey(owner);
    expect((await permsPut(req("/api/apps/permissions", { method: "PUT", body: { agentId: "w1", appId: "fake", actions: ["read"] } }))).status).toBe(401);
    const put = await permsPut(req("/api/apps/permissions", { method: "PUT", key: apiKey, body: { agentId: "w1", appId: "fake", actions: ["read"] } }));
    expect(put.status).toBe(200);
    const list = (await (await permsGet(req("/api/apps/permissions", { key: apiKey }))).json()) as { permissions: { agentId: string; actions: string[]; agentName: string }[] };
    expect(list.permissions).toEqual([expect.objectContaining({ agentId: "w1", agentName: "Agent w1", actions: ["read"] })]);
    const bad = await permsPut(req("/api/apps/permissions", { method: "PUT", key: apiKey, body: { agentId: "w1", appId: "fake", actions: ["publish"] } }));
    expect(bad.status).toBe(400);
    const del = await permsDelete(req("/api/apps/permissions?agentId=w1&appId=fake", { method: "DELETE", key: apiKey }));
    expect(await del.json()).toEqual({ reset: true });
  });
});

describe("approvals", () => {
  it("cannot be asked for by an agent not allowed to publish", () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    const t = job("w1");
    expect(() => ask(owner, "w1", t.taskId)).toThrow(/may not publish/);
    expect(appEvents(t.taskId)).toHaveLength(0);
  });

  it("must be for the agent's own job", () => {
    const owner = wallet();
    agent("w1");
    agent("w2");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    const theirs = job("w2");
    expect(() => ask(owner, "w1", theirs.taskId)).toThrow(/not this agent's/);
    expect(() => ask(owner, "w1", "no-such-job")).toThrow(/not this agent's/);
  });

  it("wait for the owner, land on the receipt without the content, and are carried out once", () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    const t = job("w1");
    const a = ask(owner, "w1", t.taskId);
    expect(a).toMatchObject({ status: "pending", action: "publish", appId: "fake", taskId: t.taskId });
    expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(APPROVAL_TTL_MS);
    expect(approvalStatus(a.approvalId)).toBe("pending");
    // not approved: nothing can be taken
    expect(takeApproved(a.approvalId, { ownerWallet: owner, agentId: "w1", appId: "fake" })).toBeNull();

    decideApproval(owner, a.approvalId, "approve");
    expect(approvalStatus(a.approvalId)).toBe("approved");
    // only for the owner, agent and app it was asked for
    expect(takeApproved(a.approvalId, { ownerWallet: wallet(), agentId: "w1", appId: "fake" })).toBeNull();
    expect(takeApproved(a.approvalId, { ownerWallet: owner, agentId: "w2", appId: "fake" })).toBeNull();
    const taken = takeApproved(a.approvalId, { ownerWallet: owner, agentId: "w1", appId: "fake" });
    expect(taken?.payload).toEqual({ channel: "#team", text: "Hello team,\nThis week we shipped apps." });
    expect(takeApproved(a.approvalId, { ownerWallet: owner, agentId: "w1", appId: "fake" })).toBeNull();
    expect(approvalStatus(a.approvalId)).toBe("used");

    const events = appEvents(t.taskId);
    expect(events.map((e) => [e.meta?.status, e.meta?.by])).toEqual([["asked", "agent"], ["approved", "owner"], ["used", "agent"]]);
    for (const e of events) {
      expect(e.inputHash).toBe(a.payloadSha256);
      expect(e.meta).toMatchObject({ approval: a.approvalId, app: "fake", action: "publish" });
    }
    expect(a.payloadSha256).toBe(sha256hex(JSON.stringify({ channel: "#team", text: "Hello team,\nThis week we shipped apps." })));
    expect(JSON.stringify(events)).not.toContain("shipped apps");
  });

  it("declined, can never be carried out", () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    const t = job("w1");
    const a = ask(owner, "w1", t.taskId);
    decideApproval(owner, a.approvalId, "decline");
    expect(takeApproved(a.approvalId, { ownerWallet: owner, agentId: "w1", appId: "fake" })).toBeNull();
    expect(() => decideApproval(owner, a.approvalId, "approve")).toThrow(/declined already/);
    expect(appEvents(t.taskId).map((e) => e.meta?.status)).toEqual(["asked", "declined"]);
  });

  it("are decided only by their owner", () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    const a = ask(owner, "w1", job("w1").taskId);
    expect(() => decideApproval(wallet(), a.approvalId, "approve")).toThrow(/no such request/);
    expect(() => decideApproval(owner, a.approvalId, "maybe" as never)).toThrow(/approve/);
    expect(approvalStatus(a.approvalId)).toBe("pending");
  });

  it("expire after 24 hours, said on the receipt, and cannot be approved or carried out after", () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    const t = job("w1");
    const start = Date.now();
    const a = ask(owner, "w1", t.taskId);
    const b = ask(owner, "w1", t.taskId, { title: "Second" });
    decideApproval(owner, b.approvalId, "approve");
    const later = start + APPROVAL_TTL_MS + 1000;
    expect(expireApprovals(later)).toBe(2); // the one nobody answered, and the approved one never carried out
    expect(() => decideApproval(owner, a.approvalId, "approve", later)).toThrow(/expired already/);
    expect(takeApproved(b.approvalId, { ownerWallet: owner, agentId: "w1", appId: "fake" }, later)).toBeNull();
    expect(appEvents(t.taskId).filter((e) => e.meta?.status === "expired").map((e) => e.meta?.by)).toEqual(["expiry", "expiry"]);
  });

  it("are cancelled when the app is disconnected", async () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    const t = job("w1");
    const a = ask(owner, "w1", t.taskId);
    await disconnect(owner, "fake");
    expect(approvalStatus(a.approvalId)).toBe("cancelled");
    expect(canDo(owner, "w1", "fake", "publish")).toBe(false);
    expect(appEvents(t.taskId).map((e) => e.meta?.status)).toEqual(["asked", "cancelled"]);
  });

  it("have limits on what is asked", () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    const t = job("w1");
    expect(() => ask(owner, "w1", t.taskId, { title: "" })).toThrow(/title/);
    expect(() => ask(owner, "w1", t.taskId, { title: "x".repeat(141) })).toThrow(/title/);
    expect(() => ask(owner, "w1", t.taskId, { preview: " " })).toThrow(/preview/);
    expect(() => ask(owner, "w1", t.taskId, { payload: "x".repeat(200_001) })).toThrow(/too large/);
    for (let i = 0; i < 50; i++) ask(owner, "w1", t.taskId, { title: `Post ${i}` });
    expect(() => ask(owner, "w1", t.taskId)).toThrow(/too many/);
  });

  it("show in the owner's inbox and are decided over HTTP", async () => {
    const owner = wallet();
    agent("w1");
    connect(owner);
    setPermission(owner, "w1", "fake", ["read", "draft", "publish"]);
    const { apiKey } = createApiKey(owner);
    const empty = (await (await approvalsRoute(req("/api/apps/approvals", { key: apiKey }))).json()) as { pending: unknown[]; recent: unknown[] };
    expect(empty).toEqual({ pending: [], recent: [] });

    const t = job("w1");
    const a = ask(owner, "w1", t.taskId);
    const text = await (await approvalsRoute(req("/api/apps/approvals", { key: apiKey }))).text();
    const inbox = JSON.parse(text) as { pending: Record<string, unknown>[] };
    expect(inbox.pending).toEqual([expect.objectContaining({ approvalId: a.approvalId, agentName: "Agent w1", appName: "Fake App", title: "Post the weekly update in #team", preview: "Hello team,\nThis week we shipped apps.", receiptUrl: `/r/${t.taskId}` })]);
    expect(inbox.pending[0]).not.toHaveProperty("payload");
    expect(inbox.pending[0]).not.toHaveProperty("ownerWallet");

    // someone else's key sees nothing and decides nothing
    const other = createApiKey(wallet()).apiKey;
    expect(((await (await approvalsRoute(req("/api/apps/approvals", { key: other }))).json()) as { pending: unknown[] }).pending).toEqual([]);
    expect((await decideRoute(req(`/api/apps/approvals/${a.approvalId}`, { method: "POST", key: other, body: { decision: "approve" } }), { params: Promise.resolve({ approvalId: a.approvalId }) })).status).toBe(404);

    const ok = await decideRoute(req(`/api/apps/approvals/${a.approvalId}`, { method: "POST", key: apiKey, body: { decision: "approve" } }), { params: Promise.resolve({ approvalId: a.approvalId }) });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { approval: { status: string } }).approval.status).toBe("approved");
    const again = await decideRoute(req(`/api/apps/approvals/${a.approvalId}`, { method: "POST", key: apiKey, body: { decision: "decline" } }), { params: Promise.resolve({ approvalId: a.approvalId }) });
    expect(again.status).toBe(409);
    const after = listApprovals(owner);
    expect(after.pending).toEqual([]);
    expect(after.recent.map((r) => r.status)).toEqual(["approved"]);
  });
});

describe("withAppToken", () => {
  it("hands the token to the function and nowhere else", async () => {
    const owner = wallet();
    const token = connect(owner);
    expect(await withAppToken(owner, "fake", (t) => t === token)).toBe(true);
    await expect(withAppToken(wallet(), "fake", (t) => t)).rejects.toThrow(/not connected/);
    await expect(withAppToken(owner, "nope", (t) => t)).rejects.toThrow(/no such app/);
  });
});

describe("sealed tokens", () => {
  it("open only with the key and in the place they were sealed for", () => {
    const { sealed, keyId } = sealToken("gho_the_real_token_value", "c1:access");
    expect(sealed).not.toContain("gho_the_real_token_value");
    expect(keyIdOfSealed(sealed)).toBe(keyId);
    expect(openToken(sealed, "c1:access")).toBe("gho_the_real_token_value");
    expect(() => openToken(sealed, "c2:access")).toThrow(/did not open/);
    expect(() => openToken(sealed, "c1:refresh")).toThrow(/did not open/);
    const flipped = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect(() => openToken(flipped, "c1:access")).toThrow();
    // the same token sealed twice looks different each time
    expect(sealToken("gho_the_real_token_value", "c1:access").sealed).not.toBe(sealed);
  });

  it("need a 32-byte key, and say which key is missing without saying anything else", () => {
    expect(tokenKeyReady({})).toBe(false);
    expect(tokenKeyReady({ APP_TOKEN_KEY: Buffer.alloc(16).toString("base64") })).toBe(false);
    expect(tokenKeyReady({ APP_TOKEN_KEY: KEY })).toBe(true);
    expect(() => sealToken("x", "c", {})).toThrow(/APP_TOKEN_KEY/);
    const { sealed } = sealToken("secret-value", "c");
    const other = randomBytes(32).toString("base64");
    try {
      openToken(sealed, "c", { APP_TOKEN_KEY: other });
      throw new Error("opened");
    } catch (e) {
      expect((e as Error).message).toMatch(/APP_TOKEN_KEYS_OLD/);
      expect((e as Error).message).not.toContain("secret-value");
      expect((e as Error).message).not.toContain(KEY);
    }
    expect(openToken(sealed, "c", { APP_TOKEN_KEY: other, APP_TOKEN_KEYS_OLD: `junk,${KEY}` })).toBe("secret-value");
  });
});

describe("the scrubber", () => {
  it("knows the apps' token shapes", () => {
    for (const t of ["xoxe.xox" + "p-1-abcdefghijklmnopqrstuvwxyz0123", "xox" + "e-1-abcdefghijklmnopqrstuvwxyz0123", "secret_" + "a".repeat(43), "ntn_" + "b".repeat(40), "1//0" + "c".repeat(40), "gho_" + "d".repeat(36)]) {
      expect(scrubSecrets(`the app gave ${t} back`)).not.toContain(t);
    }
    expect(scrubSecrets("code_verifier=abcdefghijklmnop")).toBe("code_verifier=[REDACTED]");
    // a path with two slashes or a short "secret_" word is left alone
    expect(scrubSecrets("see https://example.com//0abc and secret_sauce")).toBe("see https://example.com//0abc and secret_sauce");
  });
});

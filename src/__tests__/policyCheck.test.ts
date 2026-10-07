// Outside policy checks on Allowances: what a provider's answer does to a hire, and everything it must not do.
//
// The provider here is a stubbed network. What is under test is our side: which answers stop a hire, that no answer
// never does, that the user's key is stored encrypted and sent only to the provider, and that an allowance key can
// neither see the check nor take it off. The real provider is run against in scripts/policy-e2e.mjs.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { createApiKey } from "@/lib/identity";
import { createAllowanceKey } from "@/lib/allowanceKeys";
import { policyGate, linkPolicy, unlinkPolicy, policyLinkOf, recentPolicyChecks, cleanReason, policyChecksEnabled, PolicyLinkError, POLICY_TIMEOUT_MS } from "@/lib/policyCheck";
import { GET as readPolicy, PUT as putPolicy, DELETE as deletePolicy } from "@/app/api/allowance/policy/route";

const OWNER = "0x00000000000000000000000000000000000a11ce";
const OTHER = "0x0000000000000000000000000000000000000b0b";
const KEY = "aureon_0123456789abcdef0123456789abcdef";
const OBJECTIVE = "obj_f355740e4d908fe34ea48c5c";
const hire = (over: Partial<Parameters<typeof policyGate>[0]> = {}) => ({ owner: OWNER, taskId: "task_1", fromAgent: "caller", toAgent: "research-agent", asset: "ETH" as const, amount: "0.00025", ...over });

interface Call { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: unknown }
let calls: Call[] = [];
/** What the provider answers a check with. A function may throw or hang, as a real one might. */
let onCheck: (call: Call, signal: AbortSignal | undefined) => Promise<Response> | Response;
let keyStatus = 404;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const decision = (d: string, reason: string) => json({ decision: d, objectiveId: OBJECTIVE, actionId: "act_1", reason, policy: { passed: d === "allow", checks: [] } });

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM allowance_policy_links").run();
  db.prepare("DELETE FROM allowance_policy_checks").run();
  calls = [];
  keyStatus = 404;
  onCheck = () => decision("allow", "Hire is inside the ETH limit.");
  vi.stubEnv("POLICY_CHECKS", "on");
  vi.stubEnv("AUREON_API_URL", "https://aureon.test");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const call: Call = { url: String(url), method: init.method ?? "GET", headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined, redirect: init.redirect };
    calls.push(call);
    if (call.method === "GET") return json({ message: keyStatus === 401 ? "Invalid API key" : "Not found" }, keyStatus);
    return onCheck(call, init.signal ?? undefined);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const link = () => linkPolicy(OWNER, { provider: "aureon", apiKey: KEY, objectiveId: OBJECTIVE });

describe("linking a provider", () => {
  it("stores the key encrypted and shows only its last four characters", async () => {
    const l = await link();
    expect(l).toMatchObject({ provider: "aureon", providerName: "AUREON", objectiveId: OBJECTIVE, keyHint: KEY.slice(-4) });
    const row = getDb().prepare("SELECT * FROM allowance_policy_links WHERE owner = ?").get(OWNER) as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(policyLinkOf(OWNER))).not.toContain(KEY);
  });

  it("turns away a key or an objective that cannot be the provider's, before calling anyone", async () => {
    await expect(linkPolicy(OWNER, { provider: "aureon", apiKey: "sk-something-else", objectiveId: OBJECTIVE })).rejects.toThrow(/AUREON API key/);
    await expect(linkPolicy(OWNER, { provider: "aureon", apiKey: KEY, objectiveId: "https://evil.test/x" })).rejects.toThrow(/objective ID/);
    await expect(linkPolicy(OWNER, { provider: "someone-else", apiKey: KEY, objectiveId: OBJECTIVE })).rejects.toBeInstanceOf(PolicyLinkError);
    expect(calls).toHaveLength(0);
    expect(policyLinkOf(OWNER)).toBeNull();
  });

  it("turns away a key the provider says it does not know", async () => {
    keyStatus = 401;
    await expect(link()).rejects.toThrow("AUREON did not accept that API key");
    expect(policyLinkOf(OWNER)).toBeNull();
  });

  it("still links when the provider cannot be reached: every hire is checked anyway", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    await expect(link()).resolves.toMatchObject({ objectiveId: OBJECTIVE });
  });

  it("replaces the link a wallet had, and removing it leaves nothing", async () => {
    await link();
    await linkPolicy(OWNER, { provider: "aureon", apiKey: KEY, objectiveId: "obj_7288a275b486a0dacfbb0958" });
    expect(policyLinkOf(OWNER)?.objectiveId).toBe("obj_7288a275b486a0dacfbb0958");
    expect(unlinkPolicy(OWNER)).toBe(true);
    expect(policyLinkOf(OWNER)).toBeNull();
    expect(unlinkPolicy(OWNER)).toBe(false);
  });
});

describe("what a provider's answer does to a hire", () => {
  it("asks nobody when the wallet has linked nothing", async () => {
    expect(await policyGate(hire())).toBeNull();
    expect(calls).toHaveLength(0);
    expect(recentPolicyChecks(OWNER)).toEqual([]);
  });

  it("sends the hire as it is, with the user's key, to the provider's host only", async () => {
    await link();
    calls = [];
    expect(await policyGate(hire())).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "https://aureon.test/v1/policy/check", method: "POST", redirect: "error",
      body: { agentId: "caller", taskId: "task_1", objectiveId: OBJECTIVE, action: { type: "hire", asset: "ETH", amount: "0.00025", agent: "research-agent" } },
    });
    expect(calls[0].headers["X-Aureon-Api-Key"]).toBe(KEY);
  });

  it("allow lets the hire go on, and the answer is kept", async () => {
    await link();
    expect(await policyGate(hire())).toBeNull();
    expect(recentPolicyChecks(OWNER)[0]).toMatchObject({ outcome: "allow", reason: "Hire is inside the ETH limit.", actionId: "act_1", toAgent: "research-agent", asset: "ETH", amount: "0.00025", taskId: "task_1" });
  });

  it("refuse stops the hire with the provider's reason", async () => {
    await link();
    onCheck = () => decision("refuse", "Hire amount is above the ETH limit.");
    expect(await policyGate(hire())).toBe("AUREON refused this hire: Hire amount is above the ETH limit. Nothing was charged.");
    expect(recentPolicyChecks(OWNER)[0].outcome).toBe("refuse");
  });

  it("authorization_required stops the hire and says it needs the user", async () => {
    await link();
    onCheck = () => decision("authorization_required", "Hire is inside the limit and needs user approval.");
    expect(await policyGate(hire())).toBe("AUREON says this hire needs your approval first: Hire is inside the limit and needs user approval. Nothing was charged.");
  });

  it("a hire paid in $AXON is sent as $AXON, and the provider decides", async () => {
    await link();
    onCheck = () => decision("refuse", "Only ETH can be hired.");
    expect(await policyGate(hire({ asset: "AXON", amount: "8400" }))).toMatch(/^AUREON refused this hire: Only ETH can be hired\./);
    expect((calls.at(-1)!.body as { action: { asset: string; amount: string } }).action).toMatchObject({ asset: "AXON", amount: "8400" });
  });

  it("a link the provider does not recognise stops the hire and says where to fix it", async () => {
    await link();
    onCheck = () => json({ message: "Objective not found", details: null }, 404);
    expect(await policyGate(hire())).toBe("AUREON does not recognise this policy link: Objective not found. Fix it or remove it under Allowance on your dashboard. Nothing was charged.");
    onCheck = () => json({ message: "Invalid API key" }, 401);
    expect(await policyGate(hire())).toMatch(/does not recognise this policy link: Invalid API key\./);
    expect(recentPolicyChecks(OWNER).map((c) => c.outcome)).toEqual(["not_recognised", "not_recognised"]);
  });

  it.each([
    ["an error from the provider", () => json({ message: "boom" }, 500)],
    ["too many requests", () => json({ message: "slow down" }, 429)],
    ["an answer that is not JSON", () => new Response("<html>bad gateway</html>", { status: 200 })],
    ["a decision we were never told about", () => decision("maybe", "Who knows.")],
    ["a redirect, a dead host or a dropped connection", () => { throw new TypeError("fetch failed"); }],
  ])("the hire goes on under its own limits after %s", async (_label, answer) => {
    await link();
    onCheck = answer as typeof onCheck;
    expect(await policyGate(hire())).toBeNull();
    expect(recentPolicyChecks(OWNER)[0].outcome).toBe("unavailable");
  });

  it("does not wait past two seconds for an answer", async () => {
    await link();
    onCheck = (_call, signal) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("timed out", "TimeoutError")));
    });
    const started = Date.now();
    expect(await policyGate(hire())).toBeNull();
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(POLICY_TIMEOUT_MS - 50);
    expect(took).toBeLessThan(POLICY_TIMEOUT_MS + 1_000);
    expect(recentPolicyChecks(OWNER)[0]).toMatchObject({ outcome: "unavailable", reason: "No answer within 2 seconds" });
  }, 10_000);

  it("the switch turns it all off: nobody is asked and nothing is stopped", async () => {
    await link();
    calls = [];
    onCheck = () => decision("refuse", "No.");
    vi.stubEnv("POLICY_CHECKS", "off");
    expect(policyChecksEnabled()).toBe(false);
    expect(await policyGate(hire())).toBeNull();
    expect(calls).toHaveLength(0);
    vi.stubEnv("POLICY_CHECKS", "");
    expect(await policyGate(hire())).toBeNull();
  });

  it("a fault on our own side never stops a hire", async () => {
    await link();
    getDb().prepare("UPDATE allowance_policy_links SET key_enc = 'not-a-ciphertext' WHERE owner = ?").run(OWNER);
    expect(await policyGate(hire())).toBeNull();
  });

  it("one wallet's link never checks another wallet's hires", async () => {
    await link();
    calls = [];
    expect(await policyGate(hire({ owner: OTHER }))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("keeps a provider's words to one short printable line", () => {
    expect(cleanReason("  Over\nthe <b>limit</b>\u0000 ")).toBe("Over the b limit /b");
    expect(cleanReason("x".repeat(500))).toHaveLength(200);
    expect(cleanReason(42)).toBeNull();
    expect(cleanReason("   ")).toBeNull();
  });
});

describe("the route", () => {
  const req = (method: string, key: string | null, body?: unknown) => new NextRequest("http://localhost/api/allowance/policy", {
    method, headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });

  it("links, reads back without the key, and removes", async () => {
    const full = createApiKey(OWNER).apiKey;
    const put = await putPolicy(req("PUT", full, { provider: "aureon", apiKey: KEY, objectiveId: OBJECTIVE }));
    expect(put.status).toBe(200);
    const got = await (await readPolicy(req("GET", full))).json();
    expect(got).toMatchObject({ enabled: true, timeoutMs: 2000, link: { provider: "aureon", objectiveId: OBJECTIVE, keyHint: KEY.slice(-4) }, recent: [] });
    expect(got.providers).toEqual([{ id: "aureon", name: "AUREON" }]);
    expect(JSON.stringify(got)).not.toContain(KEY);

    await policyGate(hire());
    expect((await (await readPolicy(req("GET", full))).json()).recent).toHaveLength(1);

    const del = await (await deletePolicy(req("DELETE", full))).json();
    expect(del.link).toBeNull();
  });

  it("says why a link was refused", async () => {
    const full = createApiKey(OWNER).apiKey;
    const res = await putPolicy(req("PUT", full, { provider: "aureon", apiKey: "nope", objectiveId: OBJECTIVE }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/AUREON API key/);
  });

  it("an allowance key can neither see the check nor take it off, and nobody can without a key", async () => {
    await link();
    const full = createApiKey(OWNER).apiKey;
    void full;
    const assistant = createAllowanceKey(OWNER, {}).apiKey;
    for (const call of [readPolicy(req("GET", assistant)), deletePolicy(req("DELETE", assistant)), putPolicy(req("PUT", assistant, { provider: "aureon", apiKey: KEY, objectiveId: OBJECTIVE }))]) {
      expect((await call).status).toBe(403);
    }
    for (const call of [readPolicy(req("GET", null)), deletePolicy(req("DELETE", null))]) expect((await call).status).toBe(401);
    expect(policyLinkOf(OWNER)).not.toBeNull();
  });

  it("answers enabled: false, and links nothing, while the switch is off", async () => {
    vi.stubEnv("POLICY_CHECKS", "off");
    const full = createApiKey(OWNER).apiKey;
    expect(await (await readPolicy(req("GET", full))).json()).toEqual({ enabled: false });
    expect((await putPolicy(req("PUT", full, { provider: "aureon", apiKey: KEY, objectiveId: OBJECTIVE }))).status).toBe(503);
    expect(policyLinkOf(OWNER)).toBeNull();
  });
});

// Raeto as an inference provider: the key stays on the server, the model is Raeto's routing, and what Raeto says
// ran and cost is what the receipt records. publicHttpFetch is mocked, so nothing reaches Raeto.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockPublicHttpFetch } = vi.hoisted(() => ({ mockPublicHttpFetch: vi.fn() }));

vi.mock("@/lib/urlSecurity", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/urlSecurity")>();
  return { ...original, publicHttpFetch: mockPublicHttpFetch };
});

import type { Agent } from "@/sdk/types";
import { getProvider, effectiveModel } from "@/lib/providers";
import { captureModelStep } from "@/lib/modelUsage";

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  agentId: "raeto-auto",
  name: "Raeto Auto",
  capabilities: ["research"],
  publicKey: "pk-test",
  provider: "raeto",
  reputation: 0,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const answer = (content: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 120, completion_tokens: 40 } }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });

let saved: { key?: string; off?: string };
beforeEach(() => {
  saved = { key: process.env.RAETO_API_KEY, off: process.env.RAETO };
  process.env.RAETO_API_KEY = "sk-raeto-test";
  delete process.env.RAETO;
});
afterEach(() => {
  mockPublicHttpFetch.mockReset();
  if (saved.key === undefined) delete process.env.RAETO_API_KEY;
  else process.env.RAETO_API_KEY = saved.key;
  if (saved.off === undefined) delete process.env.RAETO;
  else process.env.RAETO = saved.off;
});

describe("getProvider: raeto", () => {
  it("needs RAETO_API_KEY", () => {
    delete process.env.RAETO_API_KEY;
    expect(() => getProvider(agent())).toThrow(/RAETO_API_KEY/);
  });

  it("never sends the key to an endpoint the agent names", () => {
    expect(() => getProvider(agent({ providerEndpoint: "https://evil.example.com/v1" }))).toThrow(/providerEndpoint/);
  });

  it("is off with RAETO=off", () => {
    process.env.RAETO = "off";
    expect(() => getProvider(agent())).toThrow(/switched off/);
  });

  it("runs raeto/auto when the agent names no model", () => {
    expect(effectiveModel(agent())).toBe("raeto/auto");
    expect(effectiveModel(agent({ providerModel: "raeto/auto:code" }))).toBe("raeto/auto:code");
  });
});

describe("Raeto calls", () => {
  it("go to api.raeto.cc with raeto/auto and the server's key", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(answer("Morpho is a lending protocol."));
    expect(await getProvider(agent()).complete("system", "Explain Morpho in one line")).toBe("Morpho is a lending protocol.");
    const [url, init] = mockPublicHttpFetch.mock.calls.at(-1)!;
    expect(url).toBe("https://api.raeto.cc/v1/chat/completions");
    expect((JSON.parse((init as RequestInit).body as string) as { model: string }).model).toBe("raeto/auto");
    expect(JSON.stringify((init as RequestInit).headers)).toContain("Bearer sk-raeto-test");
  });

  it("record the model that really answered and what Raeto charged", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(answer("ok", { "x-raeto-model": "openai/gpt-4o-mini", "x-raeto-cost": "0.00021", "x-raeto-tier": "fast" }));
    const step = await captureModelStep(() => getProvider(agent()).complete("system", "hi"));
    expect(step.model).toBe("openai/gpt-4o-mini");
    expect(step.costUsd).toBe(0.00021);
    expect(step.inputTokens).toBe(120);
    expect(step.outputTokens).toBe(40);
  });

  it("leave the cost to the estimate when Raeto does not say it", async () => {
    mockPublicHttpFetch.mockResolvedValueOnce(answer("ok"));
    const step = await captureModelStep(() => getProvider(agent()).complete("system", "hi"));
    expect(step.model).toBe("raeto/auto");
    expect(step.costUsd).toBeUndefined();
  });

  it("do not read Raeto's headers for any other provider", async () => {
    process.env.XAI_API_KEY = "test-xai";
    mockPublicHttpFetch.mockResolvedValueOnce(answer("ok", { "x-raeto-model": "spoofed/model", "x-raeto-cost": "9" }));
    const step = await captureModelStep(() => getProvider(agent({ provider: "grok" })).complete("system", "hi"));
    expect(step.model).toBe("grok-4.5");
    expect(step.costUsd).toBeUndefined();
    delete process.env.XAI_API_KEY;
  });

  it("surface Raeto's errors with their status, so a failed hire is refunded", async () => {
    mockPublicHttpFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Out of credits", type: "insufficient_balance" } }), { status: 402 }),
    );
    await expect(getProvider(agent()).complete("system", "hi")).rejects.toThrow(/402/);
  });
});

describe("Raeto Auto's record", () => {
  it("starts with no seeded history: only the jobs it really did count", async () => {
    const { getDb } = await import("@/lib/db");
    const { backfillAgentHistory } = await import("@/lib/agentSeed");
    const db = getDb();
    backfillAgentHistory(db);
    const seeded = (to: string) => (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE to_agent = ? AND started_by = 'seed'").get(to) as { n: number }).n;
    expect(seeded("raeto-auto")).toBe(0);
    expect(seeded("nock-coder")).toBeGreaterThan(0);
  });
});

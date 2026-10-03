import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/embeddings", async (orig) => ({
  ...(await orig<typeof import("@/lib/embeddings")>()),
  generateEmbedding: async () => null,
  embedQuery: async () => null,
  semanticSearchAgents: async () => null,
}));
vi.mock("@/lib/holderTier", async (orig) => ({
  ...(await orig<typeof import("@/lib/holderTier")>()),
  getTier: async () => ({ tier: { name: "base", minimum: 0, rank: 0 }, balance: 0, stale: false }),
}));

import { getDb } from "@/lib/db";
import { createAgent } from "@/lib/agents";
import { startDraft, toDraft, extractJson, freeHandle, getBuild, buildsOf, type Writer } from "@/lib/studioDraft";
import { BUILDS_PER_DAY, PRICE_ETH } from "@/lib/studioPolicy";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "0")}`;

const GOOD = {
  name: "Earnings Call Brief",
  handle: "earnings-call-brief",
  description: "Turns any earnings call transcript into five sharp bullets for investors.",
  capabilities: ["earnings analysis", "summarization"],
  category: "Finance",
  instructions: "You turn an earnings call transcript into exactly five bullets for an investor. Lead with revenue and its growth, then margins, then guidance quoted exactly. Flag anything management avoided. If no transcript is given, ask for it in one line.",
  model: "claude-sonnet-5",
  tools: ["web_search", "commerce"],
};
const writes = (o: unknown): Writer => async () => `Here you go:\n${JSON.stringify(o)}\nThanks`;

beforeEach(() => { n += 1000; });

describe("one sentence into a draft agent", () => {
  it("writes a whole draft, kept to what Studio may hand out", async () => {
    const me = wallet();
    const b = await startDraft(me, "An agent that turns any earnings call into a five bullet brief", writes(GOOD));
    expect(typeof b).toBe("object");
    const build = b as Exclude<typeof b, string>;
    expect(build.status).toBe("drafted");
    expect(build.draft).toMatchObject({ name: "Earnings Call Brief", model: "claude-sonnet-5", category: "Finance" });
    expect(build.draft!.tools).toEqual(["web_search"]); // spending is never handed out
    expect(build.draft!.priceEth).toBe(PRICE_ETH.fallback); // nothing similar to price from
    expect(getBuild(build.id)?.wallet).toBe(me);
    expect(buildsOf(me)).toHaveLength(1);
  });

  it("finds the JSON whatever the writer put around it", () => {
    expect(extractJson("sure! {\"a\":1} done")).toEqual({ a: 1 });
    expect(extractJson("no json here")).toBeNull();
  });

  it("refuses a draft that is too thin, nameless, or poses as Axon", () => {
    expect(toDraft({ ...GOOD, instructions: "be good" }, wallet(), 0.001)).toMatch(/too thin/);
    expect(toDraft({ ...GOOD, name: "" }, wallet(), 0.001)).toMatch(/no name/);
    expect(toDraft({ ...GOOD, name: "Axon Brief" }, wallet(), 0.001)).toMatch(/impersonate/);
    expect(toDraft({ ...GOOD, capabilities: [] }, wallet(), 0.001)).toMatch(/nothing it can do/);
  });

  it("files the agent under one of Axon's categories, its skills deciding when the writer names none", () => {
    expect((toDraft({ ...GOOD, category: "Finance" }, wallet(), 0.001) as { category: string }).category).toBe("Finance");
    expect((toDraft({ ...GOOD, category: "Crypto Stuff" }, wallet(), 0.001) as { category: string }).category).toBe("Research"); // from "summarization"
  });

  it("falls back to a sound model, and keeps any price inside Studio's bounds", () => {
    const d = toDraft({ ...GOOD, model: "gpt-9-ultra" }, wallet(), 999);
    expect(typeof d).toBe("object");
    expect((d as { model: string }).model).toBe("claude-sonnet-5");
    expect((d as { priceEth: number }).priceEth).toBe(PRICE_ETH.max);
  });

  it("never takes a handle someone already has", () => {
    const me = wallet();
    const taken = `taken-handle-${n}`;
    createAgent({ agentId: taken, name: "Taken", capabilities: ["x"], publicKey: `pk-${taken}`, provider: "anthropic", reputation: 5, category: "General", createdAt: new Date().toISOString() });
    expect(freeHandle(taken, me)).toBe(`${taken}-2`);
  });

  it("records a failed build with its reason when the writer gives nothing usable", async () => {
    const b = await startDraft(wallet(), "An agent that turns any earnings call into a five bullet brief", async () => "I cannot help with that.");
    expect(typeof b).toBe("object");
    expect((b as { status: string }).status).toBe("failed");
    expect((b as { error: string }).error).toMatch(/did not return a draft/);
  });

  it("asks for a real sentence, and keeps to one", async () => {
    expect(await startDraft(wallet(), "agent", writes(GOOD))).toMatch(/Describe the agent/);
    expect(await startDraft(wallet(), "x ".repeat(300), writes(GOOD))).toMatch(/at most/);
  });

  it("is free, within a daily limit per wallet", async () => {
    const me = wallet();
    const now = new Date().toISOString();
    for (let i = 0; i < BUILDS_PER_DAY.base; i++) {
      getDb().prepare("INSERT INTO studio_builds (id, wallet, sentence, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(`seed-${n}-${i}`, me, "s", "drafted", now, now);
    }
    expect(await startDraft(me, "An agent that turns any earnings call into a five bullet brief", writes(GOOD))).toMatch(/builds for today/);
  });
});

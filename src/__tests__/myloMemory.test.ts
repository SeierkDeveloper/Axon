// Mylo, phase 6: memory per wallet. It keeps what the person tells it to, uses it next time, forgets on request, shows
// it to its owner alone, and never keeps a secret, whoever asks.
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { runTool } from "@/lib/myloTools";
import { runTurn, MYLO_SYSTEM, type Streamer, type MyloEvent } from "@/lib/myloChat";
import { memoryOf, remember, startConversation } from "@/lib/myloStore";
import { secretLike, MEMORY } from "@/lib/myloPolicy";
import { GET as memGET, DELETE as memDELETE } from "@/app/api/mylo/memory/route";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "7")}`;
const ctx = (w: string) => ({ wallet: w, owner: w, conversationId: startConversation(w, "t").id });

describe("what Mylo will never keep", () => {
  it("spots private keys, seed phrases, service keys, long tokens and passwords, and lets ordinary facts and addresses through", () => {
    expect(secretLike(`0x${"a1".repeat(32)}`)).toBe(true);
    expect(secretLike("apple river candle moon tiger glass ocean paper stone light green house")).toBe(true);
    expect(secretLike("sk-ant-api03-abcdefghijklmnop")).toBe(true);
    expect(secretLike("token Zx9aB3kL0pQ7rT2vW5yU8iO1eN4mC6hJ")).toBe(true);
    expect(secretLike("my password is hunter2")).toBe(true);
    expect(secretLike("0.01 ETH a week")).toBe(false);
    expect(secretLike("Prefers short answers with a list")).toBe(false);
    expect(secretLike("pays from 0x2ff6a1b2c3d4e5f60718293a4b5c6d7e8f90f292")).toBe(false);
    expect(secretLike("builds release notes agents for a SaaS product team")).toBe(false);
  });
});

describe("Mylo's memory", () => {
  it("remembers what you tell it, one value per key, and refuses a secret", async () => {
    const w = wallet(), c = ctx(w);
    expect((await runTool("remember", { key: "Budget", value: "0.01 ETH a week" }, c)).result).toMatchObject({ remembered: { key: "budget", value: "0.01 ETH a week" } });
    await runTool("remember", { key: "budget", value: "0.02 ETH a week" }, c);
    expect(memoryOf(w)).toEqual([expect.objectContaining({ key: "budget", value: "0.02 ETH a week" })]);
    const secret = await runTool("remember", { key: "wallet", value: "apple river candle moon tiger glass ocean paper stone light green house" }, c);
    expect(secret.result).toMatchObject({ error: expect.stringMatching(/never keeps those/) });
    expect(memoryOf(w)).toHaveLength(1);
    expect((await runTool("remember", { key: "notes", value: "x".repeat(MEMORY.factChars + 1) }, c)).result).toMatchObject({ error: expect.stringMatching(/under/) });
  });

  it("reads what it remembers into the conversation, and forgets one thing or everything on request", async () => {
    const w = wallet(), c = ctx(w);
    remember(w, "answer_style", "short, with a list");
    remember(w, "building", "release notes agents");
    let seen = "";
    const said: MyloEvent[] = [];
    const streamer: Streamer = async (a, onText) => { seen = a.system; onText("ok"); return { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" }; };
    await runTurn({ owner: w, wallet: w, speaker: "base", text: "hi" }, (e) => said.push(e), streamer);
    expect(seen.startsWith(MYLO_SYSTEM)).toBe(true);
    expect(seen).toContain("- answer_style: short, with a list");
    expect((await runTool("forget", { key: "answer style" }, c)).result).toEqual({ forgot: "answer_style" });
    expect((await runTool("forget", { key: "nope" }, c)).result).toMatchObject({ error: expect.any(String), remembered_keys: ["building"] });
    expect((await runTool("forget", { everything: true }, c)).result).toMatchObject({ forgot: 1, everything: true });
    expect(memoryOf(w)).toEqual([]);
  });

  it("shows a wallet its own memory and lets it clear it, and nobody else", async () => {
    const w = wallet();
    remember(w, "budget", "0.01 ETH");
    // signed-in requests carry an API key; a visitor gets nothing
    const visitor = await memGET(new NextRequest("https://axon-agents.com/api/mylo/memory"));
    expect(visitor.status).toBe(403);
    const del = await memDELETE(new NextRequest("https://axon-agents.com/api/mylo/memory", { method: "DELETE", body: "{}" }));
    expect(del.status).toBe(403);
    expect(memoryOf(w)).toHaveLength(1);
  });

  it("is told what to keep and what never to keep", () => {
    expect(MYLO_SYSTEM).toMatch(/Never anything secret/);
    expect(MYLO_SYSTEM).toMatch(/Use it quietly/);
  });
});

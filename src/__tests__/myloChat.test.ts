// Mylo, phase 1: a turn of conversation, and the routes the page talks to. The model is a stand-in; nothing is spent.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { runTurn, toTurns, titleOf, forHistory, dashCleaner, MYLO_SYSTEM, type MyloEvent, type Streamer } from "@/lib/myloChat";
import { MESSAGES_PER_DAY, TURN_BUDGET } from "@/lib/myloPolicy";
import { addMessage, historyOf, ownerOf, limitKeyOf, remember, startConversation, conversationsOf } from "@/lib/myloStore";
import { POST as chatPOST } from "@/app/api/mylo/chat/route";
import { GET as listGET } from "@/app/api/mylo/conversations/route";
import { GET as oneGET } from "@/app/api/mylo/conversations/[id]/route";

let n = 0;
const owner = () => `0x${(++n).toString(16).padStart(40, "c")}`;
const run = async (input: Parameters<typeof runTurn>[0], streamer: Streamer) => { const ev: MyloEvent[] = []; await runTurn(input, (e) => ev.push(e), streamer); return ev; };
const say = (text: string): Streamer => async (_args, onText) => { const parts = text.split(" "); parts.forEach((w, i) => onText(i < parts.length - 1 ? `${w} ` : w)); return { blocks: [{ type: "text", text }], stop: "end_turn" }; };

describe("a turn with Mylo", () => {
  beforeEach(() => { delete process.env.MYLO; });

  it("starts a conversation, streams the answer, saves both sides and ends happy", async () => {
    const me = owner();
    const ev = await run({ owner: me, wallet: me, speaker: "base", text: "What is Agent Studio?" }, say("It turns one sentence into a tested agent."));
    const conv = ev.find((e) => e.type === "conversation") as Extract<MyloEvent, { type: "conversation" }>;
    expect(conv.title).toBe("What is Agent Studio?");
    expect(ev.map((e) => e.type)).toEqual(["conversation", "face", "face", ...Array(8).fill("text"), "face", "done"]);
    expect(ev.filter((e) => e.type === "face").map((e) => (e as { state: string }).state)).toEqual(["thinking", "talking", "happy"]);
    expect(historyOf(conv.id, 10).map((m) => [m.role, m.content])).toEqual([["user", "What is Agent Studio?"], ["assistant", "It turns one sentence into a tested agent."]]);
  });

  it("reads the conversation back to the model, and what it remembers about the wallet", async () => {
    const me = owner();
    remember(me, "budget", "0.05 ETH a week");
    const first = await run({ owner: me, wallet: me, speaker: "base", text: "hi" }, say("Hello."));
    const id = (first[0] as { id: string }).id;
    let seen: Parameters<Streamer>[0] | null = null;
    await run({ owner: me, wallet: me, speaker: "base", text: "and again", conversationId: id }, async (args) => { seen = args; return { blocks: [{ type: "text", text: "ok" }], stop: "end_turn" }; });
    expect(seen!.messages.map((t) => t.content)).toEqual(["hi", "Hello.", "and again"]);
    expect(seen!.system).toContain("budget: 0.05 ETH a week");
    expect(seen!.maxTokens).toBe(TURN_BUDGET.answerTokens);
  });

  it("turns away an empty or oversized message, someone else's conversation, and a speaker over the day's limit", async () => {
    const me = owner(), other = owner();
    expect((await run({ owner: me, wallet: me, speaker: "base", text: "   " }, say("x")))[0]).toMatchObject({ type: "error", code: "input" });
    expect((await run({ owner: me, wallet: me, speaker: "base", text: "x".repeat(TURN_BUDGET.inputChars + 1) }, say("x")))[0]).toMatchObject({ type: "error", code: "input" });
    const theirs = startConversation(other, "theirs");
    expect((await run({ owner: me, wallet: me, speaker: "base", text: "hi", conversationId: theirs.id }, say("x")))[0]).toMatchObject({ type: "error", code: "not_found" });
    const guest = ownerOf(null, `198.51.100.${n}`), key = limitKeyOf(null, `198.51.100.${n}`);
    const c = startConversation(guest, "busy");
    for (let i = 0; i < MESSAGES_PER_DAY.guest; i++) addMessage(c.id, guest, "user", `m${i}`, null, key);
    // a fresh browser on the same address: new conversations, the same day's count
    const limited = await run({ owner: ownerOf(null, `198.51.100.${n}`, "1b4e28ba-2fa1-11d2-883f-0016d3cca427"), limitKey: key, wallet: null, speaker: "guest", text: "one more" }, say("x"));
    expect(limited[0]).toMatchObject({ type: "error", code: "limit" });
    expect((limited[0] as { message: string }).message).toMatch(/Sign in with a wallet/);
  });

  it("is quiet when switched off", async () => {
    process.env.MYLO = "off";
    expect((await run({ owner: owner(), wallet: null, speaker: "guest", text: "hi" }, say("x")))[0]).toMatchObject({ type: "error", code: "off" });
  });

  it("keeps what was said when the model fails midway, marked as cut short, and says so", async () => {
    const me = owner();
    const ev = await run({ owner: me, wallet: me, speaker: "base", text: "tell me a lot" }, async (_a, onText) => { onText("Part one."); throw new Error("connection reset"); });
    expect(ev.at(-1)).toMatchObject({ type: "error", code: "model" });
    expect(ev.filter((e) => e.type === "face").map((e) => (e as { state: string }).state)).toEqual(["thinking", "talking", "failed"]);
    const id = (ev[0] as { id: string }).id;
    expect(historyOf(id, 10).at(-1)?.content).toBe("Part one.\n\n(cut short)");
  });

  it("gives the model turns that alternate and start with the person, and names conversations sensibly", () => {
    expect(toTurns([{ role: "assistant", content: "a" }, { role: "user", content: "u1" }, { role: "user", content: "u2" }, { role: "tool", content: "t" }, { role: "assistant", content: "b" }]))
      .toEqual([{ role: "user", content: "u1\n\nu2" }, { role: "assistant", content: "b" }]);
    expect(titleOf("short one")).toBe("short one");
    const long = titleOf("Find me an agent that turns long earnings calls into five clear bullet points for my team");
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });

  it("knows a hire is only a proposal, and never asks for keys", () => {
    expect(MYLO_SYSTEM).toMatch(/PROPOSE a hire/);
    expect(MYLO_SYSTEM).toMatch(/Never promise a refund/);
    expect(MYLO_SYSTEM).toMatch(/Never ask for a private key/);
    expect(MYLO_SYSTEM).not.toMatch(/—/);
  });
});

describe("the routes", () => {
  it("lets a visitor talk without a wallet, streams line-delimited events, and lists their conversations", async () => {
    vi.resetModules();
    const ip = "203.0.113.200";
    const mod = await import("@/lib/myloChat");
    const spy = vi.spyOn(mod, "runTurn").mockImplementation(async (_i, emit) => { emit({ type: "conversation", id: "c1", title: "t" }); emit({ type: "text", delta: "hi" }); emit({ type: "done", messageId: "m1" }); });
    const { POST } = await import("@/app/api/mylo/chat/route");
    const res = await POST(new NextRequest("https://axon-agents.com/api/mylo/chat", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ text: "hello" }) }));
    expect(res.headers.get("content-type")).toContain("ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(["conversation", "text", "done"]);
    expect(spy.mock.calls[0][0]).toMatchObject({ wallet: null, speaker: "guest", text: "hello" });
    spy.mockRestore();
  });

  it("refuses a bad key instead of treating it as a visitor, and needs text", async () => {
    const bad = await chatPOST(new NextRequest("https://axon-agents.com/api/mylo/chat", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-a-real-key" }, body: JSON.stringify({ text: "hi" }) }));
    expect(bad.status).toBe(401);
    const noText = await chatPOST(new NextRequest("https://axon-agents.com/api/mylo/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }));
    expect(noText.status).toBe(400);
  });

  it("shows a visitor only their own browser's conversations, and today's limit by address", async () => {
    process.env.TRUST_PROXY_HEADERS = "true";
    const ip = "203.0.113.77", visitor = "6f1c2a9e-1111-4c3b-9d1e-123456789abc", neighbour = "7a2d3b0f-2222-4c3b-9d1e-123456789abc";
    const me = ownerOf(null, ip, visitor);
    const c = startConversation(me, "mine");
    addMessage(c.id, me, "user", "q", null, limitKeyOf(null, ip));
    addMessage(c.id, me, "assistant", "a", null, limitKeyOf(null, ip));
    const list = await (await listGET(new NextRequest("https://axon-agents.com/api/mylo/conversations", { headers: { "x-forwarded-for": ip, "x-mylo-visitor": visitor } }))).json();
    expect(list.conversations.map((x: { id: string }) => x.id)).toContain(c.id);
    expect(list).toMatchObject({ signedIn: false, perDay: MESSAGES_PER_DAY.guest, left: MESSAGES_PER_DAY.guest - 1 });
    const one = await (await oneGET(new NextRequest(`https://axon-agents.com/api/mylo/conversations/${c.id}`, { headers: { "x-forwarded-for": ip, "x-mylo-visitor": visitor } }), { params: Promise.resolve({ id: c.id }) })).json();
    expect(one.messages.map((m: { content: string }) => m.content)).toEqual(["q", "a"]);
    // someone else on the same network, in their own browser, sees none of it but shares the address's day count
    const theirs = await (await listGET(new NextRequest("https://axon-agents.com/api/mylo/conversations", { headers: { "x-forwarded-for": ip, "x-mylo-visitor": neighbour } }))).json();
    expect(theirs.conversations).toHaveLength(0);
    expect(theirs.left).toBe(MESSAGES_PER_DAY.guest - 1);
    const other = await oneGET(new NextRequest(`https://axon-agents.com/api/mylo/conversations/${c.id}`, { headers: { "x-forwarded-for": ip, "x-mylo-visitor": neighbour } }), { params: Promise.resolve({ id: c.id }) });
    expect(other.status).toBe(404);
    expect(conversationsOf(ownerOf(null, ip, neighbour))).toHaveLength(0);
  });
});

describe("how Mylo's words come out", () => {
  it("never shows an em dash, even when one arrives split across pieces", () => {
    const c = dashCleaner();
    const out = ["Release Notes Writer ", "\u2014", " cheap", " and good \u2014 try it", "  "].map((d) => c.push(d)).join("") + c.flush();
    expect(out).toBe("Release Notes Writer, cheap and good, try it  ");
    expect(out).not.toContain("\u2014");
  });

  it("rereads the agents it showed, with their ids, so it can hire without searching again", () => {
    const m = forHistory({ role: "assistant", content: "Found two.", meta: { cards: [{ kind: "agents", agents: [{ agentId: "rnw", name: "Release Notes Writer", priceEth: 0.0012 }, { agentId: "qq", name: "Quick Quill", priceEth: null }] }] } });
    expect(m.content).toBe("Found two.\n\n[Agents shown: Release Notes Writer (id rnw, 0.0012 ETH); Quick Quill (id qq, free)]");
    expect(forHistory({ role: "user", content: "hi", meta: null }).content).toBe("hi");
  });
});

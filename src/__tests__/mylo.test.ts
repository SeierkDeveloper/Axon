// Mylo, phase 0: the rules and the records.
import { describe, it, expect } from "vitest";
import { getDb } from "@/lib/db";
import { messagesAllowed, MESSAGES_PER_DAY, myloEnabled, myloModels, shortWallet, toolGate, TOOLS, MEMORY } from "@/lib/myloPolicy";
import {
  ownerOf, startConversation, getConversation, conversationsOf, addMessage, historyOf, sentToday,
  remember, forget, memoryOf, notify, inboxOf, markRead, think, feed,
} from "@/lib/myloStore";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "a")}`;

describe("Mylo's rules", () => {
  it("can be switched off, and picks its models from the environment", () => {
    expect(myloEnabled({})).toBe(true);
    expect(myloEnabled({ MYLO: "off" })).toBe(false);
    expect(myloModels({}).chat).toBe("claude-sonnet-5");
    expect(myloModels({ MYLO_MODEL: "claude-opus-5-5" }).chat).toBe("claude-opus-5-5");
  });

  it("lets a speaker send up to their tier's daily limit, and says how to get more", () => {
    expect(messagesAllowed("guest", MESSAGES_PER_DAY.guest - 1).ok).toBe(true);
    const g = messagesAllowed("guest", MESSAGES_PER_DAY.guest);
    expect(g.ok).toBe(false);
    expect(!g.ok && g.reason).toMatch(/Sign in with a wallet/);
    const b = messagesAllowed("base", MESSAGES_PER_DAY.base);
    expect(!b.ok && b.reason).toMatch(/Holding more \$AXON/);
    expect(MESSAGES_PER_DAY.operator).toBeGreaterThan(MESSAGES_PER_DAY.holder);
  });

  it("never lets anything that spends run without a confirmation, and keeps your things behind a wallet", () => {
    for (const [name, rule] of Object.entries(TOOLS)) {
      if (rule.spends) expect(toolGate(name, true)).toEqual({ ok: true, confirm: true });
      if (rule.wallet) expect(toolGate(name, false).ok).toBe(false);
    }
    expect(toolGate("search_agents", false)).toEqual({ ok: true, confirm: false });
    expect(toolGate("withdraw_earnings", true)).toEqual({ ok: true, confirm: true });
    expect(toolGate("drain_treasury", true).ok).toBe(false);
  });

  it("never shows a whole wallet in public", () => {
    expect(shortWallet("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortWallet("not a wallet")).toBe("someone");
  });
});

describe("Mylo's records", () => {
  it("keeps a visitor as a hash of their browser's id (or address), never the id or address itself", () => {
    const v = ownerOf(null, "203.0.113.7", "6f1c2a9e-aaaa-4c3b-9d1e-123456789abc");
    expect(v).toMatch(/^guest:[0-9a-f]{32}$/);
    expect(v).not.toContain("6f1c2a9e");
    expect(v).not.toBe(ownerOf(null, "203.0.113.7", "6f1c2a9e-bbbb-4c3b-9d1e-123456789abc"));
    expect(ownerOf(null, "203.0.113.7", "not an id!")).toBe(ownerOf(null, "203.0.113.7"));
    const o = ownerOf(null, "203.0.113.7");
    expect(o).toMatch(/^guest:[0-9a-f]{32}$/);
    expect(o).not.toContain("203.0.113.7");
    expect(ownerOf(null, "203.0.113.7")).toBe(o);
    expect(ownerOf("0xABC", null)).toBe("0xabc");
  });

  it("keeps conversations to their owner, reads history oldest first, and counts only what was sent", () => {
    const me = wallet(), other = wallet();
    const c = startConversation(me, "Market brief");
    addMessage(c.id, me, "user", "find me a research agent");
    addMessage(c.id, me, "tool", "search_agents", { name: "search_agents" });
    addMessage(c.id, me, "assistant", "Here are three.");
    addMessage(c.id, me, "user", "hire the first one");
    expect(getConversation(c.id, me)?.title).toBe("Market brief");
    expect(getConversation(c.id, other)).toBeNull();
    expect(conversationsOf(me).map((x) => x.id)).toContain(c.id);
    const h = historyOf(c.id, 3);
    expect(h.map((m) => m.role)).toEqual(["tool", "assistant", "user"]);
    expect(h[0].meta).toEqual({ name: "search_agents" });
    expect(sentToday(me)).toBe(2);
    expect(sentToday(other)).toBe(0);
  });

  it("remembers per wallet, updates in place, caps the count, and forgets on request", () => {
    const me = wallet();
    remember(me, "Budget", "0.05 ETH a week");
    remember(me, "budget", "0.08 ETH a week");
    expect(memoryOf(me)).toHaveLength(1);
    expect(memoryOf(me)[0].value).toBe("0.08 ETH a week");
    for (let i = 0; i < MEMORY.factsPerWallet + 5; i++) remember(me, `fact ${i}`, `value ${i}`);
    expect(memoryOf(me)).toHaveLength(MEMORY.factsPerWallet);
    expect(memoryOf(wallet())).toHaveLength(0);
    expect(forget(me, "fact 5")).toBeLessThanOrEqual(1);
    forget(me);
    expect(memoryOf(me)).toHaveLength(0);
  });

  it("leaves each notice once, and marks them read", () => {
    const me = wallet();
    expect(notify(me, "score", "Your agent's score dropped", "From 8.4 to 7.1", "/studio", "score:a:1")).toBe(true);
    expect(notify(me, "score", "Your agent's score dropped", "again", "/studio", "score:a:1")).toBe(false);
    notify(me, "earned", "Your agent earned 0.001 ETH", null, "/studio", "earned:a:2");
    expect(inboxOf(me)).toHaveLength(2);
    expect(inboxOf(me, true)).toHaveLength(2);
    expect(markRead(me)).toBe(2);
    expect(inboxOf(me, true)).toHaveLength(0);
  });

  it("says in public only what the policy allows, once per event", () => {
    const t = think("hired", "Hired the research agent for a market brief.", "/agents/research-agent", "task:1");
    expect(t?.kind).toBe("hired");
    expect(think("hired", "Hired the research agent for a market brief.", null, "task:1")).toBeNull();
    // @ts-expect-error: not a kind the feed allows
    expect(think("secret", "a private draft")).toBeNull();
    expect(feed(5).map((x) => x.text)).toContain("Hired the research agent for a market brief.");
    expect(getDb().prepare("SELECT COUNT(*) n FROM mylo_feed WHERE dedupe_key = 'task:1'").get()).toEqual({ n: 1 });
  });
});

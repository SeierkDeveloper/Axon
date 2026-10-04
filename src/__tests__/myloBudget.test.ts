// Mylo's daily budget: what calls cost, what is held before each one, and that Mylo stops before the budget, not after.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getDb } from "@/lib/db";
import { runTurn, requestBytes, fitHistory, MYLO_SYSTEM, type MyloEvent, type Streamer } from "@/lib/myloChat";
import { callBoundMicroUsd, costMicroUsd, dailyBudgetUsd, modelFor, myloModels, priceOf, CHEAP_FROM_SHARE, TURN_BUDGET } from "@/lib/myloPolicy";
import { budgetShare, reserveCall, settleCall, spendByDay, spentTodayMicroUsd, _resetHolds } from "@/lib/myloBudget";

let n = 0;
const wallet = () => `0x${(++n).toString(16).padStart(40, "b")}`;
const run = async (input: Parameters<typeof runTurn>[0], streamer: Streamer) => { const ev: MyloEvent[] = []; await runTurn(input, (e) => ev.push(e), streamer); return ev; };
const used = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0 });

beforeEach(() => { getDb().prepare("DELETE FROM mylo_usage").run(); _resetHolds(); delete process.env.MYLO_DAILY_BUDGET_USD; delete process.env.MYLO; });
afterEach(() => { delete process.env.MYLO_DAILY_BUDGET_USD; });

describe("what Mylo's calls cost", () => {
  it("prices calls from the model's own usage, cache reads at a tenth, and an unknown model as the dearest", () => {
    expect(costMicroUsd("claude-haiku-4-5", used(1_000_000, 0))).toBe(1_000_000);
    expect(costMicroUsd("claude-sonnet-5", used(10_000, 1_000))).toBe(45_000); // 3 cents + 1.5 cents
    expect(costMicroUsd("claude-sonnet-5", { input: 0, output: 0, cacheRead: 10_000 })).toBe(3_000);
    expect(priceOf("claude-someday-9")).toEqual({ in: 15, out: 75 });
    expect(dailyBudgetUsd({})).toBe(50);
    expect(dailyBudgetUsd({ MYLO_DAILY_BUDGET_USD: "12.5" })).toBe(12.5);
  });

  it("holds a bound before a call that its real cost can't pass, whatever the text is made of", () => {
    // emoji and other scripts take more tokens per character than English, but never more than one per byte
    const heavy = [{ role: "user" as const, content: "🔥🚀".repeat(500) + "日本語のテキスト".repeat(100) }];
    const bytes = requestBytes(MYLO_SYSTEM, heavy);
    expect(bytes).toBeGreaterThan(MYLO_SYSTEM.length);
    const bound = callBoundMicroUsd("claude-sonnet-5", bytes, TURN_BUDGET.answerTokens);
    // the dearest the call could really be: every byte a token, all of it written to the cache, the answer in full
    expect(bound).toBeGreaterThanOrEqual(costMicroUsd("claude-sonnet-5", { input: 0, cacheWrite: bytes, output: TURN_BUDGET.answerTokens }));
  });
});

describe("the day's budget", () => {
  it("records what each call really cost, and counts a call that failed at its bound", () => {
    const h = reserveCall("claude-haiku-4-5", 10_000, 1_500)!;
    expect(budgetShare()).toBeGreaterThan(0);
    settleCall(h, { model: "claude-haiku-4-5", usage: used(3_000, 200) }, { speaker: "base" });
    expect(spentTodayMicroUsd()).toBe(4_000);
    settleCall(h, { usage: used(999_999, 0) }); // settling twice changes nothing
    expect(spentTodayMicroUsd()).toBe(4_000);
    const failed = reserveCall("claude-haiku-4-5", 10_000, 1_500)!;
    settleCall(failed, null);
    expect(spentTodayMicroUsd()).toBe(4_000 + failed.micro);
    expect(getDb().prepare("SELECT COUNT(*) n FROM mylo_usage WHERE estimated = 1").get()).toEqual({ n: 1 });
  });

  it("never refuses a call, even past the budget: it is held, made and recorded", () => {
    const oneCall = callBoundMicroUsd("claude-sonnet-5", 20_000, 1_500);
    process.env.MYLO_DAILY_BUDGET_USD = String((oneCall * 1.5) / 1e6);
    const holds = [reserveCall("claude-sonnet-5", 20_000, 1_500), reserveCall("claude-sonnet-5", 20_000, 1_500), reserveCall("claude-sonnet-5", 20_000, 1_500)];
    expect(holds.every((h) => h && h.micro === oneCall)).toBe(true);
    expect(budgetShare()).toBe(1);
    for (const h of holds) settleCall(h, { usage: used(1_000, 100) });
    expect(spendByDay(1)[0]).toMatchObject({ calls: 3 });
  });

  it("gives $AXON holders the better model until most of the budget is gone, everyone else the cheaper one", () => {
    const m = myloModels({});
    expect(modelFor("holder", 0, {})).toBe(m.chat);
    expect(modelFor("operator", CHEAP_FROM_SHARE - 0.01, {})).toBe(m.chat);
    expect(modelFor("operator", CHEAP_FROM_SHARE, {})).toBe(m.base);
    expect(modelFor("base", 0, {})).toBe(m.base);
    expect(m.base).toBe("claude-haiku-4-5");
  });
});

describe("a turn under the budget", () => {
  it("answers with the speaker's model and records every call", async () => {
    const me = wallet(), models: string[] = [];
    await run({ owner: me, wallet: me, speaker: "holder", text: "hi" }, async (a, onText) => { models.push(a.model); onText("Hello."); return { blocks: [{ type: "text", text: "Hello." }], stop: "end_turn", model: a.model, usage: used(2_600, 40) }; });
    await run({ owner: me, wallet: me, speaker: "base", text: "hi" }, async (a, onText) => { models.push(a.model); onText("Hello."); return { blocks: [{ type: "text", text: "Hello." }], stop: "end_turn", model: a.model, usage: used(2_600, 40) }; });
    expect(models).toEqual([myloModels().chat, myloModels().base]);
    expect(getDb().prepare("SELECT model, speaker, input_tokens i, cost_micro_usd c FROM mylo_usage ORDER BY id").all()).toEqual([
      { model: myloModels().chat, speaker: "holder", i: 2_600, c: costMicroUsd(myloModels().chat, used(2_600, 40)) },
      { model: myloModels().base, speaker: "base", i: 2_600, c: costMicroUsd(myloModels().base, used(2_600, 40)) },
    ]);
  });

  it("keeps answering past the day's budget, on the cheaper model, even for an $AXON holder", async () => {
    process.env.MYLO_DAILY_BUDGET_USD = "0.01";
    settleCall(reserveCall("claude-sonnet-5", 1_000, 100), { usage: used(10_000, 1_000) }); // 4.5 cents: past the budget
    expect(budgetShare()).toBe(1);
    const me = wallet(), models: string[] = [];
    const ev = await run({ owner: me, wallet: me, speaker: "operator", text: "hello" }, async (a, onText) => { models.push(a.model); onText("Hi."); return { blocks: [{ type: "text", text: "Hi." }], stop: "end_turn", model: a.model, usage: used(2_600, 10) }; });
    expect(ev.at(-1)).toMatchObject({ type: "done" });
    expect(models).toEqual([myloModels().base]);
    expect(spentTodayMicroUsd()).toBeGreaterThan(dailyBudgetUsd() * 1e6);
  });

  it("rereads only as much history as the cap allows, each message cut, starting with a question", () => {
    const long = "x".repeat(TURN_BUDGET.historyMessageChars + 500);
    const turns = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? "assistant" : "user") as "user" | "assistant", content: long }));
    const fit = fitHistory(turns);
    expect(fit[0].role).toBe("user");
    expect(fit.every((t) => t.content.length <= TURN_BUDGET.historyMessageChars + 6)).toBe(true);
    expect(fit.reduce((s, t) => s + t.content.length, 0)).toBeLessThanOrEqual(TURN_BUDGET.historyChars + TURN_BUDGET.historyMessageChars);
    expect(fitHistory([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });
});

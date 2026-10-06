// Mylo meets the minds, phase 5: a whole launch set up in conversation. Mylo carries the settings the creator chose to
// the launch screen in its link; each is checked by the screen's own rules, and a link is never trusted.
import { describe, it, expect, vi, beforeEach } from "vitest";

const world = vi.hoisted(() => ({ balanceWei: 10n ** 18n, fails: false }));
vi.mock("@/lib/evm", async (orig) => ({
  ...(await orig<typeof import("@/lib/evm")>()),
  publicClient: () => ({ getBalance: async () => { if (world.fails) throw new Error("no chain"); return world.balanceWei; } }),
}));

import { runTool, myloToolDefs, type Card } from "@/lib/myloTools";
import { DEFAULT_SETTINGS, checkSettings, hasLinkedSettings, readSettingsQuery, settingsQuery, type LinkedSettings } from "@/lib/mindsLaunch";
import { startConversation } from "@/lib/myloStore";

let n = 0;
const wallet = () => `0x${(++n + 4_400_000).toString(16).padStart(40, "0")}`;
const ctx = (w: string) => ({ wallet: w, owner: w, conversationId: startConversation(w, "t").id });
const LINE = "Reads a company's filings and explains what changed";
const read = (q: Record<string, string>) => readSettingsQuery((k) => q[k]);
type LaunchCard = Extract<Card, { kind: "launch" }>;
const pageOf = (card: unknown) => Object.fromEntries(new URL((card as LaunchCard).page, "https://x").searchParams);

beforeEach(() => { vi.stubEnv("AGENT_MINDS", "on"); vi.stubEnv("OPENROUTER_API_KEY", "test-key"); vi.stubEnv("ANTHROPIC_API_KEY", "test-key"); world.balanceWei = 10n ** 18n; world.fails = false; });

describe("launch settings carried in a link", () => {
  it("come back out exactly as they went in", () => {
    const linked: LinkedSettings = {
      settings: { taxBps: 300, burnBps: 2000, axonBps: 1000, mindBps: 4000, canBuyback: true, canReward: true, canBurnAxon: false, maxPerDayEth: "0.02", maxPerActionEth: "0.005", maxActionsPerDay: 6, maxCostPerDayEth: "0.004", openingBuyEth: "0.02", twitter: "https://x.com/ledgerlens", website: "https://ledgerlens.example" },
      payout: "0x00000000000000000000000000000000000000a1", model: "x-ai/grok-4.7",
    };
    const q = Object.fromEntries(settingsQuery(linked));
    expect(q).toMatchObject({ tax: "300", burn: "2000", axon: "1000", tomind: "4000", buyback: "1", burnaxon: "0", actions: "6", buy: "0.02", ai: "x-ai/grok-4.7" });
    expect(read(q)).toEqual(linked);
    // and what they make together is something the screen would accept
    expect(checkSettings({ ...DEFAULT_SETTINGS, ...read(q).settings, payout: linked.payout! })).toBeNull();
  });

  it("uses no key the launch page already reads for something else", () => {
    const all: LinkedSettings = { settings: { ...DEFAULT_SETTINGS, openingBuyEth: "0.01", twitter: "https://x.com/a", website: "https://a.example" }, payout: "0x00000000000000000000000000000000000000a1", model: "claude-opus-5-5" };
    const keys = settingsQuery(all).map(([k]) => k);
    for (const taken of ["mind", "new", "token", "agent", "name", "ticker", "symbol", "line"]) expect(keys).not.toContain(taken);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("carries only what was chosen, and nothing at all when nothing was", () => {
    expect(settingsQuery({ settings: {} })).toEqual([]);
    expect(hasLinkedSettings(read({}))).toBe(false);
    expect(read({ name: "Ledger Lens", line: LINE })).toEqual({ settings: {} });
    expect(read({ tax: "250" })).toEqual({ settings: { taxBps: 250 } });
    expect(hasLinkedSettings(read({ ai: "claude-opus-5-5" }))).toBe(true);
  });

  it("lands a number on the step the screen's own slider would", () => {
    expect(read({ tax: "333", burn: "2049", tomind: "2951" }).settings).toEqual({ taxBps: 350, burnBps: 2000, mindBps: 3000 });
  });

  it("leaves out anything a link should not be able to set", () => {
    // past a ceiling, not a number, or not the plain kind of value the screen takes
    expect(read({ tax: "1500", actions: "25", buyback: "yes", day: "-1", action: "1e3", think: "0.01.5", buy: "<script>", x: "http://x.com/a", web: "javascript:alert(1)" })).toEqual({ settings: {} });
    expect(read({ buy: "0.0200000000000000001" })).toEqual({ settings: {} });
    expect(read({ web: `https://a.example/${"a".repeat(300)}` })).toEqual({ settings: {} });
    expect(read({ x: 'https://x.com/a"onmouseover="x' })).toEqual({ settings: {} });
    // shares that would leave the creator less than nothing are dropped together
    expect(read({ burn: "6000", axon: "3000", tomind: "2000", tax: "100" })).toEqual({ settings: { taxBps: 100 } });
    // a payout wallet has to be a real address, and never the zero address; a mind has to be one of the listed AIs
    expect(read({ payout: "0x123", ai: "gpt-99" })).toEqual({ settings: {} });
    expect(read({ payout: `0x${"0".repeat(40)}`, ai: "own" })).toEqual({ settings: {} });
  });
});

describe("Mylo setting a launch up in conversation", () => {
  it("offers the settings to the model, each one optional", () => {
    const def = myloToolDefs().find((t) => t.name === "launch_token")! as unknown as { description: string; input_schema: { properties: Record<string, unknown>; required: string[] } };
    expect(Object.keys(def.input_schema.properties)).toEqual(expect.arrayContaining(["tax_percent", "burn_percent", "burn_axon_percent", "mind_percent", "mind_model", "mind_may_buy_back", "mind_actions_per_day", "first_buy_eth", "payout_wallet"]));
    expect(def.input_schema.required).toEqual([]);
    expect(def.description).toMatch(/Only pass a setting they actually chose/);
  });

  it("opens the screen complete, and shows exactly what will be locked", async () => {
    const me = wallet();
    const out = await runTool("launch_token", {
      name: "Ledger Lens", ticker: "$lens", what_the_agent_does: LINE,
      tax_percent: 3, burn_percent: 20, burn_axon_percent: 10, mind_percent: 40, mind_model: "Grok 4.7",
      mind_may_buy_back: true, mind_may_reward_holders: true, mind_may_burn_axon: false,
      mind_spend_per_day_eth: 0.02, mind_spend_per_action_eth: 0.005, mind_actions_per_day: 6, mind_thinking_per_day_eth: 0.004, first_buy_eth: 0.02,
    }, ctx(me));
    expect(out.result).toMatchObject({
      can_launch: true, creator_share: "30%", first_buy_eth: "0.02", warnings: [],
      will_be_locked: {
        "Tax on every trade": "3%", "Burns $LENS": "20%", "Burns $AXON": "10%", "To the mind": "40%", "To Axon": "0%",
        "The mind may": "buy back and burn $LENS, reward holders", "Its limits": "0.02 ETH a day, 0.005 ETH an action, 6 actions a day",
        "Its thinking": "at most 0.004 ETH a day, paid from its own treasury", "Its mind runs on": "Grok 4.7",
      },
    });
    expect(pageOf(out.card)).toEqual({
      name: "Ledger Lens", ticker: "LENS", line: LINE, tax: "300", burn: "2000", axon: "1000", tomind: "4000", buyback: "1", reward: "1", burnaxon: "0",
      day: "0.02", action: "0.005", actions: "6", think: "0.004", buy: "0.02", ai: "x-ai/grok-4.7",
    });
    const card = out.card as LaunchCard;
    expect(card.firstBuyEth).toBe("0.02");
    expect(card.locked!.find((r) => r.label === "To the mind")).toEqual({ label: "To the mind", value: "40%" });
    // what the link carries is what the screen reads back, value for value
    expect(readSettingsQuery((k) => pageOf(card)[k])).toEqual({ settings: { taxBps: 300, burnBps: 2000, axonBps: 1000, mindBps: 4000, canBuyback: true, canReward: true, canBurnAxon: false, maxPerDayEth: "0.02", maxPerActionEth: "0.005", maxActionsPerDay: 6, maxCostPerDayEth: "0.004", openingBuyEth: "0.02" }, model: "x-ai/grok-4.7" });
  });

  it("carries only what they chose: with nothing chosen it is the link it always was", async () => {
    const out = await runTool("launch_token", { name: "Ledger Lens", ticker: "LENS", what_the_agent_does: LINE }, ctx(wallet()));
    expect(pageOf(out.card)).toEqual({ name: "Ledger Lens", ticker: "LENS", line: LINE });
    expect((out.card as LaunchCard).locked).toBeUndefined();
    expect((out.result as { will_be_locked: unknown }).will_be_locked).toMatch(/screen opens on its defaults/);

    const one = await runTool("launch_token", { name: "Ledger Lens", ticker: "LENS", what_the_agent_does: LINE, tax_percent: 2.5 }, ctx(wallet()));
    expect(pageOf(one.card)).toEqual({ name: "Ledger Lens", ticker: "LENS", line: LINE, tax: "250" });
    expect((one.result as { will_be_locked: Record<string, string> }).will_be_locked).toMatchObject({ "Tax on every trade": "2.5%", "To the mind": "0%" });
    expect((one.result as { creator_share: string }).creator_share).toBe("100%");
  });

  it("prepares nothing when a setting breaks the screen's own rules, and says which", async () => {
    const base = { name: "Ledger Lens", ticker: "LENS", what_the_agent_does: LINE };
    const why = async (extra: Record<string, unknown>) => { const out = await runTool("launch_token", { ...base, ...extra }, ctx(wallet())); expect(out.card).toBeUndefined(); expect(out.result).toMatchObject({ can_launch: false }); return (out.result as { why_not: string }).why_not; };
    expect(await why({ tax_percent: 15 })).toBe("The tax is between 0 and 10%.");
    expect(await why({ burn_percent: 60, burn_axon_percent: 30, mind_percent: 20 })).toBe("The shares have to add up to 100%.");
    expect(await why({ mind_spend_per_day_eth: 0.01, mind_spend_per_action_eth: 0.02 })).toBe("One action cannot be more than the whole day's limit.");
    expect(await why({ mind_actions_per_day: 30 })).toBe("A mind acts at most 24 times a day.");
    expect(await why({ mind_thinking_per_day_eth: 0.02 })).toBe("Thinking costs at most 0.01 ETH a day.");
    expect(await why({ payout_wallet: "my other wallet" })).toBe("The payout wallet is not a wallet address.");
    expect(await why({ website: "ledgerlens.example" })).toBe("Links start with https://");
    expect(await why({ tax_percent: "a lot" })).toMatch(/tax percent is a number of percent/);
    expect(await why({ first_buy_eth: -1 })).toMatch(/first buy eth is an amount of ETH/);
    expect(await why({ mind_model: "HAL 9000" })).toMatch(/There is no mind called "HAL 9000"\. The choices are Claude Opus 5\.5,/);
    expect(await why({ mind_model: "their own server" })).toMatch(/set up on the launch screen itself/);
  });

  it("knows the minds by name, and will not pick one that is not open", async () => {
    const base = { name: "Ledger Lens", ticker: "LENS", what_the_agent_does: LINE };
    for (const [said, id] of [["Claude Opus 5.5", "claude-opus-5-5"], ["deepseek", "deepseek/deepseek-v4.1-flash"], ["gemini 3.8 flash", "google/gemini-3.8-flash"], ["openai/gpt-6.1-sol", "openai/gpt-6.1-sol"]] as const) {
      expect(pageOf((await runTool("launch_token", { ...base, mind_model: said }, ctx(wallet()))).card).ai).toBe(id);
    }
    vi.stubEnv("OPENROUTER_API_KEY", "");
    const out = await runTool("launch_token", { ...base, mind_model: "Grok 4.7" }, ctx(wallet()));
    expect(out.result).toMatchObject({ can_launch: false, why_not: "Grok 4.7 is not open as a mind right now. The others are." });
  });

  it("warns about a first buy the wallet cannot cover, and about a mind with no treasury", async () => {
    const base = { name: "Ledger Lens", ticker: "LENS", what_the_agent_does: LINE };
    world.balanceWei = 34n * 10n ** 15n; // 0.034 ETH
    const big = await runTool("launch_token", { ...base, first_buy_eth: 0.05 }, ctx(wallet()));
    expect(big.result).toMatchObject({ can_launch: true, first_buy_eth: "0.05" });
    expect((big.result as { warnings: string[] }).warnings).toEqual([expect.stringMatching(/holds about 0\.034 ETH, which is less than the first buy of 0\.05 ETH plus the launch fee/)]);

    const fits = await runTool("launch_token", { ...base, first_buy_eth: 0.02 }, ctx(wallet()));
    expect((fits.result as { warnings: string[] }).warnings).toEqual([]);

    // a balance that cannot be read is not a reason to warn or to stop
    world.fails = true;
    expect((await runTool("launch_token", { ...base, first_buy_eth: 0.05 }, ctx(wallet()))).result).toMatchObject({ can_launch: true, warnings: [] });

    const quiet = await runTool("launch_token", { ...base, tax_percent: 3, burn_percent: 50 }, ctx(wallet()));
    expect((quiet.result as { warnings: string[] }).warnings).toEqual([expect.stringMatching(/0% of the fees to the mind it has no treasury/)]);
  });
});

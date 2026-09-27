import { describe, it, expect } from "vitest";
import {
  INTERVAL_HOURS,
  RETAINERS_BY_TIER,
  FAILURES_BEFORE_PAUSE,
  MAX_INSTRUCTIONS,
  scheduleError,
  validTimeZone,
  hoursBetweenRuns,
  runsPerDay,
  maxDailySpendWei,
  defaultMaxPriceWei,
  retainerInputError,
  tierPaceAllows,
  retainerPriceWei,
  clampRetainerDiscount,
  type RetainerInput,
  type RetainerContext,
} from "@/lib/retainerPolicy";
import { DEFAULT_MAX_PER_TASK_WEI, DEFAULT_MAX_PER_DAY_WEI } from "@/lib/allowancePolicy";
import { toWei } from "@/lib/money";

const NOW = 1_790_000_000_000;
const MEDIAN = toWei("0.00015")!; // median paid agent price on 2026-09-27 (29 of 87 agents charge)

const input = (over: Partial<RetainerInput> = {}): RetainerInput => ({
  agentId: "crypto-agent",
  instructions: "Summarise overnight moves in my watchlist.",
  schedule: { kind: "daily", time: "08:00", timeZone: "Europe/Oslo" },
  payIn: "ETH",
  maxPriceWei: defaultMaxPriceWei(MEDIAN),
  ...over,
});

const ctx = (over: Partial<RetainerContext> = {}): RetainerContext => ({
  agentPriceWei: MEDIAN,
  agentAcceptsAxon: true,
  tier: "base",
  activeRetainers: 0,
  nowMs: NOW,
  ...over,
});

describe("schedules", () => {
  it("accepts the offered intervals and nothing else", () => {
    for (const h of INTERVAL_HOURS) expect(scheduleError({ kind: "interval", everyHours: h })).toBeNull();
    for (const h of [0, 0.5, 5, 24, 48, -1]) expect(scheduleError({ kind: "interval", everyHours: h })).not.toBeNull();
  });

  it("daily and weekly need a real time and a real time zone", () => {
    expect(scheduleError({ kind: "daily", time: "08:00", timeZone: "America/New_York" })).toBeNull();
    expect(scheduleError({ kind: "daily", time: "8:00", timeZone: "UTC" })).toMatch(/08:00/);
    expect(scheduleError({ kind: "daily", time: "24:00", timeZone: "UTC" })).not.toBeNull();
    expect(scheduleError({ kind: "daily", time: "08:00", timeZone: "Mars/Olympus" })).toMatch(/time zone/);
    expect(scheduleError({ kind: "weekly", day: 1, time: "09:30", timeZone: "UTC" })).toBeNull();
    expect(scheduleError({ kind: "weekly", day: 7, time: "09:30", timeZone: "UTC" })).toMatch(/day/);
    expect(scheduleError({ kind: "monthly" })).not.toBeNull();
    expect(scheduleError(null)).not.toBeNull();
  });

  it("knows real time zones", () => {
    expect(validTimeZone("Europe/Oslo")).toBe(true);
    expect(validTimeZone("UTC")).toBe(true);
    expect(validTimeZone("Not/AZone")).toBe(false);
    expect(validTimeZone("")).toBe(false);
  });

  it("measures how often each kind runs", () => {
    expect(hoursBetweenRuns({ kind: "interval", everyHours: 4 })).toBe(4);
    expect(runsPerDay({ kind: "interval", everyHours: 1 })).toBe(24);
    expect(runsPerDay({ kind: "daily", time: "08:00", timeZone: "UTC" })).toBe(1);
    expect(runsPerDay({ kind: "weekly", day: 0, time: "08:00", timeZone: "UTC" })).toBeCloseTo(1 / 7);
  });
});

describe("spend", () => {
  it("an hourly retainer at the median price fits the default daily allowance; at the top price it does not", () => {
    const hourly = { kind: "interval", everyHours: 1 } as const;
    expect(maxDailySpendWei(hourly, MEDIAN)).toBeLessThanOrEqual(DEFAULT_MAX_PER_DAY_WEI);
    expect(maxDailySpendWei(hourly, DEFAULT_MAX_PER_TASK_WEI)).toBeGreaterThan(DEFAULT_MAX_PER_DAY_WEI);
  });

  it("a weekly schedule still counts as a whole run on the day it lands", () => {
    expect(maxDailySpendWei({ kind: "weekly", day: 1, time: "08:00", timeZone: "UTC" }, MEDIAN)).toBe(MEDIAN);
  });

  it("the default price ceiling leaves a quarter of room, never passes the allowance default, never undercuts the price", () => {
    expect(defaultMaxPriceWei(MEDIAN)).toBe((MEDIAN * 125n + 99n) / 100n);
    expect(defaultMaxPriceWei(DEFAULT_MAX_PER_TASK_WEI)).toBe(DEFAULT_MAX_PER_TASK_WEI);
    const pricey = DEFAULT_MAX_PER_TASK_WEI * 2n;
    expect(defaultMaxPriceWei(pricey)).toBe(pricey);
  });
});

describe("tiers", () => {
  it("only ever add, and the base tier still gets retainers", () => {
    const order = ["base", "holder", "builder", "operator"] as const;
    for (let i = 1; i < order.length; i++) {
      expect(RETAINERS_BY_TIER[order[i]].active).toBeGreaterThan(RETAINERS_BY_TIER[order[i - 1]].active);
      expect(RETAINERS_BY_TIER[order[i]].fastestHours).toBeLessThanOrEqual(RETAINERS_BY_TIER[order[i - 1]].fastestHours);
    }
    expect(RETAINERS_BY_TIER.base.active).toBeGreaterThan(0);
  });

  it("hourly needs a holder tier; every four hours does not", () => {
    const hourly = input({ schedule: { kind: "interval", everyHours: 1 } });
    expect(retainerInputError(hourly, ctx())).toMatch(/holding \$AXON allows hourly/);
    expect(retainerInputError(hourly, ctx({ tier: "holder" }))).toBeNull();
    expect(retainerInputError(input({ schedule: { kind: "interval", everyHours: 4 } }), ctx())).toBeNull();
  });

  it("after a sell, a faster schedule runs at the tier's pace, with the on-time window as slack", () => {
    const hourly = { kind: "interval", everyHours: 1 } as const;
    const H = 3_600_000;
    expect(tierPaceAllows(hourly, "holder", 0, H)).toBe(true);
    expect(tierPaceAllows(hourly, "base", null, H)).toBe(true);
    expect(tierPaceAllows(hourly, "base", 0, 3 * H)).toBe(false);
    expect(tierPaceAllows(hourly, "base", 10 * 60_000, 4 * H)).toBe(true);
    expect(tierPaceAllows({ kind: "daily", time: "08:00", timeZone: "UTC" }, "base", 0, 1)).toBe(true);
  });

  it("caps active retainers by tier", () => {
    expect(retainerInputError(input(), ctx({ activeRetainers: RETAINERS_BY_TIER.base.active }))).toMatch(/3 retainers/);
    expect(retainerInputError(input(), ctx({ tier: "holder", activeRetainers: 3 }))).toBeNull();
  });
});

describe("creating a retainer", () => {
  it("accepts a sensible daily retainer", () => {
    expect(retainerInputError(input(), ctx())).toBeNull();
  });

  it("is for paid agents only", () => {
    expect(retainerInputError(input(), ctx({ agentPriceWei: null }))).toMatch(/paid agents/);
    expect(retainerInputError(input(), ctx({ agentPriceWei: 0n }))).toMatch(/paid agents/);
  });

  it("needs instructions within the task limit", () => {
    expect(retainerInputError(input({ instructions: "   " }), ctx())).toMatch(/Write what/);
    expect(retainerInputError(input({ instructions: "x".repeat(MAX_INSTRUCTIONS + 1) }), ctx())).toMatch(/characters/);
  });

  it("pays in $AXON only where the agent takes it", () => {
    expect(retainerInputError(input({ payIn: "AXON" }), ctx())).toBeNull();
    expect(retainerInputError(input({ payIn: "AXON" }), ctx({ agentAcceptsAxon: false }))).toMatch(/does not take/);
  });

  it("will not set a ceiling below today's price or above 1 ETH", () => {
    expect(retainerInputError(input({ maxPriceWei: MEDIAN - 1n }), ctx())).toMatch(/below/);
    expect(retainerInputError(input({ maxPriceWei: 10n ** 18n + 1n }), ctx())).toMatch(/1 ETH/);
  });

  it("ends in the future and within a year", () => {
    expect(retainerInputError(input({ endsAt: NOW - 1 }), ctx())).toMatch(/future/);
    expect(retainerInputError(input({ endsAt: NOW + 366 * 86_400_000 }), ctx())).toMatch(/365 days/);
    expect(retainerInputError(input({ endsAt: NOW + 30 * 86_400_000 }), ctx())).toBeNull();
  });

  it("limits the number of runs", () => {
    expect(retainerInputError(input({ maxRuns: 0 }), ctx())).not.toBeNull();
    expect(retainerInputError(input({ maxRuns: 1.5 }), ctx())).not.toBeNull();
    expect(retainerInputError(input({ maxRuns: 30 }), ctx())).toBeNull();
  });

  it("pauses after a few failures in a row, not one", () => {
    expect(FAILURES_BEFORE_PAUSE).toBeGreaterThan(1);
  });
});

describe("the agent's retainer discount", () => {
  it("takes basis points off the price, never more than half, and nothing for a bad value", () => {
    expect(retainerPriceWei(toWei("0.00015")!, 2000)).toBe(toWei("0.00012")!);
    expect(retainerPriceWei(toWei("0.00015")!, 0)).toBe(toWei("0.00015")!);
    expect(clampRetainerDiscount(5000)).toBe(5000);
    expect(clampRetainerDiscount(50000)).toBe(0);
    expect(clampRetainerDiscount(12.5)).toBe(0);
    expect(retainerPriceWei(toWei("0.00015")!, 50000)).toBe(toWei("0.00015")!);
  });
});

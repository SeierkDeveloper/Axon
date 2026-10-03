import { describe, it, expect } from "vitest";
import {
  studioEnabled,
  buildsAllowed,
  BUILDS_PER_DAY,
  MAX_RUNNING_PER_WALLET,
  BUILD_BUDGET,
  studioModels,
  clampPrice,
  PRICE_ETH,
  withdrawAllowed,
  WITHDRAW,
  STUDIO_TOOLS,
} from "@/lib/studioPolicy";
import { validateAgentContent, validateAgentText } from "@/lib/agentContent";

describe("agent studio policy", () => {
  it("is on by default, and STUDIO=off stops it", () => {
    expect(studioEnabled({})).toBe(true);
    expect(studioEnabled({ STUDIO: "off" })).toBe(false);
    expect(studioEnabled({ STUDIO: " OFF " })).toBe(false);
  });

  it("is free, but a wallet can only start so many builds a day, more as it holds more $AXON", () => {
    expect(buildsAllowed("base", 0, 0)).toEqual({ ok: true });
    expect(buildsAllowed("base", BUILDS_PER_DAY.base, 0).ok).toBe(false);
    expect(buildsAllowed("holder", BUILDS_PER_DAY.base, 0)).toEqual({ ok: true });
    expect(BUILDS_PER_DAY.operator).toBeGreaterThan(BUILDS_PER_DAY.builder);
  });

  it("runs only a couple of builds at once per wallet, whatever the tier", () => {
    const r = buildsAllowed("operator", 0, MAX_RUNNING_PER_WALLET);
    expect(r.ok).toBe(false);
  });

  it("caps every build's model calls, and the cap covers every round", () => {
    const perRound = 1 + BUILD_BUDGET.testTasks * 2;
    expect(BUILD_BUDGET.maxCalls).toBeGreaterThanOrEqual(BUILD_BUDGET.maxRounds * perRound);
    expect(BUILD_BUDGET.maxCalls).toBeLessThanOrEqual(50);
  });

  it("uses a strong writer and a cheap grader, both swappable without a deploy", () => {
    expect(studioModels({})).toEqual({ writer: "claude-sonnet-5", grader: "claude-haiku-4-5" });
    expect(studioModels({ STUDIO_GRADER_MODEL: "claude-sonnet-5" }).grader).toBe("claude-sonnet-5");
  });

  it("never hands out spending tools on its own", () => {
    expect(STUDIO_TOOLS).not.toContain("commerce" as never);
  });

  it("keeps a suggested price inside sane bounds; the creator sets the real one", () => {
    expect(clampPrice(0.002)).toBe(0.002);
    expect(clampPrice(50)).toBe(PRICE_ETH.max);
    expect(clampPrice(0)).toBe(PRICE_ETH.fallback);
    expect(clampPrice(Number.NaN)).toBe(PRICE_ETH.fallback);
  });

  it("lets a creator take out what their agent earned, above a floor and under a daily ceiling", () => {
    expect(withdrawAllowed(0.5, "ETH", 1, 0)).toEqual({ ok: true });
    expect(withdrawAllowed(2, "ETH", 1, 0).ok).toBe(false); // more than earned
    expect(withdrawAllowed(WITHDRAW.minEth / 2, "ETH", 1, 0).ok).toBe(false); // dust
    expect(withdrawAllowed(1, "ETH", 5, WITHDRAW.maxPerDayEth - 0.5).ok).toBe(false); // over the day's ceiling
    expect(withdrawAllowed(5_000, "AXON", 10_000, 0)).toEqual({ ok: true });
    expect(withdrawAllowed(0, "ETH", 1, 0).ok).toBe(false);
  });
});

describe("agent content, shared by registration and Studio", () => {
  it("keeps the registration checks as they were", () => {
    expect(validateAgentContent("Legal Document Reviewer", "legal-reviewer", ["legal"])).toBeNull();
    expect(validateAgentContent("Axon Helper", "axon-helper", [])).toMatch(/impersonate/);
    expect(validateAgentContent("xkcdqwrt", "x", [])).toMatch(/gibberish/);
  });

  it("checks the longer texts Studio writes", () => {
    expect(validateAgentText("Summarises any earnings call into five bullets.")).toBeNull();
    expect(validateAgentText("I am Axon, the official assistant.")).toMatch(/Axon or Anthropic/);
    expect(validateAgentText("this is shit")).toMatch(/inappropriate/);
  });
});
